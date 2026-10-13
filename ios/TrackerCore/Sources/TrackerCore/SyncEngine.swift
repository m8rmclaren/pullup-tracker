import Foundation

// The local replica and its sync loop, a port of the PWA's tracker.ts. Every mutation lands in
// the store at once (so the UI never waits on the network) along with its outbox row; a
// background sync then pushes the outbox and pulls whatever was written elsewhere since the last
// cursor. Pushes are idempotent merges and an outbox row is cleared only if it still holds the
// version that was sent, so a sync from another process at the same time is safe.

public enum SyncStatus: String, Sendable {
    case synced, syncing, pending, offline
    /// The token was rejected: sign in again.
    case auth
    /// The server no longer speaks this client's protocol; nothing syncs until the app updates.
    case outdated
    /// Not signed in.
    case unconfigured
}

public protocol SyncTransport: Sendable {
    func sync(_ request: SyncRequest, token: String) async throws -> SyncResponse
    func pushProfile(_ patch: ProfilePatch, token: String) async throws -> Account
}

public protocol ScheduledSync: Sendable {
    func cancel()
}

/// Runs a sync after a delay. Tests swap in one that fires when told to.
public protocol SyncScheduler: Sendable {
    func schedule(afterMs delayMs: Int64, _ action: @escaping @Sendable () async -> Void) -> any ScheduledSync
}

public struct TaskScheduler: SyncScheduler {
    public init() {}

    public func schedule(afterMs delayMs: Int64, _ action: @escaping @Sendable () async -> Void) -> any ScheduledSync {
        ScheduledTask(task: Task {
            try? await Task.sleep(nanoseconds: UInt64(max(0, delayMs)) * 1_000_000)
            if !Task.isCancelled { await action() }
        })
    }

    private struct ScheduledTask: ScheduledSync {
        let task: Task<Void, Never>
        func cancel() { task.cancel() }
    }
}

/// What the UI needs to show an exercise, built-in or created.
public struct ExerciseInfo: Hashable, Sendable {
    public var name: String
    public var measure: Measure
    public var unit: String?
    public var description: String?

    public init(name: String, measure: Measure, unit: String? = nil, description: String? = nil) {
        self.name = name
        self.measure = measure
        self.unit = unit
        self.description = description
    }
}

public func backoffMs(consecutiveFailures: Int) -> Int64 {
    min(SyncEngine.maxBackoffMs, 2000 << Int64(min(max(consecutiveFailures - 1, 0), 20)))
}

public func systemNowMs() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
}

/// 32 lowercase hex digits, as the PWA's ids are.
public func newEntryId() -> String {
    UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
}

private let base32Alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")

/// Random lowercase base32, the alphabet created ids are checked against.
func newDefinitionSuffix() -> String {
    var generator = SystemRandomNumberGenerator()
    return String((0..<16).map { _ in base32Alphabet[Int(generator.next() & 31)] })
}

public actor SyncEngine {
    /// Taps within this window are batched into one request.
    public static let debounceMs: Int64 = 1200
    public static let maxBackoffMs: Int64 = 5 * 60_000

    private let store: any ReplicaStore
    private let transport: any SyncTransport
    private let scheduler: any SyncScheduler
    private let nowMs: @Sendable () -> Int64
    private let newId: @Sendable () -> String
    /// The device's zone, used for days until the device joins an account.
    public nonisolated let deviceTimeZone: String

    public private(set) var status: SyncStatus
    public private(set) var lastError: String?
    private var consecutiveFailures = 0
    private var inFlightSync: Task<Void, Never>?
    private var isRerunQueued = false
    private var scheduledSync: (any ScheduledSync)?

    /// Yields after every change this engine makes or sees, for the UI to re-read.
    public nonisolated let changes: AsyncStream<Void>
    private let changesContinuation: AsyncStream<Void>.Continuation

    public init(
        store: any ReplicaStore,
        transport: any SyncTransport,
        scheduler: any SyncScheduler = TaskScheduler(),
        deviceTimeZone: String = TimeZone.current.identifier,
        nowMs: @escaping @Sendable () -> Int64 = systemNowMs,
        newId: @escaping @Sendable () -> String = newEntryId
    ) throws {
        self.store = store
        self.transport = transport
        self.scheduler = scheduler
        self.deviceTimeZone = deviceTimeZone
        self.nowMs = nowMs
        self.newId = newId
        (changes, changesContinuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        status = try store.read(Self.idleStatus)
    }

    // MARK: - Reads

    public nonisolated func entries() throws -> [Entry] {
        try store.read { try $0.entries() }
    }

    public nonisolated func entry(id: String) throws -> Entry? {
        try store.read { try $0.entry(id: id) }
    }

    public nonisolated func definitions() throws -> [Definition] {
        try store.read { try $0.definitions() }
    }

    public nonisolated func state() throws -> ReplicaState {
        try store.read { try $0.state() }
    }

    public nonisolated func pendingCount() throws -> Int {
        try store.read { try $0.pendingCount() }
    }

    /// The zone days are kept in: a pending edit's, the account's, or this device's before it joins one.
    public nonisolated func timeZone() throws -> String {
        let state = try state()
        if let pendingZone = state.pendingProfile.timeZone { return pendingZone }
        if let account = state.account { return account.timeZone ?? DayCalendar.defaultTimeZoneIdentifier }
        return deviceTimeZone
    }

    public nonisolated func calendar() throws -> DayCalendar {
        DayCalendar(accountZone: try timeZone())
    }

    /// The account's goal once one is set, else this device's own.
    public nonisolated func goalReps() throws -> Int {
        let state = try state()
        return state.pendingProfile.dailyGoalReps ?? state.account?.dailyGoalReps ?? state.settings.goalReps
    }

    public nonisolated func accountName() throws -> String? {
        let state = try state()
        return state.pendingProfile.name ?? state.account?.name
    }

    /// A built-in or created exercise; nil until an unknown created one arrives in a sync.
    public nonisolated func exercise(_ exerciseId: String) throws -> ExerciseInfo? {
        if let builtIn = Catalog.exercise(exerciseId) { return ExerciseInfo(name: builtIn.name, measure: builtIn.measure, unit: builtIn.unit) }
        guard case .exercise(let created)? = try store.read({ try $0.definition(key: exerciseId) }) else { return nil }
        return ExerciseInfo(name: created.name, measure: created.measure, unit: created.unit, description: created.description)
    }

    public nonisolated func variationName(exerciseId: String, variationId: String) throws -> String? {
        if let builtIn = Catalog.variation(variationId) { return builtIn.name }
        return try store.read { try $0.definition(key: "\(exerciseId)/\(variationId)") }?.name
    }

    /// The pad's added weight for an exercise on `day`; a choice made on an earlier day has expired.
    public nonisolated func padAddedWeightLbs(day: String, exerciseId: String = Catalog.pullUp) throws -> Double {
        let settings = try state().settings
        return settings.padAddedWeightDay == day ? settings.padAddedWeightsLbs[exerciseId] ?? 0 : 0
    }

    /// What the pad logs: the context last chosen, else the last set's, else a plain pull-up.
    public nonisolated func padContext() throws -> SetContext {
        if let chosen = try state().settings.padContext { return chosen }
        return try lastSet(entries())?.context ?? SetContext(exerciseId: Catalog.pullUp)
    }

    // MARK: - Writes

    /// Logs one set: `reps` for a counted exercise, `holdSeconds` for a timed one.
    @discardableResult
    public func log(exerciseId: String? = nil, variationIds: [String]? = nil, reps: Int? = nil, holdSeconds: Int? = nil, doneAt: Int64? = nil, addedWeightLbs: Double = 0) throws -> Entry {
        // More variations than a set may hold would be refused by the server and wedge the outbox.
        let uniqueVariationIds = variationIds.map { ids in Array(ids.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }.prefix(EntryLimits.maxVariations)) }
        let now = nowMs()
        var entry = Entry(id: newId(), doneAt: doneAt ?? now, exerciseId: exerciseId, variationIds: uniqueVariationIds, addedWeightLbs: clampAddedWeight(addedWeightLbs), updatedAt: now)
        if let holdSeconds { entry.holdSeconds = clampHoldSeconds(holdSeconds) } else { entry.reps = clampReps(reps ?? EntryLimits.minReps) }
        entry = entry.normalized()
        try store.write { writer in
            try writer.putEntry(entry)
            try writer.queueEntry(id: entry.id)
        }
        didWrite()
        return entry
    }

    /// Logs a copy of a set: a repeat, a queue item, a confirmed draft.
    @discardableResult
    public func log(_ template: SetTemplate, doneAt: Int64? = nil) throws -> Entry {
        try log(exerciseId: template.context.exerciseId, variationIds: template.context.variationIds, reps: template.reps, holdSeconds: template.holdSeconds, doneAt: doneAt, addedWeightLbs: template.addedWeightLbs ?? 0)
    }

    /// Edits an entry, keeping every field the change doesn't name. `reps` applies only to a counted
    /// set and `holdSeconds` only to a hold. `addedWeightLbs: 0` clears the added weight.
    @discardableResult
    public func update(id: String, reps: Int? = nil, holdSeconds: Int? = nil, doneAt: Int64? = nil, addedWeightLbs: Double? = nil, isDeleted: Bool? = nil) throws -> Entry? {
        let now = nowMs()
        let edited = try store.write { writer -> Entry? in
            guard var entry = try writer.entry(id: id) else { return nil }
            if entry.reps != nil, let reps { entry.reps = clampReps(reps) }
            if entry.holdSeconds != nil, let holdSeconds { entry.holdSeconds = clampHoldSeconds(holdSeconds) }
            if let doneAt { entry.doneAt = doneAt }
            if let addedWeightLbs { entry.addedWeightLbs = clampAddedWeight(addedWeightLbs) }
            if let isDeleted { entry.isDeleted = isDeleted }
            // Strictly increase the clock so this edit beats the version it replaces even if the device clock went backwards.
            entry.updatedAt = max(now, entry.updatedAt + 1)
            entry = entry.normalized()
            try writer.putEntry(entry)
            try writer.queueEntry(id: entry.id)
            return entry
        }
        if edited != nil { didWrite() }
        return edited
    }

    public func remove(id: String) throws {
        try update(id: id, isDeleted: true)
    }

    public func restore(id: String) throws {
        try update(id: id, isDeleted: false)
    }

    /// Makes an exercise usable at once, offline too; it reaches the server with the next sync.
    @discardableResult
    public func createExercise(name: String, measure: Measure, unit: String? = nil, description: String? = nil) throws -> ExerciseDefinition {
        let now = nowMs()
        let exercise = ExerciseDefinition(id: "x-\(newDefinitionSuffix())", name: name, measure: measure, unit: measure == .count ? unit : nil, description: description, createdAt: now, updatedAt: now)
        try writeDefinition(.exercise(exercise))
        return exercise
    }

    @discardableResult
    public func createVariation(exerciseId: String, name: String) throws -> VariationDefinition {
        let now = nowMs()
        let variation = VariationDefinition(id: "v-\(newDefinitionSuffix())", exerciseId: exerciseId, name: name, createdAt: now, updatedAt: now)
        try writeDefinition(.variation(variation))
        return variation
    }

    /// Renames or redescribes a definition this account created; an empty description clears it. Measure and unit never change.
    @discardableResult
    public func editDefinition(_ definition: Definition, name: String? = nil, description: String? = nil) throws -> Definition {
        let updatedAt = max(nowMs(), definition.updatedAt + 1)
        let edited: Definition
        switch definition {
        case .exercise(var exercise):
            exercise.name = name ?? exercise.name
            if let description { exercise.description = description.isEmpty ? nil : description }
            exercise.updatedAt = updatedAt
            edited = .exercise(exercise)
        case .variation(var variation):
            variation.name = name ?? variation.name
            variation.updatedAt = updatedAt
            edited = .variation(variation)
        }
        try writeDefinition(edited)
        return edited
    }

    private func writeDefinition(_ definition: Definition) throws {
        try store.write { writer in
            try writer.putDefinition(definition.normalized())
            try writer.queueDefinition(key: definition.key)
        }
        didWrite()
    }

    /// Definitions fetched outside a sync (Add to mine): the server already has them, so nothing is queued.
    public func receiveDefinitions(_ definitions: [Definition]) throws {
        let changedKeys = try store.write { try $0.mergeDefinitions(definitions) }
        if !changedKeys.isEmpty { notifyChanged() }
    }

    /// Re-applies entries, e.g. from an export. Older versions lose to what is already here.
    @discardableResult
    public func importEntries(_ entries: [Entry]) throws -> Int {
        let changedIds = try store.write { writer in
            let changedIds = try writer.mergeEntries(entries)
            for id in changedIds { try writer.queueEntry(id: id) }
            return changedIds
        }
        didWrite()
        return changedIds.count
    }

    /// Edits the account's profile: applied here at once, queued, and sent before the next sync.
    /// Signed out, only the goal applies, to this device.
    public func updateProfile(name: String? = nil, timeZone: String? = nil, dailyGoalReps: Int? = nil) throws {
        let now = nowMs()
        let isSignedIn = try store.write { writer in
            var state = try writer.state()
            if let dailyGoalReps { state.settings.goalReps = dailyGoalReps }
            if !state.token.isEmpty {
                let clockAfter = { (storedClock: Int64?, pendingClock: Int64?) in max(now, (storedClock ?? 0) + 1, (pendingClock ?? 0) + 1) }
                if let name {
                    state.pendingProfile.nameUpdatedAt = clockAfter(state.account?.nameUpdatedAt, state.pendingProfile.nameUpdatedAt)
                    state.pendingProfile.name = name
                }
                if let timeZone {
                    state.pendingProfile.zoneUpdatedAt = clockAfter(state.account?.zoneUpdatedAt, state.pendingProfile.zoneUpdatedAt)
                    state.pendingProfile.timeZone = timeZone
                }
                if let dailyGoalReps {
                    state.pendingProfile.goalUpdatedAt = clockAfter(state.account?.goalUpdatedAt, state.pendingProfile.goalUpdatedAt)
                    state.pendingProfile.dailyGoalReps = dailyGoalReps
                }
            }
            try writer.setState(state)
            return !state.token.isEmpty
        }
        if isSignedIn { didWrite() } else { notifyChanged() }
    }

    /// Drops an answered request from the copy the last sync left, so the badge clears before the next one.
    public func dismissIncomingRequest(fromUserId: String) throws {
        try updateState { $0.account?.incomingRequests?.removeAll { $0.id == fromUserId } }
    }

    public func setPadAddedWeight(_ addedWeightLbs: Double, day: String, exerciseId: String = Catalog.pullUp) throws {
        try updateState { state in
            if state.settings.padAddedWeightDay != day { state.settings.padAddedWeightsLbs = [:] }
            state.settings.padAddedWeightsLbs[exerciseId] = clampAddedWeight(addedWeightLbs)
            state.settings.padAddedWeightDay = day
        }
    }

    public func setPadContext(_ context: SetContext) throws {
        try updateState { $0.settings.padContext = SetContext(exerciseId: context.exerciseId, variationIds: context.variationIds.sorted(by: utf16Precedes)) }
    }

    private func updateState(_ change: (inout ReplicaState) -> Void) throws {
        try store.write { writer in
            var state = try writer.state()
            change(&state)
            try writer.setState(state)
        }
        notifyChanged()
    }

    /// Adopts the token from a sign-up, a passkey sign-in or a device link. Sets logged before
    /// signing in are pushed to the account. Switching to a different account forgets what the
    /// old one had already synced, so its sets don't show (or get edited into) the new one.
    public func signIn(token: String, account: Account) throws {
        try store.write { writer in
            var state = try writer.state()
            if let previous = state.account, previous.id != account.id {
                let queuedEntryIds = Set(try writer.queuedEntryIds())
                for entry in try writer.entries() where !queuedEntryIds.contains(entry.id) { try writer.removeEntry(id: entry.id) }
                let queuedDefinitionKeys = Set(try writer.queuedDefinitionKeys())
                for definition in try writer.definitions() where !queuedDefinitionKeys.contains(definition.key) { try writer.removeDefinition(key: definition.key) }
                state.lastSyncAtMs = nil
            }
            if state.token != token { Self.resetForNewToken(&state, token: token) }
            state.account = account
            try writer.setState(state)
        }
        didChangeToken()
    }

    /// Forgets the token; unsynced work stays, to go up with the next sign-in.
    public func signOut() throws {
        try store.write { writer in
            var state = try writer.state()
            Self.resetForNewToken(&state, token: "")
            try writer.setState(state)
        }
        didChangeToken()
    }

    /// A different token may be a different account: pull its whole history, and drop edits meant for the old one's profile.
    private static func resetForNewToken(_ state: inout ReplicaState, token: String) {
        state.token = token
        state.cursor = 0
        state.account = nil
        state.pendingProfile = ProfilePatch()
    }

    private func didChangeToken() {
        consecutiveFailures = 0
        if status != .outdated { status = (try? store.read(Self.idleStatus)) ?? .pending }
        notifyChanged()
        scheduleSync(delayMs: 0)
    }

    private func didWrite() {
        if status == .synced { status = .pending }
        notifyChanged()
        scheduleSync()
    }

    // MARK: - Sync

    public func scheduleSync(delayMs: Int64 = SyncEngine.debounceMs) {
        scheduledSync?.cancel()
        scheduledSync = scheduler.schedule(afterMs: delayMs) { [weak self] in
            await self?.runScheduledSync()
        }
    }

    private func runScheduledSync() async {
        scheduledSync = nil
        await syncNow()
    }

    /// Syncs, and again while anything is left to send. A call while a sync is running waits for that one.
    public func syncNow() async {
        if let inFlightSync {
            isRerunQueued = true
            await inFlightSync.value
            return
        }
        let task = Task { await self.syncUntilDrained() }
        inFlightSync = task
        await task.value
    }

    private func syncUntilDrained() async {
        repeat {
            isRerunQueued = false
            await runSync()
        } while isRerunQueued
        inFlightSync = nil
    }

    private struct Push {
        let state: ReplicaState
        let entries: [Entry]
        let definitions: [Definition]
    }

    private func runSync() async {
        guard status != .outdated else { return }
        let push: Push
        do {
            push = try store.read { reader in
                let entries = try reader.queuedEntryIds().prefix(EntryLimits.maxPushedEntries).compactMap { try reader.entry(id: $0) }
                let definitions = try reader.queuedDefinitionKeys().prefix(DefinitionLimits.maxPushedDefinitions).compactMap { try reader.definition(key: $0) }
                return Push(state: try reader.state(), entries: entries, definitions: definitions)
            }
        } catch {
            recordFailure(error)
            return
        }
        let token = push.state.token
        guard !token.isEmpty else {
            setStatus(.unconfigured)
            return
        }
        setStatus(.syncing)
        do {
            if !push.state.pendingProfile.isEmpty {
                let account = try await transport.pushProfile(push.state.pendingProfile, token: token)
                try store.write { writer in
                    var state = try writer.state()
                    guard state.token == token else { return }
                    state.account = account
                    state.pendingProfile = state.pendingProfile.remaining(afterAcknowledging: push.state.pendingProfile)
                    try writer.setState(state)
                }
            }
            let request = SyncRequest(protocolVersion: protocolVersion, pushedEntries: push.entries, pushedDefinitions: push.definitions, sinceCursor: push.state.cursor)
            let response = try await transport.sync(request, token: token)
            let now = nowMs()
            try store.write { writer in
                var state = try writer.state()
                // The device switched tokens mid-request: this response belongs to the old one. Keep the
                // outbox, and the next sync, which the switch scheduled, pushes it again.
                guard state.token == token else { return }
                try writer.mergeDefinitions(response.definitions ?? [])
                try writer.mergeEntries(response.entries)
                state.cursor = max(state.cursor, response.cursor)
                state.account = response.account
                state.lastSyncAtMs = now
                try writer.setState(state)
                // A row edited again while the request was in flight stays queued.
                for sent in push.entries {
                    if try writer.entry(id: sent.id)?.updatedAt == sent.updatedAt { try writer.dequeueEntry(id: sent.id) }
                }
                for sent in push.definitions {
                    if try writer.definition(key: sent.key)?.updatedAt == sent.updatedAt { try writer.dequeueDefinition(key: sent.key) }
                }
            }
            consecutiveFailures = 0
            lastError = nil
            let idleStatus = try store.read(Self.idleStatus)
            setStatus(idleStatus)
            if idleStatus == .pending { isRerunQueued = true }
        } catch let error as HTTPError where error.status == 401 || error.status == 403 {
            lastError = error.status == 401 ? "This device was signed out. Sign in again with your passkey or a device link." : "Forbidden by CloudFront. Check the deploy."
            setStatus(.auth)
        } catch let error as HTTPError where error.status == 426 {
            lastError = "This version of the app is too old to sync. Update it; nothing logged here is lost."
            setStatus(.outdated)
        } catch {
            recordFailure(error)
        }
    }

    private func recordFailure(_ error: any Error) {
        consecutiveFailures += 1
        lastError = (error as? HTTPError)?.message ?? error.localizedDescription
        setStatus(.offline)
        scheduleSync(delayMs: backoffMs(consecutiveFailures: consecutiveFailures))
    }

    private static func idleStatus(_ reader: any ReplicaReader) throws -> SyncStatus {
        if try reader.state().token.isEmpty { return .unconfigured }
        return try reader.pendingCount() > 0 ? .pending : .synced
    }

    private func setStatus(_ newStatus: SyncStatus) {
        status = newStatus
        notifyChanged()
    }

    private func notifyChanged() {
        changesContinuation.yield()
    }
}

private func clampReps(_ reps: Int) -> Int {
    min(EntryLimits.maxReps, max(EntryLimits.minReps, reps))
}

private func clampHoldSeconds(_ holdSeconds: Int) -> Int {
    min(EntryLimits.maxHoldSeconds, max(EntryLimits.minHoldSeconds, holdSeconds))
}
