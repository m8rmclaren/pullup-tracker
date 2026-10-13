import Foundation
@testable import TrackerCore

/// The repo's root, found from this file, so the suite reads the same fixtures as the TypeScript one.
let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

func loadFixture(_ name: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: repoRoot.appending(path: "test/fixtures/\(name)")))
}

/// Fixture instants are ISO 8601 strings with an offset, so they read in local time; a number means epoch ms.
func instantMs(_ value: JSONValue?) -> Int64 {
    switch value {
    case .number(let number)?:
        return Int64(number)
    case .string(let string)?:
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: string) else { fatalError("unparseable fixture instant \(string)") }
        return Int64((date.timeIntervalSince1970 * 1000).rounded())
    default:
        fatalError("missing fixture instant")
    }
}

/// Fixture entries with their ISO `doneAt` turned into epoch ms.
func toEntries(_ rows: JSONValue?) throws -> [Entry] {
    guard case .array(let rows)? = rows else { return [] }
    return try rows.map { row in
        guard case .object(var fields) = row else { fatalError("fixture entry is not an object") }
        fields["doneAt"] = .number(Double(instantMs(fields["doneAt"])))
        return try JSONValue.object(fields).decoded(as: Entry.self)
    }
}

extension JSONValue {
    var array: [JSONValue] {
        if case .array(let array) = self { return array }
        return []
    }

    var object: [String: JSONValue] {
        if case .object(let object) = self { return object }
        return [:]
    }

    var string: String {
        stringValue ?? ""
    }

    var int: Int {
        if case .number(let number) = self { return Int(number) }
        return 0
    }

    var isNull: Bool {
        self == .null
    }
}

/// Where `actual` differs from `expected`. As vitest's toMatchObject when `isSubset`, else as
/// toEqual. A missing key and null are the same, since Swift omits nil; fractions compare to 9
/// places, as the fixtures' README says.
func jsonMismatches(_ actual: JSONValue, _ expected: JSONValue, isSubset: Bool = true, path: String = "") -> [String] {
    switch (actual, expected) {
    case (.number(let actualNumber), .number(let expectedNumber)):
        let isClose = expectedNumber.rounded() == expectedNumber ? actualNumber == expectedNumber : abs(actualNumber - expectedNumber) < 0.5e-9
        return isClose ? [] : ["\(path): \(actualNumber) ≠ \(expectedNumber)"]
    case (.object(let actualObject), .object(let expectedObject)):
        var found: [String] = []
        for (key, expectedValue) in expectedObject {
            found += jsonMismatches(actualObject[key] ?? .null, expectedValue, isSubset: isSubset, path: "\(path).\(key)")
        }
        if !isSubset {
            for (key, actualValue) in actualObject where expectedObject[key] == nil && actualValue != .null {
                found.append("\(path).\(key): unexpected \(actualValue)")
            }
        }
        return found
    case (.array(let actualArray), .array(let expectedArray)):
        guard actualArray.count == expectedArray.count else { return ["\(path): \(actualArray.count) items ≠ \(expectedArray.count)"] }
        return zip(actualArray, expectedArray).enumerated().flatMap { index, pair in jsonMismatches(pair.0, pair.1, isSubset: isSubset, path: "\(path)[\(index)]") }
    default:
        return actual == expected ? [] : ["\(path): \(actual) ≠ \(expected)"]
    }
}

func mismatches<T: Encodable>(_ actual: T, _ expected: JSONValue?, isSubset: Bool = true) throws -> [String] {
    jsonMismatches(try JSONValue(encoding: actual), expected ?? .null, isSubset: isSubset)
}
