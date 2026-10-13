import Foundation
import Testing
import TrackerCore
import TrackerCoreTesting
import TrackerStore

/// A database file in a fresh temporary directory, removed when the test is done with it.
private final class TemporaryDatabase {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("TrackerStoreTests-\(UUID().uuidString)")
    var path: String { directory.appendingPathComponent("replica.sqlite").path }

    init() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    deinit {
        try? FileManager.default.removeItem(at: directory)
    }

    func open() throws -> SQLiteReplicaStore {
        try SQLiteReplicaStore(path: path)
    }
}

@Suite("SQLiteReplicaStore")
struct SQLiteReplicaStoreTests {
    @Test func conforms() throws {
        var databases: [TemporaryDatabase] = []
        let failures = try replicaStoreConformanceFailures {
            let database = try TemporaryDatabase()
            databases.append(database)
            return try database.open()
        }
        #expect(failures == [])
    }

    @Test func keepsTheReplicaAndItsOutboxAcrossLaunches() async throws {
        let database = try TemporaryDatabase()
        let server = FakeServer()
        await server.setMode(.offline)
        let first = try Device(server: server, store: database.open())
        let entry = try await first.engine.log(exerciseId: "dip", reps: 8, addedWeightLbs: 25)
        try await first.engine.updateProfile(dailyGoalReps: 50)

        let relaunched = try Device(server: server, store: database.open())
        #expect(try relaunched.engine.entry(id: entry.id) == entry)
        #expect(try relaunched.engine.pendingCount() == 2)
        #expect(try relaunched.engine.goalReps() == 50)
        #expect(await relaunched.engine.status == .pending)

        await server.setMode(.online)
        await relaunched.engine.syncNow()
        #expect(await server.entry(entry.id) == entry)
        #expect(try first.engine.pendingCount() == 0)
    }

    @Test func devicesOnSQLiteConverge() async throws {
        let databaseA = try TemporaryDatabase()
        let databaseB = try TemporaryDatabase()
        let server = FakeServer()
        let deviceA = try Device(server: server, store: databaseA.open())
        let deviceB = try Device(server: server, store: databaseB.open())
        let stairs = try await deviceA.engine.createExercise(name: "Red Rocks stairs", measure: .count, unit: "lap")
        try await deviceA.engine.log(exerciseId: stairs.id, reps: 3)
        let setB = try await deviceB.engine.log(reps: 7)
        await deviceA.engine.syncNow()
        await deviceB.engine.syncNow()
        await deviceA.engine.syncNow()
        deviceA.clock.current += 1000
        try await deviceA.engine.remove(id: setB.id)
        await deviceA.engine.syncNow()
        await deviceB.engine.syncNow()

        let entriesA = try deviceA.engine.entries().sorted { $0.id < $1.id }
        #expect(entriesA == (try deviceB.engine.entries().sorted { $0.id < $1.id }))
        #expect(entriesA.count == 2)
        #expect(try deviceB.engine.entry(id: setB.id)?.isDeleted == true)
        #expect(try deviceB.engine.exercise(stairs.id)?.unit == "lap")
    }

    /// The app and a widget are separate processes with their own connections to one file.
    @Test func twoConnectionsWritingAtOnceLoseNothing() async throws {
        let database = try TemporaryDatabase()
        let app = try database.open()
        let widget = try database.open()
        let writesPerConnection = 200
        await withTaskGroup(of: Void.self) { group in
            for (name, store) in [("app", app), ("widget", widget)] {
                group.addTask {
                    for i in 0..<writesPerConnection {
                        let entry = Entry(id: "\(name)\(i)", doneAt: testStartMs + Int64(i), reps: 5, updatedAt: 1)
                        try? store.write { writer in
                            try writer.putEntry(entry)
                            try writer.queueEntry(id: entry.id)
                            var state = try writer.state()
                            state.cursor += 1
                            try writer.setState(state)
                        }
                    }
                }
            }
        }
        let (entryCount, queuedCount, cursor) = try app.read { reader in
            (try reader.entries().count, try reader.queuedEntryIds().count, try reader.state().cursor)
        }
        #expect(entryCount == 2 * writesPerConnection)
        #expect(queuedCount == 2 * writesPerConnection)
        // Each write read the cursor and bumped it inside its transaction, so none was lost.
        #expect(cursor == Int64(2 * writesPerConnection))
    }

    @Test func aSyncFromOneProcessKeepsAnotherProcessesNewerEdit() async throws {
        let database = try TemporaryDatabase()
        let server = FakeServer()
        let app = try Device(server: server, store: database.open())
        let widget = try Device(server: server, store: database.open())
        let entry = try await app.engine.log(reps: 5)
        let gates = await server.holdNextRequest()
        let sync = Task { await app.engine.syncNow() }
        await gates.arrived.wait()
        widget.clock.current += 1000
        try await widget.engine.update(id: entry.id, reps: 9)
        await gates.release.open()
        await sync.value
        #expect(await server.entry(entry.id)?.reps == 9)
        #expect(try app.engine.pendingCount() == 0)
    }
}
