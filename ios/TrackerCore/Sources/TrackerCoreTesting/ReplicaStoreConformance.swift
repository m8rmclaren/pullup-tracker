import Foundation
import TrackerCore

private struct Rollback: Error {}

/// What every ReplicaStore must do, as a list of what a store got wrong. Each check gets a fresh store.
public func replicaStoreConformanceFailures(_ makeStore: () throws -> any ReplicaStore) throws -> [String] {
    var failures: [String] = []
    func check(_ isPassing: Bool, _ description: String) {
        if !isPassing { failures.append(description) }
    }

    let chinUp = Entry(id: "e1", doneAt: 1_000, exerciseId: "chin-up", variationIds: ["band", "negative"], reps: 5, addedWeightLbs: 2.5, updatedAt: 1)
    let lever = Entry(id: "e2", doneAt: 2_000, exerciseId: "front-lever", holdSeconds: 20, updatedAt: 2, isDeleted: true)
    let stairs = Definition.exercise(ExerciseDefinition(id: "x-k3p7aaaaaaaaaaaa", name: "Red Rocks stairs", measure: .count, unit: "lap", description: "Bottom to top", createdBy: "u1", createdAt: 1, updatedAt: 1))
    let intoTuck = Definition.variation(VariationDefinition(id: "v-intotuckaaaaaaaa", exerciseId: "muscle-up", name: "Into tuck", createdAt: 1, updatedAt: 1))

    do {
        let store = try makeStore()
        try store.read { reader in
            check(try reader.entries().isEmpty, "a new store has no entries")
            check(try reader.definitions().isEmpty, "a new store has no definitions")
            check(try reader.state() == ReplicaState(), "a new store has the default state")
            check(try reader.queuedEntryIds().isEmpty && reader.queuedDefinitionKeys().isEmpty, "a new store has empty outboxes")
        }
    }

    do {
        let store = try makeStore()
        try store.write { writer in
            try writer.putEntry(chinUp)
            try writer.putEntry(lever)
        }
        try store.read { reader in
            check(try reader.entry(id: "e1") == chinUp, "an entry round-trips every field")
            check(try reader.entry(id: "e2") == lever, "a timed tombstone round-trips")
            check(try reader.entry(id: "missing") == nil, "a missing entry reads as nil")
            check(try reader.entries().count == 2, "entries lists every entry")
        }
        var edited = chinUp
        edited.reps = 6
        edited.updatedAt = 3
        try store.write { try $0.putEntry(edited) }
        check(try store.read { try $0.entry(id: "e1") } == edited, "putEntry replaces the stored version")
        try store.write { try $0.removeEntry(id: "e2") }
        check(try store.read { try $0.entries().map(\.id) } == ["e1"], "removeEntry removes it")
    }

    do {
        let store = try makeStore()
        try store.write { writer in
            for id in ["c", "a", "b", "a"] { try writer.queueEntry(id: id) }
        }
        check(try store.read { try $0.queuedEntryIds() } == ["c", "a", "b"], "the entry outbox keeps first-queued order without repeats")
        try store.write { try $0.dequeueEntry(id: "a") }
        check(try store.read { try $0.queuedEntryIds() } == ["c", "b"], "dequeueEntry removes one id")
        try store.write { try $0.queueEntry(id: "a") }
        check(try store.read { try $0.queuedEntryIds() } == ["c", "b", "a"], "an id queued again after dequeue goes to the back")
    }

    do {
        let store = try makeStore()
        try store.write { writer in
            try writer.putDefinition(stairs)
            try writer.putDefinition(intoTuck)
            try writer.queueDefinition(key: intoTuck.key)
            try writer.queueDefinition(key: stairs.key)
        }
        try store.read { reader in
            check(try reader.definition(key: stairs.key) == stairs, "an exercise definition round-trips")
            check(try reader.definition(key: "muscle-up/v-intotuckaaaaaaaa") == intoTuck, "a variation is keyed by its exercise and id")
            check(try reader.definitions().count == 2, "definitions lists every definition")
            check(try reader.queuedDefinitionKeys() == [intoTuck.key, stairs.key], "the definition outbox keeps queued order")
        }
        try store.write { writer in
            try writer.removeDefinition(key: stairs.key)
            try writer.dequeueDefinition(key: intoTuck.key)
        }
        try store.read { reader in
            check(try reader.definitions() == [intoTuck], "removeDefinition removes it")
            check(try reader.queuedDefinitionKeys() == [stairs.key], "dequeueDefinition removes one key")
        }
    }

    do {
        let store = try makeStore()
        var state = ReplicaState()
        state.token = "tok"
        state.cursor = 42
        state.account = Account(id: "u1", name: "Me", nameUpdatedAt: 5, timeZone: "Europe/London", dailyGoalReps: 50, incomingRequests: [IncomingRequest(id: "u2", name: "Sam", challengeId: "c1")])
        state.pendingProfile.dailyGoalReps = 60
        state.pendingProfile.goalUpdatedAt = 7
        state.lastSyncAtMs = 9
        state.settings.goalReps = 40
        state.settings.padAddedWeightDay = "2026-10-08"
        state.settings.padAddedWeightsLbs = ["dip": 10]
        state.settings.padContext = SetContext(exerciseId: "dip", variationIds: ["wide-grip"])
        try store.write { try $0.setState(state) }
        check(try store.read { try $0.state() } == state, "the state round-trips every field")
    }

    do {
        let store = try makeStore()
        try? store.write { writer -> Void in
            try writer.putEntry(chinUp)
            try writer.queueEntry(id: chinUp.id)
            var state = try writer.state()
            state.cursor = 7
            try writer.setState(state)
            throw Rollback()
        }
        try store.read { reader in
            check(try reader.entries().isEmpty && reader.queuedEntryIds().isEmpty && reader.state().cursor == 0, "a write that throws leaves nothing behind")
        }
    }

    return failures
}
