import Foundation
import TrackerCore

/// A value tests can change while the engine reads it from another task.
public final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    public init(_ value: Value) {
        self.value = value
    }

    public var current: Value {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }

    public func update<T>(_ change: (inout Value) -> T) -> T {
        lock.withLock { change(&value) }
    }
}

/// Holds timers until a test fires them, so the debounce and backoff are checked without waiting.
public final class ManualScheduler: SyncScheduler {
    public struct Timer: Sendable {
        public let id: Int
        public let delayMs: Int64
        public let action: @Sendable () async -> Void
    }

    private let timers = Locked<[Timer]>([])
    private let nextId = Locked(0)

    public init() {}

    public var pending: [Timer] { timers.current }

    public func clear() {
        timers.current = []
    }

    public func schedule(afterMs delayMs: Int64, _ action: @escaping @Sendable () async -> Void) -> any ScheduledSync {
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
public actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init() {}

    public func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    public func open() {
        isOpen = true
        for waiter in waiters { waiter.resume() }
        waiters = []
    }
}

/// The server's side of sync, enough to converge devices: a per-account store that merges by the
/// same rule, a write sequence for cursors, and creators stamped on definitions.
public actor FakeServer: SyncTransport {
    public enum Mode: Sendable {
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
    public private(set) var mode = Mode.online
    public private(set) var requests: [SyncRequest] = []
    public private(set) var profilePatches: [ProfilePatch] = []
    /// When set, each request opens `arrived`, then waits on `release` before answering.
    private var hold: (arrived: Gate, release: Gate)?

    public init(accounts: [Account] = [Account(id: "u1", name: "Me", timeZone: "America/Denver")]) {
        for account in accounts { accountsById[account.id] = AccountData(account: account) }
    }

    public func setMode(_ mode: Mode) {
        self.mode = mode
    }

    public func assign(token: String, to userId: String) {
        userIdByToken[token] = userId
    }

    public func holdNextRequest() -> (arrived: Gate, release: Gate) {
        let gates = (arrived: Gate(), release: Gate())
        hold = gates
        return gates
    }

    public func entry(_ id: String, userId: String = "u1") -> Entry? {
        accountsById[userId]?.entriesById[id]
    }

    public func definition(_ key: String, userId: String = "u1") -> Definition? {
        accountsById[userId]?.definitionsByKey[key]
    }

    public func account(_ userId: String = "u1") -> Account? {
        accountsById[userId]?.account
    }

    /// Writes entries as if another client had pushed them.
    public func seed(_ entries: [Entry], userId: String = "u1") {
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

    public func sync(_ request: SyncRequest, token: String) async throws -> SyncResponse {
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

    public func pushProfile(_ patch: ProfilePatch, token: String) async throws -> Account {
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

/// 2026-10-08T18:00:00Z, when every test device's clock starts.
public let testStartMs: Int64 = 1_791_482_400_000

/// A device: its own store, clock and timers, talking to a shared server.
public struct Device {
    public let engine: SyncEngine
    public let store: any ReplicaStore
    public let scheduler: ManualScheduler
    public let clock: Locked<Int64>

    public init(server: any SyncTransport, store: any ReplicaStore = MemoryReplicaStore(), token: String? = "tok", deviceTimeZone: String = "America/Denver") throws {
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
