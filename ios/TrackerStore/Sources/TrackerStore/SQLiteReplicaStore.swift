import Foundation
import GRDB
import TrackerCore

/// The replica in SQLite, shared by the app, widgets and intents through the App Group container.
/// Each process opens its own pool on the same file; WAL lets them read while one writes, and a
/// busy timeout makes a writer wait out another process's transaction rather than fail.
///
/// Entries and definitions are stored as their wire JSON beside the columns a query needs, so a
/// field added to the model needs no migration.
public final class SQLiteReplicaStore: ReplicaStore {
    private let pool: DatabasePool

    public init(path: String) throws {
        var configuration = Configuration()
        configuration.busyMode = .timeout(5)
        // The app posts Database.suspendNotification as it goes to the background, so iOS doesn't
        // kill it for holding a lock on a file in the shared container.
        configuration.observesSuspensionNotifications = true
        pool = try DatabasePool(path: path, configuration: configuration)
        try Self.migrator.migrate(pool)
    }

    /// The database in an App Group's shared container.
    public convenience init(appGroup groupIdentifier: String) throws {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupIdentifier) else {
            throw MissingAppGroup(groupIdentifier: groupIdentifier)
        }
        try self.init(path: container.appendingPathComponent("replica.sqlite").path)
    }

    public struct MissingAppGroup: Error, CustomStringConvertible {
        public let groupIdentifier: String
        public var description: String { "no container for App Group \(groupIdentifier); check the entitlement" }
    }

    private static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.execute(sql: """
                CREATE TABLE entry (
                    id TEXT PRIMARY KEY NOT NULL,
                    doneAt INTEGER NOT NULL,
                    body TEXT NOT NULL
                );
                CREATE INDEX entry_doneAt ON entry(doneAt);
                CREATE TABLE entryOutbox (
                    position INTEGER PRIMARY KEY AUTOINCREMENT,
                    entryId TEXT NOT NULL UNIQUE
                );
                CREATE TABLE definition (
                    key TEXT PRIMARY KEY NOT NULL,
                    body TEXT NOT NULL
                );
                CREATE TABLE definitionOutbox (
                    position INTEGER PRIMARY KEY AUTOINCREMENT,
                    definitionKey TEXT NOT NULL UNIQUE
                );
                CREATE TABLE replicaState (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    body TEXT NOT NULL
                );
                """)
        }
        return migrator
    }

    public func read<T>(_ body: (any ReplicaReader) throws -> T) throws -> T {
        try pool.read { db in try body(SQLiteReplica(db: db)) }
    }

    public func write<T>(_ body: (any ReplicaWriter) throws -> T) throws -> T {
        try pool.write { db in try body(SQLiteReplica(db: db)) }
    }
}

private struct SQLiteReplica: ReplicaWriter {
    let db: Database
    let decoder = JSONDecoder()
    let encoder = JSONEncoder()

    private func decode<T: Decodable>(_ type: T.Type, _ body: String) throws -> T {
        try decoder.decode(type, from: Data(body.utf8))
    }

    private func encode(_ value: some Encodable) throws -> String {
        String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    func entries() throws -> [Entry] {
        try String.fetchAll(db, sql: "SELECT body FROM entry").map { try decode(Entry.self, $0) }
    }

    func entry(id: String) throws -> Entry? {
        try String.fetchOne(db, sql: "SELECT body FROM entry WHERE id = ?", arguments: [id]).map { try decode(Entry.self, $0) }
    }

    func queuedEntryIds() throws -> [String] {
        try String.fetchAll(db, sql: "SELECT entryId FROM entryOutbox ORDER BY position")
    }

    func definitions() throws -> [Definition] {
        try String.fetchAll(db, sql: "SELECT body FROM definition").map { try decode(Definition.self, $0) }
    }

    func definition(key: String) throws -> Definition? {
        try String.fetchOne(db, sql: "SELECT body FROM definition WHERE key = ?", arguments: [key]).map { try decode(Definition.self, $0) }
    }

    func queuedDefinitionKeys() throws -> [String] {
        try String.fetchAll(db, sql: "SELECT definitionKey FROM definitionOutbox ORDER BY position")
    }

    func state() throws -> ReplicaState {
        try String.fetchOne(db, sql: "SELECT body FROM replicaState WHERE id = 1").map { try decode(ReplicaState.self, $0) } ?? ReplicaState()
    }

    func putEntry(_ entry: Entry) throws {
        try db.execute(
            sql: "INSERT INTO entry (id, doneAt, body) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET doneAt = excluded.doneAt, body = excluded.body",
            arguments: [entry.id, entry.doneAt, try encode(entry)]
        )
    }

    func removeEntry(id: String) throws {
        try db.execute(sql: "DELETE FROM entry WHERE id = ?", arguments: [id])
    }

    func queueEntry(id: String) throws {
        try db.execute(sql: "INSERT OR IGNORE INTO entryOutbox (entryId) VALUES (?)", arguments: [id])
    }

    func dequeueEntry(id: String) throws {
        try db.execute(sql: "DELETE FROM entryOutbox WHERE entryId = ?", arguments: [id])
    }

    func putDefinition(_ definition: Definition) throws {
        try db.execute(
            sql: "INSERT INTO definition (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body",
            arguments: [definition.key, try encode(definition)]
        )
    }

    func removeDefinition(key: String) throws {
        try db.execute(sql: "DELETE FROM definition WHERE key = ?", arguments: [key])
    }

    func queueDefinition(key: String) throws {
        try db.execute(sql: "INSERT OR IGNORE INTO definitionOutbox (definitionKey) VALUES (?)", arguments: [key])
    }

    func dequeueDefinition(key: String) throws {
        try db.execute(sql: "DELETE FROM definitionOutbox WHERE definitionKey = ?", arguments: [key])
    }

    func setState(_ state: ReplicaState) throws {
        try db.execute(sql: "INSERT OR REPLACE INTO replicaState (id, body) VALUES (1, ?)", arguments: [try encode(state)])
    }
}
