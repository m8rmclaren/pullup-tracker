import Foundation
@testable import TrackerCore

/// A value tests can change while the engine reads it from another task.
final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    var current: Value {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }

    func update<T>(_ change: (inout Value) -> T) -> T {
        lock.withLock { change(&value) }
    }
}

/// Holds timers until a test fires them, so the debounce and backoff are checked without waiting.
final class ManualScheduler: SyncScheduler {
    struct Timer {
        let id: Int
        let delayMs: Int64
        let action: @Sendable () async -> Void
    }

    private let timers = Locked<[Timer]>([])
    private let nextId = Locked(0)

    var pending: [Timer] { timers.current }

    func clear() {
        timers.current = []
    }

    func schedule(afterMs delayMs: Int64, _ action: @escaping @Sendable () async -> Void) -> any ScheduledSync {
        let id = nextId.update { id -> Int in
            id += 1
            return id
        }
        timers.update { $0.append(Timer(id: id, delayMs: delayMs, action: action)) }
        return Cancel(id: id, timers: timers)
    }

    private struct Cancel: ScheduledSync {
        let id: Int
        let timers: Locked<[Timer]>
        func cancel() { timers.update { $0.removeAll { $0.id == id } } }
    }
}

/// One-shot signal a test opens to let a suspended task go on.
actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        for waiter in waiters { waiter.resume() }
        waiters = []
    }
}

/// The server's side of sync, enough to converge devices: a per-account store that merges by the
/// same rule, a write sequence for cursors, and creators stamped on definitions.
actor FakeServer: SyncTransport {
    enum Mode {
        case online
        case offline
        case rejectsToken
        case outdated
    }

    private struct AccountData {
        var account: Account
        var entriesById: [String: Entry] = [:]
        var sequenceById: [String: Int64] = [:]
        var definitionsByKey: [String: Definition] = [:]
    }

    private var accountsById: [String: AccountData] = [:]
    private var userIdByToken: [String: String] = [:]
    private var sequence: Int64 = 0
    var mode = Mode.online
    private(set) var requests: [SyncRequest] = []
    private(set) var profilePatches: [ProfilePatch] = []
    /// When set, each request opens `arrived`, then waits on `release` before answering.
    private var hold: (arrived: Gate, release: Gate)?

    init(accounts: [Account] = [Account(id: "u1", name: "Me", timeZone: "America/Denver")]) {
        for account in accounts { accountsById[account.id] = AccountData(account: account) }
    }

    func setMode(_ mode: Mode) {
        self.mode = mode
    }

    func assign(token: String, to userId: String) {
        userIdByToken[token] = userId
    }

    func holdNextRequest() -> (arrived: Gate, release: Gate) {
        let gates = (arrived: Gate(), release: Gate())
        hold = gates
        return gates
    }

    func entry(_ id: String, userId: String = "u1") -> Entry? {
        accountsById[userId]?.entriesById[id]
    }

    func definition(_ key: String, userId: String = "u1") -> Definition? {
        accountsById[userId]?.definitionsByKey[key]
    }

    func account(_ userId: String = "u1") -> Account? {
        accountsById[userId]?.account
    }

    /// Writes entries as if another client had pushed them.
    func seed(_ entries: [Entry], userId: String = "u1") {
        merge(entries, into: userId)
    }

    private func userId(for token: String) -> String {
        userIdByToken[token] ?? "u1"
    }

    private func checkMode() async throws {
        if let gates = hold {
            hold = nil
            await gates.arrived.open()
            await gates.release.wait()
        }
        switch mode {
        case .online: return
        case .offline: throw URLError(.notConnectedToInternet)
        case .rejectsToken: throw HTTPError(status: 401, message: "Sign in again.")
        case .outdated: throw HTTPError(status: 426, message: "Update the app to keep syncing.")
        }
    }

    func sync(_ request: SyncRequest, token: String) async throws -> SyncResponse {
        requests.append(request)
        try await checkMode()
        // Round-trip through JSON, as the wire does.
        let request = try JSONDecoder().decode(SyncRequest.self, from: JSONEncoder().encode(request))
        let userId = userId(for: token)
        for definition in request.pushedDefinitions {
            var stamped = definition
            if stamped.createdBy == nil { stamped.createdBy = userId }
            mergeDefinitions(into: &accountsById[userId]!.definitionsByKey, [stamped])
        }
        merge(request.pushedEntries, into: userId)
        let data = accountsById[userId]!
        let entries = data.entriesById.values.filter { data.sequenceById[$0.id]! > request.sinceCursor }
        return SyncResponse(entries: entries, definitions: Array(data.definitionsByKey.values), cursor: sequence, account: data.account)
    }

    func pushProfile(_ patch: ProfilePatch, token: String) async throws -> Account {
        profilePatches.append(patch)
        try await checkMode()
        let userId = userId(for: token)
        var account = accountsById[userId]!.account
        if let name = patch.name, let clock = patch.nameUpdatedAt, clock > account.nameUpdatedAt ?? 0 {
            account.name = name
            account.nameUpdatedAt = clock
        }
        if let timeZone = patch.timeZone, let clock = patch.zoneUpdatedAt, clock > account.zoneUpdatedAt ?? 0 {
            account.timeZone = timeZone
            account.zoneUpdatedAt = clock
        }
        if let goal = patch.dailyGoalReps, let clock = patch.goalUpdatedAt, clock > account.goalUpdatedAt ?? 0 {
            account.dailyGoalReps = goal
            account.goalUpdatedAt = clock
        }
        accountsById[userId]!.account = account
        return account
    }

    private func merge(_ entries: [Entry], into userId: String) {
        for id in mergeEntries(into: &accountsById[userId]!.entriesById, entries) {
            sequence += 1
            accountsById[userId]!.sequenceById[id] = sequence
        }
    }
}

let testStartMs = instantMs(.string("2026-10-08T18:00:00Z"))

/// A device: its own store, clock and timers, talking to a shared server.
struct Device {
    let engine: SyncEngine
    let store: MemoryReplicaStore
    let scheduler: ManualScheduler
    let clock: Locked<Int64>

    init(server: any SyncTransport, store: MemoryReplicaStore = MemoryReplicaStore(), token: String? = "tok", deviceTimeZone: String = "America/Denver") throws {
        let scheduler = ManualScheduler()
        let clock = Locked(testStartMs)
        if let token {
            try store.write { writer in
                var state = try writer.state()
                state.token = token
                try writer.setState(state)
            }
        }
        self.store = store
        self.scheduler = scheduler
        self.clock = clock
        engine = try SyncEngine(store: store, transport: server, scheduler: scheduler, deviceTimeZone: deviceTimeZone, nowMs: { clock.current })
    }
}
