import Foundation
import Observation
import TrackerCore
import TrackerStore
import UIKit

/// The UI's view of the replica: a snapshot re-read whenever the engine reports a change, plus
/// the actions the screens take. The engine and store hold the truth.
@MainActor
@Observable
final class AppModel {
    let engine: SyncEngine
    let api: APIClient

    private(set) var entries: [Entry] = []
    private(set) var definitionsByKey: [String: Definition] = [:]
    private(set) var state = ReplicaState()
    private(set) var status: SyncStatus = .unconfigured
    private(set) var lastError: String?
    /// Refreshed on a timer and on foreground, so "today" rolls over at midnight.
    private(set) var nowMs = systemNowMs()
    /// The set just logged, offered for undo until the next one.
    private(set) var justLogged: Entry?

    init(engine: SyncEngine, api: APIClient) {
        self.engine = engine
        self.api = api
    }

    /// The app's model over the shared database, with the server from Info.plist.
    static func live() throws -> AppModel {
        let info = Bundle.main.infoDictionary ?? [:]
        guard let baseURLString = info["APIBaseURL"] as? String, let baseURL = URL(string: baseURLString) else {
            fatalError("Info.plist has no valid APIBaseURL")
        }
        let store = try (info["AppGroup"] as? String).map { try SQLiteReplicaStore(appGroup: $0) } ?? SQLiteReplicaStore(path: Self.fallbackDatabasePath())
        let api = APIClient(baseURL: baseURL)
        return AppModel(engine: try SyncEngine(store: store, transport: api), api: api)
    }

    private static func fallbackDatabasePath() throws -> String {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return directory.appendingPathComponent("replica.sqlite").path
    }

    /// Re-reads after every engine change; runs for the app's lifetime.
    func watchChanges() async {
        await refresh()
        for await _ in engine.changes {
            await refresh()
        }
    }

    func refresh() async {
        do {
            entries = try engine.entries()
            definitionsByKey = Dictionary(uniqueKeysWithValues: try engine.definitions().map { ($0.key, $0) })
            state = try engine.state()
        } catch {
            lastError = "Couldn't read this device's data: \(error.localizedDescription)"
        }
        status = await engine.status
        lastError = await engine.lastError ?? lastError
        nowMs = systemNowMs()
    }

    func tick() {
        nowMs = systemNowMs()
    }

    // MARK: - Derived

    /// The zone days are kept in: a pending edit's, the account's, or this device's before it joins one.
    var timeZone: String {
        if let pendingZone = state.pendingProfile.timeZone { return pendingZone }
        if let account = state.account { return account.timeZone ?? DayCalendar.defaultTimeZoneIdentifier }
        return engine.deviceTimeZone
    }

    var calendar: DayCalendar { DayCalendar(accountZone: timeZone) }
    var today: String { calendar.dayKey(at: nowMs) }
    var goalReps: Int { state.pendingProfile.dailyGoalReps ?? state.account?.dailyGoalReps ?? state.settings.goalReps }
    var accountName: String? { state.pendingProfile.name ?? state.account?.name }
    var isSignedIn: Bool { !state.token.isEmpty }
    var pendingCount: Int { (try? engine.pendingCount()) ?? 0 }

    func exercise(_ exerciseId: String) -> ExerciseInfo? {
        if let builtIn = Catalog.exercise(exerciseId) { return ExerciseInfo(name: builtIn.name, measure: builtIn.measure, unit: builtIn.unit) }
        guard case .exercise(let created)? = definitionsByKey[exerciseId] else { return nil }
        return ExerciseInfo(name: created.name, measure: created.measure, unit: created.unit, description: created.description)
    }

    func exerciseName(_ exerciseId: String) -> String {
        exercise(exerciseId)?.name ?? "Unknown exercise"
    }

    func unit(of exerciseId: String) -> String? {
        exercise(exerciseId)?.unit
    }

    func variationName(exerciseId: String, variationId: String) -> String {
        Catalog.variation(variationId)?.name ?? definitionsByKey["\(exerciseId)/\(variationId)"]?.name ?? "Unknown"
    }

    /// Every exercise this device can log to: the built-ins, then created ones by name.
    var allExercises: [KnownExercise] {
        let builtIns = Catalog.exercises.map { KnownExercise(id: $0.id, name: $0.name, measure: $0.measure, unit: $0.unit) }
        let created = definitionsByKey.values.compactMap { definition -> KnownExercise? in
            guard case .exercise(let exercise) = definition else { return nil }
            return KnownExercise(id: exercise.id, name: exercise.name, measure: exercise.measure, unit: exercise.unit)
        }
        return builtIns + created.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// The variations offered for an exercise: a built-in's own groups, plus any created for it.
    func variations(of exerciseId: String) -> [NamedRef] {
        let groups = Catalog.exercise(exerciseId)?.variationGroups
        let builtIns = Catalog.variations.filter { groups?.contains($0.group) ?? true }.map { NamedRef(id: $0.id, name: $0.name) }
        let created = definitionsByKey.values.compactMap { definition -> NamedRef? in
            guard case .variation(let variation) = definition, variation.exerciseId == exerciseId else { return nil }
            return NamedRef(id: variation.id, name: variation.name)
        }
        return created.sorted { $0.name < $1.name } + builtIns
    }

    var stats: Stats {
        computeStats(entries, nowMs: nowMs, goalReps: goalReps, calendar: calendar) { [definitionsByKey] exerciseId in
            if let builtIn = Catalog.exercise(exerciseId) { return builtIn.unit }
            guard case .exercise(let created)? = definitionsByKey[exerciseId] else { return nil }
            return created.unit
        }
    }

    var todaysSets: [Entry] {
        let calendar = calendar
        let today = today
        return entries.filter { !$0.isDeleted && calendar.dayKey(at: $0.doneAt) == today }.sorted { $0.doneAt > $1.doneAt }
    }

    func formattedAmount(_ entry: Entry) -> String {
        entry.formattedAmount { [self] in unit(of: $0) }
    }

    /// "6", "6 @ +25 lb", "45s Front lever".
    func describe(_ entry: Entry) -> String {
        var description = formattedAmount(entry)
        if let addedWeightLbs = entry.addedWeightLbs { description += " @ \(formatAddedWeight(addedWeightLbs))" }
        if entry.resolvedExerciseId != Catalog.pullUp { description += " \(exerciseName(entry.resolvedExerciseId))" }
        return description
    }

    var padContext: SetContext {
        state.settings.padContext ?? lastSet(entries)?.context ?? SetContext(exerciseId: Catalog.pullUp)
    }

    func padAddedWeightLbs(exerciseId: String) -> Double {
        state.settings.padAddedWeightDay == today ? state.settings.padAddedWeightsLbs[exerciseId] ?? 0 : 0
    }

    // MARK: - Actions

    func run(_ action: @escaping (SyncEngine) async throws -> Void) {
        Task {
            do {
                try await action(engine)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func log(_ template: SetTemplate) {
        Task {
            do {
                justLogged = try await engine.log(template)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func undoLastLog() {
        guard let entry = justLogged else { return }
        justLogged = nil
        run { try await $0.remove(id: entry.id) }
    }

    func dismissUndo() {
        justLogged = nil
    }

    func setPadContext(_ context: SetContext) {
        run { try await $0.setPadContext(context) }
    }

    func setPadAddedWeight(_ addedWeightLbs: Double, exerciseId: String) {
        let today = today
        run { try await $0.setPadAddedWeight(addedWeightLbs, day: today, exerciseId: exerciseId) }
    }

    func signIn(with session: SessionResponse) async throws {
        try await engine.signIn(token: session.token, account: session.account)
        await engine.syncNow()
    }

    func syncNow() {
        Task { await engine.syncNow() }
    }

    /// Sends anything unsent before iOS suspends the app, then lets go of the database.
    func enterBackground() {
        let application = UIApplication.shared
        var backgroundTask = UIBackgroundTaskIdentifier.invalid
        backgroundTask = application.beginBackgroundTask(withName: "sync") {
            SQLiteReplicaStore.suspendForBackground()
            application.endBackgroundTask(backgroundTask)
        }
        Task {
            await engine.syncNow()
            SQLiteReplicaStore.suspendForBackground()
            application.endBackgroundTask(backgroundTask)
        }
    }

    func enterForeground() {
        SQLiteReplicaStore.resumeFromBackground()
        tick()
        syncNow()
    }
}
