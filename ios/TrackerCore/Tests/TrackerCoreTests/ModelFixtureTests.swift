import Foundation
import Testing
@testable import TrackerCore

@Suite("merge.json and validation.json")
struct ModelFixtureTests {
    let merge: JSONValue
    let validation: JSONValue

    init() throws {
        merge = try loadFixture("merge.json")
        validation = try loadFixture("validation.json")
    }

    @Test func pickWinner() throws {
        for testCase in merge["winners"]!.array {
            let a = try testCase["a"]!.decoded(as: Entry.self)
            let b = try testCase["b"]!.decoded(as: Entry.self)
            let expected = testCase["winner"]!.string == "a" ? a : b
            #expect(Entry.pickWinner(a, b) == expected, "\(testCase["name"]!.string)")
            #expect(Entry.pickWinner(b, a) == expected, "\(testCase["name"]!.string), reversed")
        }
    }

    @Test func replicasConvergeInEveryOrder() throws {
        for testCase in merge["replicas"]!.array {
            let replicas: [[Entry]] = try testCase["replicas"]!.array.map { try $0.decoded(as: [Entry].self) }
            let expected = try testCase["merged"]!.decoded(as: [Entry].self)
            var orders = permutations(replicas)
            orders.append(replicas + replicas)
            for order in orders {
                var entriesById: [String: Entry] = [:]
                for replica in order { mergeEntries(into: &entriesById, replica) }
                let merged = entriesById.values.sorted { $0.id < $1.id }
                #expect(merged == expected, "\(testCase["name"]!.string)")
            }
        }
    }

    @Test func normalize() throws {
        for testCase in merge["normalize"]!.array {
            let normalized = try testCase["entry"]!.decoded(as: Entry.self).normalized()
            let found = try mismatches(normalized, testCase["normalized"], isSubset: false)
            #expect(found.isEmpty, "\(testCase["name"]!.string): \(found)")
        }
    }

    @Test func pickDefinitionWinner() throws {
        for testCase in merge["definitionWinners"]!.array {
            let a = try testCase["a"]!.decoded(as: Definition.self)
            let b = try testCase["b"]!.decoded(as: Definition.self)
            let expected = testCase["winner"]!.string == "a" ? a : b
            #expect(Definition.pickWinner(a, b) == expected, "\(testCase["name"]!.string)")
            #expect(Definition.pickWinner(b, a) == expected, "\(testCase["name"]!.string), reversed")
        }
    }

    @Test func validEntries() {
        for testCase in validation["entries"]!.array {
            #expect(Entry.isValid(testCase["entry"]!) == (testCase["valid"] == .bool(true)), "\(testCase["name"]!.string)")
        }
    }

    @Test func validDefinitions() {
        for testCase in validation["definitions"]!.array {
            #expect(Definition.isValid(testCase["definition"]!) == (testCase["valid"] == .bool(true)), "\(testCase["name"]!.string)")
        }
    }

    @Test func definitionsMergeLearnsTheCreator() {
        let local = Definition.exercise(ExerciseDefinition(id: "x-k3p9aaaaaaaaaaaa", name: "Red Rocks stairs", measure: .count, unit: "lap", createdAt: 1, updatedAt: 1))
        var server = local
        server.createdBy = "u-1"
        var definitionsByKey = [local.key: local]
        #expect(mergeDefinitions(into: &definitionsByKey, [server]) == [local.key])
        #expect(definitionsByKey[local.key]?.createdBy == "u-1")
        #expect(mergeDefinitions(into: &definitionsByKey, [server]).isEmpty)
    }
}

private func permutations<T>(_ items: [T]) -> [[T]] {
    guard items.count > 1 else { return [items] }
    return items.indices.flatMap { index in
        var rest = items
        let item = rest.remove(at: index)
        return permutations(rest).map { [item] + $0 }
    }
}
