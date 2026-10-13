import Foundation

// The local replica's storage. The app, widgets and intents each write in their own process, so
// nothing holds the replica in memory between calls: every read and write goes through a store
// transaction. The app's store is SQLite in the App Group container; MemoryReplicaStore is for
// tests and previews.

/// Device-local choices that never sync.
public struct DeviceSettings: Codable, Hashable, Sendable {
    public static let defaultGoalReps = 35

    /// The goal before the account has one.
    public var goalReps = defaultGoalReps
    /// The day the pad's added weights were chosen. They reset to bodyweight the next day, so a forgotten belt doesn't weight tomorrow's sets.
    public var padAddedWeightDay = ""
    /// Added weight per exercise the pad logs with, for padAddedWeightDay; missing means bodyweight.
    public var padAddedWeightsLbs: [String: Double] = [:]
    /// The exercise and configuration the pad logs, sticky until changed. Nil: the last set's.
    public var padContext: SetContext?

    public init() {}

    // A field added later reads as its default from state saved before it existed.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        goalReps = try container.decodeIfPresent(Int.self, forKey: .goalReps) ?? Self.defaultGoalReps
        padAddedWeightDay = try container.decodeIfPresent(String.self, forKey: .padAddedWeightDay) ?? ""
        padAddedWeightsLbs = try container.decodeIfPresent([String: Double].self, forKey: .padAddedWeightsLbs) ?? [:]
        padContext = try container.decodeIfPresent(SetContext.self, forKey: .padContext)
    }
}

/// Everything in the replica besides entries, definitions and their outboxes.
public struct ReplicaState: Codable, Hashable, Sendable {
    /// Empty when this device isn't signed in.
    public var token = ""
    /// The server cursor from the last sync; 0 pulls everything.
    public var cursor: Int64 = 0
    public var account: Account?
    /// Profile edits made here and not yet acknowledged, each with its clock.
    public var pendingProfile = ProfilePatch()
    public var lastSyncAtMs: Int64?
    public var settings = DeviceSettings()

    public init() {}

    // A field added later reads as its default from state saved before it existed.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        token = try container.decodeIfPresent(String.self, forKey: .token) ?? ""
        cursor = try container.decodeIfPresent(Int64.self, forKey: .cursor) ?? 0
        account = try container.decodeIfPresent(Account.self, forKey: .account)
        pendingProfile = try container.decodeIfPresent(ProfilePatch.self, forKey: .pendingProfile) ?? ProfilePatch()
        lastSyncAtMs = try container.decodeIfPresent(Int64.self, forKey: .lastSyncAtMs)
        settings = try container.decodeIfPresent(DeviceSettings.self, forKey: .settings) ?? DeviceSettings()
    }
}

public protocol ReplicaReader {
    func entries() throws -> [Entry]
    func entry(id: String) throws -> Entry?
    /// Ids of entries written here and not yet acknowledged, oldest first.
    func queuedEntryIds() throws -> [String]
    func definitions() throws -> [Definition]
    func definition(key: String) throws -> Definition?
    /// Keys (Definition.key) of definitions created or edited here and not yet acknowledged, oldest first.
    func queuedDefinitionKeys() throws -> [String]
    func state() throws -> ReplicaState
}

public protocol ReplicaWriter: ReplicaReader {
    func putEntry(_ entry: Entry) throws
    func removeEntry(id: String) throws
    func queueEntry(id: String) throws
    func dequeueEntry(id: String) throws
    func putDefinition(_ definition: Definition) throws
    func removeDefinition(key: String) throws
    func queueDefinition(key: String) throws
    func dequeueDefinition(key: String) throws
    func setState(_ state: ReplicaState) throws
}

/// Each `write` is one transaction: all of it lands, or none of it does.
public protocol ReplicaStore: Sendable {
    func read<T>(_ body: (any ReplicaReader) throws -> T) throws -> T
    func write<T>(_ body: (any ReplicaWriter) throws -> T) throws -> T
}

extension ReplicaReader {
    public func pendingCount() throws -> Int {
        try queuedEntryIds().count + queuedDefinitionKeys().count + (state().pendingProfile.isEmpty ? 0 : 1)
    }
}

extension ReplicaWriter {
    /// Merges incoming versions by the CRDT rule. Returns the ids whose stored version changed.
    @discardableResult
    public func mergeEntries(_ incoming: [Entry]) throws -> [String] {
        var changedIds: [String] = []
        for entry in incoming {
            if let stored = try self.entry(id: entry.id) {
                let winner = Entry.pickWinner(stored, entry)
                if Entry.isSameVersion(winner, stored) { continue }
                try putEntry(winner.normalized())
            } else {
                try putEntry(entry.normalized())
            }
            changedIds.append(entry.id)
        }
        return changedIds
    }

    @discardableResult
    public func mergeDefinitions(_ incoming: [Definition]) throws -> [String] {
        var definitionsByKey: [String: Definition] = [:]
        for key in Set(incoming.map(\.key)) {
            if let stored = try definition(key: key) { definitionsByKey[key] = stored }
        }
        let changedKeys = TrackerCore.mergeDefinitions(into: &definitionsByKey, incoming)
        for key in changedKeys { try putDefinition(definitionsByKey[key]!) }
        return changedKeys
    }
}

/// A replica held in memory, for tests and previews.
public final class MemoryReplicaStore: ReplicaStore, @unchecked Sendable {
    private let lock = NSLock()
    private var contents = MemoryReplica()

    public init() {}

    public func read<T>(_ body: (any ReplicaReader) throws -> T) throws -> T {
        try lock.withLock { try body(contents) }
    }

    public func write<T>(_ body: (any ReplicaWriter) throws -> T) throws -> T {
        try lock.withLock {
            let transaction = contents.copy()
            let result = try body(transaction)
            contents = transaction
            return result
        }
    }
}

private final class MemoryReplica: ReplicaWriter {
    var entriesById: [String: Entry] = [:]
    var entryQueue: [String] = []
    var definitionsByKey: [String: Definition] = [:]
    var definitionQueue: [String] = []
    var replicaState = ReplicaState()

    func copy() -> MemoryReplica {
        let copy = MemoryReplica()
        copy.entriesById = entriesById
        copy.entryQueue = entryQueue
        copy.definitionsByKey = definitionsByKey
        copy.definitionQueue = definitionQueue
        copy.replicaState = replicaState
        return copy
    }

    func entries() -> [Entry] { Array(entriesById.values) }
    func entry(id: String) -> Entry? { entriesById[id] }
    func queuedEntryIds() -> [String] { entryQueue }
    func definitions() -> [Definition] { Array(definitionsByKey.values) }
    func definition(key: String) -> Definition? { definitionsByKey[key] }
    func queuedDefinitionKeys() -> [String] { definitionQueue }
    func state() -> ReplicaState { replicaState }

    func putEntry(_ entry: Entry) { entriesById[entry.id] = entry }
    func removeEntry(id: String) { entriesById[id] = nil }
    func queueEntry(id: String) { if !entryQueue.contains(id) { entryQueue.append(id) } }
    func dequeueEntry(id: String) { entryQueue.removeAll { $0 == id } }
    func putDefinition(_ definition: Definition) { definitionsByKey[definition.key] = definition }
    func removeDefinition(key: String) { definitionsByKey[key] = nil }
    func queueDefinition(key: String) { if !definitionQueue.contains(key) { definitionQueue.append(key) } }
    func dequeueDefinition(key: String) { definitionQueue.removeAll { $0 == key } }
    func setState(_ state: ReplicaState) { replicaState = state }
}
