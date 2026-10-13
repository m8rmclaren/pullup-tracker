import Foundation
import Testing
@testable import TrackerCore

private let account = Account(id: "u1", name: "Me", timeZone: "America/Denver")

private func sortedEntries(_ engine: SyncEngine) throws -> [Entry] {
    try engine.entries().sorted { $0.id < $1.id }
}

@Suite("SyncEngine")
struct SyncEngineTests {
    @Test func logsLocallyAndPersistsBeforeAnyNetwork() async throws {
        let server = FakeServer()
        await server.setMode(.offline)
        let device = try Device(server: server)
        try await device.engine.log(reps: 6)
        #expect(try device.engine.entries().count == 1)
        #expect(try device.engine.pendingCount() == 1)

        let reopened = try SyncEngine(store: device.store, transport: server, scheduler: ManualScheduler())
        #expect(try reopened.entries().first?.reps == 6)
        #expect(try reopened.pendingCount() == 1)
        #expect(await reopened.status == .pending)
    }

    @Test func batchesRapidTapsIntoOneDebouncedSync() async throws {
        let server = FakeServer()
        let device = try Device(server: server)
        try await device.engine.log(reps: 5)
        try await device.engine.log(reps: 5)
        try await device.engine.log(reps: 4)
        #expect(device.scheduler.pending.map(\.delayMs) == [SyncEngine.debounceMs])
        await device.scheduler.pending[0].action()
        #expect(await server.requests.count == 1)
        #expect(await server.requests.first?.pushedEntries.count == 3)
        #expect(await server.requests.first?.protocolVersion == 2)
        #expect(try device.engine.pendingCount() == 0)
        #expect(await device.engine.status == .synced)
    }

    @Test func keepsAnEntryQueuedIfItWasEditedWhileItsPushWasInFlight() async throws {
        let server = FakeServer()
        let device = try Device(server: server)
        let entry = try await device.engine.log(reps: 5)
        let gates = await server.holdNextRequest()
        let sync = Task { await device.engine.syncNow() }
        await gates.arrived.wait()
        try await device.engine.update(id: entry.id, reps: 8)
        await gates.release.open()
        await sync.value

        // The edit stayed queued past the first push, so the same sync went again with it.
        #expect(await server.requests.map { $0.pushedEntries.map(\.reps) } == [[5], [8]])
        #expect(await server.entry(entry.id)?.reps == 8)
        #expect(try device.engine.pendingCount() == 0)
    }

    @Test func twoDevicesConvergeIncludingAnEditAndADeleteMadeOffline() async throws {
        let server = FakeServer()
        let deviceA = try Device(server: server)
        let deviceB = try Device(server: server)
        let setA = try await deviceA.engine.log(reps: 5)
        let setB = try await deviceB.engine.log(reps: 7)
        await deviceA.engine.syncNow()
        await deviceB.engine.syncNow()
        await deviceA.engine.syncNow()
        #expect(try deviceA.engine.entries().count == 2)

        deviceA.clock.current += 1000
        deviceB.clock.current += 2000
        try await deviceA.engine.update(id: setB.id, reps: 6)
        try await deviceB.engine.remove(id: setB.id)
        try await deviceB.engine.update(id: setA.id, reps: 4)
        await deviceA.engine.syncNow()
        await deviceB.engine.syncNow()
        await deviceA.engine.syncNow()

        #expect(try sortedEntries(deviceA.engine) == sortedEntries(deviceB.engine))
        #expect(try deviceA.engine.entry(id: setB.id)?.isDeleted == true)
        #expect(try deviceA.engine.entry(id: setA.id)?.reps == 4)
    }

    @Test func aFreshDevicePullsTheFullHistory() async throws {
        let server = FakeServer()
        let device = try Device(server: server)
        try await device.engine.log(reps: 5)
        try await device.engine.log(reps: 6, doneAt: instantMs(.string("2026-09-15T18:00:00Z")))
        await device.engine.syncNow()
        let fresh = try Device(server: server)
        await fresh.engine.syncNow()
        #expect(try fresh.engine.entries().compactMap(\.reps).sorted() == [5, 6])
    }

    @Test func sendsItsCursorAndStartsOverWhenTheTokenChanges() async throws {
        let server = FakeServer(accounts: [account, Account(id: "u2", name: "Other")])
        await server.assign(token: "another", to: "u2")
        let device = try Device(server: server)
        try await device.engine.log(reps: 5)
        await device.engine.syncNow()
        try await device.engine.log(reps: 6)
        await device.engine.syncNow()
        #expect(try device.engine.state().account == account)
        try await device.engine.signIn(token: "another", account: Account(id: "u2", name: "Other"))
        await device.engine.syncNow()
        #expect(await server.requests.map(\.sinceCursor) == [0, 1, 0])
    }

    @Test func signingInKeepsSetsLoggedBeforeJoiningAndPushesThem() async throws {
        let server = FakeServer()
        let device = try Device(server: server, token: nil)
        let entry = try await device.engine.log(reps: 6)
        await device.engine.syncNow()
        #expect(await device.engine.status == .unconfigured)
        #expect(await server.requests.isEmpty)
        try await device.engine.signIn(token: "fresh-token", account: account)
        #expect(try device.engine.state().account == account)
        #expect(device.scheduler.pending.map(\.delayMs) == [0])
        await device.engine.syncNow()
        #expect(await server.entry(entry.id)?.reps == 6)
    }

    @Test func signingInAsADifferentAccountDropsSyncedDataAndKeepsUnsynced() async throws {
        let server = FakeServer()
        let device = try Device(server: server)
        let synced = try await device.engine.log(reps: 6)
        try await device.engine.createExercise(name: "Stairs", measure: .count, unit: "lap")
        await device.engine.syncNow()
        let unsynced = try await device.engine.log(reps: 4)

        try await device.engine.signIn(token: "other-account-token", account: Account(id: "u2", name: "Other", timeZone: "Europe/London"))
        #expect(try device.engine.entries().map(\.id) == [unsynced.id])
        #expect(try device.engine.definitions().isEmpty)
        #expect(try device.engine.entry(id: synced.id) == nil)
        #expect(try device.engine.pendingCount() == 1)
    }

    @Test func signingBackIntoTheSameAccountKeepsEverything() async throws {
        let server = FakeServer()
        let device = try Device(server: server)
        let synced = try await device.engine.log(reps: 6)
        await device.engine.syncNow()
        try await device.engine.signIn(token: "new-device-token", account: account)
        #expect(try device.engine.entry(id: synced.id) == synced)
    }

    @Test func dropsAResponseThatArrivesAfterTheTokenChanged() async throws {
        let server = FakeServer(accounts: [account, Account(id: "u2", name: "Other")])
        await server.assign(token: "other", to: "u2")
        let device = try Device(server: server)
        let entry = try await device.engine.log(reps: 6)
        let gates = await server.holdNextRequest()
        let sync = Task { await device.engine.syncNow() }
        await gates.arrived.wait()
        try await device.engine.signIn(token: "other", account: Account(id: "u2", name: "Other"))
        await gates.release.open()
        await sync.value
        // The pushed set reached the old account, and stays queued; the rerun took it to the new one.
        #expect(try device.engine.state().account?.id == "u2")
        #expect(await server.entry(entry.id, userId: "u2")?.reps == 6)
    }

    @Test func anUndoBeforeTheFirstSyncReachesTheServerAsATombstone() async throws {
        let server = FakeServer()
        let device = try Device(server: server)
        let entry = try await device.engine.log(reps: 5)
        try await device.engine.remove(id: entry.id)
        await device.engine.syncNow()
        #expect(await server.entry(entry.id)?.isDeleted == true)
    }

    @Test func backsOffOnNetworkFailureAndStopsOnARejectedToken() async throws {
        let server = FakeServer()
        await server.setMode(.offline)
        let device = try Device(server: server)
        try await device.engine.log(reps: 5)
        device.scheduler.clear()
        await device.engine.syncNow()
        #expect(await device.engine.status == .offline)
        #expect(device.scheduler.pending.map(\.delayMs) == [backoffMs(consecutiveFailures: 1)])
        await device.engine.syncNow()
        #expect(device.scheduler.pending.map(\.delayMs) == [backoffMs(consecutiveFailures: 2)])
        #expect(try device.engine.pendingCount() == 1)

        await server.setMode(.rejectsToken)
        device.scheduler.clear()
        await device.engine.syncNow()
        #expect(await device.engine.status == .auth)
        #expect(device.scheduler.pending.isEmpty)
    }

    @Test func stopsSyncingForGoodWhenTheServerTurnsItsVersionAway() async throws {
        let server = FakeServer()
        let device = try Device(server: server)
        try await device.engine.log(reps: 5)
        await device.engine.syncNow()

        await server.setMode(.outdated)
        try await device.engine.log(reps: 6)
        device.scheduler.clear()
        await device.engine.syncNow()
        #expect(await device.engine.status == .outdated)
        #expect(await device.engine.lastError?.contains("too old") == true)
        #expect(device.scheduler.pending.isEmpty)
        try await device.engine.log(reps: 7)
        await device.engine.syncNow()
        #expect(await server.requests.count == 2)
        #expect(await device.engine.status == .outdated)
        #expect(try device.engine.pendingCount() == 2)
    }

    @Test func editingASetKeepsTheFieldsTheChangeDoesNotName() async throws {
        let server = FakeServer()
        let chinUp = Entry(id: "v2a", doneAt: instantMs(.string("2026-10-08T15:00:00Z")), exerciseId: "chin-up", variationIds: ["band", "negative"], reps: 5, updatedAt: 1)
        let lever = Entry(id: "v2b", doneAt: instantMs(.string("2026-10-08T15:05:00Z")), exerciseId: "front-lever", variationIds: ["tuck"], holdSeconds: 20, updatedAt: 1)
        await server.seed([chinUp, lever])
        let device = try Device(server: server)
        await device.engine.syncNow()

        try await device.engine.update(id: chinUp.id, reps: 6, addedWeightLbs: 10)
        try await device.engine.update(id: lever.id, reps: 99, holdSeconds: 25, doneAt: lever.doneAt + 60_000)
        await device.engine.syncNow()
        let storedChinUp = try #require(await server.entry(chinUp.id))
        #expect(storedChinUp.exerciseId == "chin-up" && storedChinUp.variationIds == ["band", "negative"] && storedChinUp.reps == 6 && storedChinUp.addedWeightLbs == 10)
        let storedLever = try #require(await server.entry(lever.id))
        #expect(storedLever.exerciseId == "front-lever" && storedLever.variationIds == ["tuck"] && storedLever.holdSeconds == 25 && storedLever.doneAt == lever.doneAt + 60_000)
        #expect(storedLever.reps == nil)

        try await device.engine.remove(id: lever.id)
        try await device.engine.restore(id: lever.id)
        await device.engine.syncNow()
        #expect(await server.entry(lever.id)?.isDeleted == false)
        #expect(await server.entry(lever.id)?.holdSeconds == 25)
    }

    @Test func createsAnExerciseAndLogsToItOfflineThenSyncsAndOtherDevicesSeeIt() async throws {
        let server = FakeServer()
        await server.setMode(.offline)
        let device = try Device(server: server)
        let stairs = try await device.engine.createExercise(name: "Red Rocks stairs", measure: .count, unit: "lap", description: "Bottom to top")
        let typewriters = try await device.engine.createExercise(name: "Archer typewriters", measure: .count, unit: "rep")
        let wallSit = try await device.engine.createExercise(name: "Wall sit", measure: .time, unit: "ignored")
        let intoTuck = try await device.engine.createVariation(exerciseId: "muscle-up", name: "Into tuck")
        #expect(Catalog.isCreatedExerciseId(stairs.id))
        #expect(Catalog.isCreatedVariationId(intoTuck.id))
        #expect(wallSit.unit == nil)
        try await device.engine.log(exerciseId: stairs.id, reps: 3)
        try await device.engine.log(exerciseId: typewriters.id, reps: 10)
        try await device.engine.log(exerciseId: wallSit.id, holdSeconds: 90)
        try await device.engine.log(exerciseId: "muscle-up", variationIds: [intoTuck.id], reps: 2)
        try await device.engine.log(reps: 8)
        await device.engine.syncNow()
        #expect(try device.engine.pendingCount() == 9)

        await server.setMode(.online)
        await device.engine.syncNow()
        #expect(try device.engine.pendingCount() == 0)
        #expect(await server.definition(stairs.id)?.createdBy == "u1")
        #expect(try device.engine.definitions().allSatisfy { $0.createdBy == "u1" })

        let otherDevice = try Device(server: server)
        await otherDevice.engine.syncNow()
        #expect(try otherDevice.engine.exercise(stairs.id) == ExerciseInfo(name: "Red Rocks stairs", measure: .count, unit: "lap", description: "Bottom to top"))
        #expect(try otherDevice.engine.variationName(exerciseId: "muscle-up", variationId: intoTuck.id) == "Into tuck")
        // The ring counts the pull-ups, muscle-ups and the created rep-unit exercise; not laps, not the hold.
        let engine = otherDevice.engine
        let stats = computeStats(try engine.entries(), nowMs: otherDevice.clock.current, goalReps: 35, calendar: try engine.calendar()) { exerciseId in
            (try? engine.exercise(exerciseId))?.flatMap(\.unit)
        }
        #expect(stats.today.reps == 8 + 10 + 2)
    }

    @Test func renamesACreatedExerciseOnOneDeviceAndTheOtherPicksItUp() async throws {
        let server = FakeServer()
        let deviceA = try Device(server: server)
        let deviceB = try Device(server: server)
        let stairs = try await deviceA.engine.createExercise(name: "Stairs", measure: .count, unit: "lap")
        await deviceA.engine.syncNow()
        await deviceB.engine.syncNow()
        try await deviceA.engine.editDefinition(try #require(deviceA.engine.definitions().first), name: "Red Rocks stairs", description: "Bottom to top")
        await deviceA.engine.syncNow()
        await deviceB.engine.syncNow()
        #expect(try deviceB.engine.exercise(stairs.id)?.name == "Red Rocks stairs")
        #expect(try deviceB.engine.exercise(stairs.id)?.description == "Bottom to top")
    }

    @Test func neverLetsADeviceClockThatWentBackwardsLoseAnEdit() async throws {
        let device = try Device(server: FakeServer())
        let entry = try await device.engine.log(reps: 5)
        device.clock.current -= 60_000
        let edited = try #require(try await device.engine.update(id: entry.id, reps: 7))
        #expect(edited.updatedAt > entry.updatedAt)
    }

    @Test func logsEditsAndClearsAddedWeight() async throws {
        let server = FakeServer()
        let device = try Device(server: server)
        let entry = try await device.engine.log(reps: 5, addedWeightLbs: 25)
        #expect(entry.addedWeightLbs == 25)
        #expect(try await device.engine.update(id: entry.id, reps: 4)?.addedWeightLbs == 25)
        await device.engine.syncNow()
        let fresh = try Device(server: server)
        await fresh.engine.syncNow()
        #expect(try fresh.engine.entry(id: entry.id)?.addedWeightLbs == 25)
        #expect(try await device.engine.update(id: entry.id, addedWeightLbs: 0)?.addedWeightLbs == nil)
        #expect(try await device.engine.log(reps: 5).addedWeightLbs == nil)
    }

    @Test func thePadWeightIsPerExerciseAndExpiresAtTheEndOfItsDay() async throws {
        let device = try Device(server: FakeServer())
        try await device.engine.setPadAddedWeight(45, day: "2026-10-08")
        try await device.engine.setPadAddedWeight(10, day: "2026-10-08", exerciseId: "dip")
        #expect(try device.engine.padAddedWeightLbs(day: "2026-10-08") == 45)
        #expect(try device.engine.padAddedWeightLbs(day: "2026-10-08", exerciseId: "dip") == 10)
        #expect(try device.engine.padAddedWeightLbs(day: "2026-10-08", exerciseId: "push-up") == 0)
        #expect(try device.engine.padAddedWeightLbs(day: "2026-10-09") == 0)
        try await device.engine.setPadAddedWeight(5, day: "2026-10-09", exerciseId: "dip")
        #expect(try device.engine.padAddedWeightLbs(day: "2026-10-09") == 0)
    }

    @Test func prefillsThePadFromTheLastSetUntilAContextIsChosen() async throws {
        let device = try Device(server: FakeServer())
        #expect(try device.engine.padContext() == SetContext(exerciseId: "pull-up"))
        try await device.engine.log(exerciseId: "push-up", variationIds: ["wide-grip"], reps: 10)
        #expect(try device.engine.padContext() == SetContext(exerciseId: "push-up", variationIds: ["wide-grip"]))
        try await device.engine.setPadContext(SetContext(exerciseId: "plank"))
        try await device.engine.log(exerciseId: "dip", reps: 8)
        #expect(try device.engine.padContext() == SetContext(exerciseId: "plank"))
        let copy = try await device.engine.log(SetTemplate(context: SetContext(exerciseId: "plank"), holdSeconds: 45))
        #expect(copy.exerciseId == "plank" && copy.holdSeconds == 45 && copy.variationIds == nil)
        let crowded = try await device.engine.log(variationIds: (0..<7).map { "v-\(String(repeating: Character(UnicodeScalar(97 + $0)!), count: 16))" }, reps: 3)
        #expect(crowded.variationIds?.count == 6)
    }

    @Test func backoffDoublesFromTwoSecondsAndCapsAtFiveMinutes() {
        #expect([1, 2, 3].map { backoffMs(consecutiveFailures: $0) } == [2000, 4000, 8000])
        #expect(backoffMs(consecutiveFailures: 20) == 300_000)
        #expect(backoffMs(consecutiveFailures: 200) == 300_000)
    }
}

@Suite("SyncEngine profile")
struct SyncEngineProfileTests {
    @Test func keepsTheDeviceGoalUntilTheAccountHasOne() async throws {
        let device = try Device(server: FakeServer())
        try await device.engine.signOut()
        try await device.engine.updateProfile(dailyGoalReps: 42)
        try await device.engine.signIn(token: "tok", account: account)
        await device.engine.syncNow()
        #expect(try device.engine.state().account?.dailyGoalReps == nil)
        #expect(try device.engine.goalReps() == 42)
    }

    @Test func appliesAGoalZoneAndNameAtOnceAndSendsThemBeforeTheNextSync() async throws {
        let server = FakeServer()
        let device = try Device(server: server)
        await device.engine.syncNow()
        try await device.engine.updateProfile(name: "Hay", timeZone: "Europe/London", dailyGoalReps: 50)
        #expect(try device.engine.goalReps() == 50)
        #expect(try device.engine.timeZone() == "Europe/London")
        #expect(try device.engine.accountName() == "Hay")
        #expect(await device.engine.status == .pending)
        #expect(try SyncEngine(store: device.store, transport: server).goalReps() == 50)

        await device.engine.syncNow()
        #expect(try device.engine.pendingCount() == 0)
        let stored = try #require(await server.account())
        #expect(stored.dailyGoalReps == 50 && stored.timeZone == "Europe/London" && stored.name == "Hay")
        let otherDevice = try Device(server: server)
        await otherDevice.engine.syncNow()
        #expect(try otherDevice.engine.goalReps() == 50)
        #expect(try otherDevice.engine.timeZone() == "Europe/London")
    }

    @Test func keepsAnEditQueuedOfflineAndOneMadeWhileItsPushWasInFlight() async throws {
        let server = FakeServer()
        await server.setMode(.offline)
        let device = try Device(server: server)
        try await device.engine.updateProfile(dailyGoalReps: 30)
        await device.engine.syncNow()
        #expect(await device.engine.status == .offline)
        #expect(try device.engine.goalReps() == 30)

        await server.setMode(.online)
        let gates = await server.holdNextRequest()
        let sync = Task { await device.engine.syncNow() }
        await gates.arrived.wait()
        device.clock.current += 1000
        try await device.engine.updateProfile(dailyGoalReps: 31)
        await gates.release.open()
        await sync.value
        #expect(try device.engine.goalReps() == 31)
        #expect(await server.profilePatches.compactMap(\.dailyGoalReps) == [30, 30, 31])
        #expect(await server.account()?.dailyGoalReps == 31)
        #expect(try device.engine.pendingCount() == 0)
    }

    @Test func dropsQueuedProfileEditsWhenTheDeviceSwitchesAccounts() async throws {
        let device = try Device(server: FakeServer())
        try await device.engine.updateProfile(name: "Mine")
        try await device.engine.signIn(token: "other-token", account: Account(id: "u2", name: "Theirs"))
        #expect(try device.engine.accountName() == "Theirs")
        #expect(try device.engine.pendingCount() == 0)
    }

    @Test func keepsDaysInTheAccountsZoneDenverBeforeZonesAndTheDevicesBeforeJoining() async throws {
        let device = try Device(server: FakeServer(), token: nil, deviceTimeZone: "Asia/Kolkata")
        #expect(try device.engine.timeZone() == "Asia/Kolkata")
        try await device.engine.signIn(token: "tok", account: Account(id: "u1", name: "Me", timeZone: "Europe/London"))
        #expect(try device.engine.timeZone() == "Europe/London")
        try await device.engine.signIn(token: "tok", account: Account(id: "u1", name: "Me"))
        #expect(try device.engine.timeZone() == DayCalendar.defaultTimeZoneIdentifier)
    }
}

@Suite("APIClient")
struct APIClientTests {
    struct RecordingSender: HTTPSending {
        let requests = Locked<[URLRequest]>([])
        let reply: (body: String, status: Int)

        func send(_ request: URLRequest) async throws -> (body: Data, status: Int) {
            requests.update { $0.append(request) }
            return (Data(reply.body.utf8), reply.status)
        }
    }

    @Test func signsThePayloadHashAndSendsTheToken() async throws {
        let sender = RecordingSender(reply: (#"{"entries":[],"definitions":[],"cursor":7,"account":{"id":"u1","name":"Me"}}"#, 200))
        let client = APIClient(baseURL: URL(string: "https://pullups.example.com")!, sender: sender)
        let response = try await client.sync(SyncRequest(protocolVersion: 2, pushedEntries: [Entry(id: "a", doneAt: 1000, reps: 5, updatedAt: 1)], pushedDefinitions: [], sinceCursor: 3), token: "tok")
        #expect(response.cursor == 7)
        let request = try #require(sender.requests.current.first)
        #expect(request.url?.absoluteString == "https://pullups.example.com/api/sync")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "x-pullup-token") == "tok")
        #expect(request.value(forHTTPHeaderField: "content-type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "x-amz-content-sha256") == sha256Hex(request.httpBody ?? Data()))
        let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
        #expect(body["sinceCursor"] == .number(3))
        #expect(body["pushedEntries"]?.array.first?["reps"] == .number(5))
    }

    @Test func hashesLikeSha256sum() {
        #expect(sha256Hex(Data("abc".utf8)) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(sha256Hex(Data()) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    @Test func turnsAnErrorResponseIntoHTTPErrorWithTheServersMessage() async throws {
        let client = APIClient(baseURL: URL(string: "https://pullups.example.com")!, sender: RecordingSender(reply: (#"{"error":"Update the app to keep syncing."}"#, 426)))
        await #expect(throws: HTTPError(status: 426, message: "Update the app to keep syncing.")) {
            try await client.pushProfile(ProfilePatch(), token: "tok")
        }
        let bare = APIClient(baseURL: URL(string: "https://pullups.example.com")!, sender: RecordingSender(reply: ("<html>", 502)))
        await #expect(throws: HTTPError(status: 502, message: "HTTP 502")) {
            try await bare.pushProfile(ProfilePatch(), token: "tok")
        }
    }
}
