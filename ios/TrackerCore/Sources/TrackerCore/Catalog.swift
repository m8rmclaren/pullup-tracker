import Foundation

public enum Measure: String, Codable, Hashable, Sendable {
    case count
    case time
}

public struct BuiltInExercise: Codable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let measure: Measure
    /// What one count is ("rep", "lap"); nil for timed exercises.
    public let unit: String?
    public let variationGroups: [String]
}

public struct BuiltInVariation: Codable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let group: String
}

/// The built-in exercises and variations, from the copy of `src/shared/catalog.json` bundled with the package.
public enum Catalog {
    public static let pullUp = "pull-up"
    /// The unit whose counts go on the ring.
    public static let ringUnit = "rep"

    private struct File: Decodable {
        let exercises: [BuiltInExercise]
        let variations: [BuiltInVariation]
    }

    private static let file: File = {
        guard let url = Bundle.module.url(forResource: "catalog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(File.self, from: data)
        else { fatalError("the bundled catalog.json is missing or malformed") }
        return file
    }()

    private static let exercisesById = Dictionary(uniqueKeysWithValues: file.exercises.map { ($0.id, $0) })
    private static let variationsById = Dictionary(uniqueKeysWithValues: file.variations.map { ($0.id, $0) })

    public static var exercises: [BuiltInExercise] { file.exercises }
    public static var variations: [BuiltInVariation] { file.variations }

    public static func exercise(_ id: String) -> BuiltInExercise? { exercisesById[id] }
    public static func variation(_ id: String) -> BuiltInVariation? { variationsById[id] }

    // Created ids are random lowercase base32, and no built-in slug starts with "x-" or "v-", so
    // the prefix alone says which kind an id is.

    public static func isCreatedExerciseId(_ id: String) -> Bool { isCreatedId(id, prefix: "x-") }
    public static func isCreatedVariationId(_ id: String) -> Bool { isCreatedId(id, prefix: "v-") }

    public static func isBuiltInId(_ id: String) -> Bool {
        let bytes = Array(id.utf8)
        guard (1...40).contains(bytes.count), !id.hasPrefix("x-"), !id.hasPrefix("v-") else { return false }
        return bytes.allSatisfy { isLowercaseLetter($0) || isDigit($0) || $0 == UInt8(ascii: "-") }
    }

    private static func isCreatedId(_ id: String, prefix: String) -> Bool {
        let bytes = Array(id.utf8)
        guard bytes.count == 18, id.hasPrefix(prefix) else { return false }
        return bytes.dropFirst(2).allSatisfy { isLowercaseLetter($0) || (UInt8(ascii: "2")...UInt8(ascii: "7")).contains($0) }
    }

    private static func isLowercaseLetter(_ byte: UInt8) -> Bool { (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) }
    private static func isDigit(_ byte: UInt8) -> Bool { (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) }
}
