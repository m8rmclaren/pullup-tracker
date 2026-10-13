// Exercises and variations anyone can create. Ids are made on the client, so a definition can
// be created offline and logged to at once; it travels in the sync push like an entry. Name and
// description are last-writer-wins on updatedAt; everything else is fixed at creation, because
// changing it would change the meaning of every set already logged. A port of definitions.ts.

public struct ExerciseDefinition: Hashable, Sendable, Codable {
    public var id: String
    public var name: String
    public var measure: Measure
    /// What one count is ("lap", "rep"). Present exactly when measure is count.
    public var unit: String?
    public var description: String?
    /// Stamped by the server from the creator's account; nil until the first sync, and after the creator deletes their account.
    public var createdBy: String?
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(id: String, name: String, measure: Measure, unit: String? = nil, description: String? = nil, createdBy: String? = nil, createdAt: Int64, updatedAt: Int64) {
        self.id = id
        self.name = name
        self.measure = measure
        self.unit = unit
        self.description = description
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// Belongs to one exercise, built-in or created, and has no group.
public struct VariationDefinition: Hashable, Sendable, Codable {
    public var id: String
    public var exerciseId: String
    public var name: String
    public var createdBy: String?
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(id: String, exerciseId: String, name: String, createdBy: String? = nil, createdAt: Int64, updatedAt: Int64) {
        self.id = id
        self.exerciseId = exerciseId
        self.name = name
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// One shape on the wire; the id's prefix says which kind it is.
public enum Definition: Hashable, Sendable, Codable {
    case exercise(ExerciseDefinition)
    case variation(VariationDefinition)

    public init(from decoder: Decoder) throws {
        let id = try decoder.container(keyedBy: IdKey.self).decode(String.self, forKey: .id)
        self = Catalog.isCreatedVariationId(id) ? .variation(try VariationDefinition(from: decoder)) : .exercise(try ExerciseDefinition(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .exercise(let exercise): try exercise.encode(to: encoder)
        case .variation(let variation): try variation.encode(to: encoder)
        }
    }

    private enum IdKey: String, CodingKey { case id }

    public var id: String {
        switch self {
        case .exercise(let exercise): exercise.id
        case .variation(let variation): variation.id
        }
    }

    public var name: String {
        switch self {
        case .exercise(let exercise): exercise.name
        case .variation(let variation): variation.name
        }
    }

    public var updatedAt: Int64 {
        switch self {
        case .exercise(let exercise): exercise.updatedAt
        case .variation(let variation): variation.updatedAt
        }
    }

    public var createdBy: String? {
        get {
            switch self {
            case .exercise(let exercise): exercise.createdBy
            case .variation(let variation): variation.createdBy
            }
        }
        set {
            switch self {
            case .exercise(var exercise):
                exercise.createdBy = newValue
                self = .exercise(exercise)
            case .variation(var variation):
                variation.createdBy = newValue
                self = .variation(variation)
            }
        }
    }

    private var descriptionText: String {
        if case .exercise(let exercise) = self { return exercise.description ?? "" }
        return ""
    }

    /// Where a definition is stored: a variation is only unique within its exercise, so both ids are in its key.
    public var key: String {
        switch self {
        case .exercise(let exercise): exercise.id
        case .variation(let variation): "\(variation.exerciseId)/\(variation.id)"
        }
    }

    /// Total order over versions of one definition, as Entry.pickWinner is for entries.
    public static func pickWinner(_ a: Definition, _ b: Definition) -> Definition {
        if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt ? a : b }
        if a.name != b.name { return utf16Precedes(b.name, a.name) ? a : b }
        return !utf16Precedes(a.descriptionText, b.descriptionText) ? a : b
    }

    /// Same editable state; the fixed fields never differ between versions that are both accepted.
    public static func isSameVersion(_ a: Definition, _ b: Definition) -> Bool {
        a.updatedAt == b.updatedAt && a.name == b.name && a.descriptionText == b.descriptionText
    }

    /// Drops empty optional fields so stored and compared versions have one shape.
    public func normalized() -> Definition {
        switch self {
        case .exercise(var exercise):
            if exercise.unit?.isEmpty == true { exercise.unit = nil }
            if exercise.description?.isEmpty == true { exercise.description = nil }
            if exercise.createdBy?.isEmpty == true { exercise.createdBy = nil }
            return .exercise(exercise)
        case .variation(var variation):
            if variation.createdBy?.isEmpty == true { variation.createdBy = nil }
            return .variation(variation)
        }
    }
}

public enum DefinitionLimits {
    public static let maxNameLength = 60
    public static let maxUnitLength = 20
    public static let maxDescriptionLength = 280
    public static let maxPushedDefinitions = 100
}

/// Merges into `definitionsByKey` (keyed by Definition.key) in place. Returns the keys whose stored version changed.
@discardableResult
public func mergeDefinitions(into definitionsByKey: inout [String: Definition], _ incoming: some Sequence<Definition>) -> [String] {
    var changedKeys: [String] = []
    for definition in incoming {
        let key = definition.key
        guard let stored = definitionsByKey[key] else {
            definitionsByKey[key] = definition.normalized()
            changedKeys.append(key)
            continue
        }
        let winner = Definition.pickWinner(stored, definition)
        let isStoredKept = Definition.isSameVersion(winner, stored)
        // A definition made on this device learns its creator from the server's copy.
        let createdBy = stored.createdBy ?? definition.createdBy
        if isStoredKept && stored.createdBy == createdBy { continue }
        var next = isStoredKept ? stored : winner
        next.createdBy = createdBy
        definitionsByKey[key] = next.normalized()
        changedKeys.append(key)
    }
    return changedKeys
}

extension Definition {
    /// Shape only. Whether the pusher may change it is the server's call. `createdBy` is ignored; the server stamps it.
    public static func isValid(_ value: JSONValue) -> Bool {
        guard case .object(let fields) = value else { return false }
        guard let id = fields["id"]?.stringValue, let createdAt = fields["createdAt"]?.safeInteger, createdAt > 0, let updatedAt = fields["updatedAt"]?.safeInteger, updatedAt > 0 else { return false }
        guard let name = fields["name"]?.stringValue, isCleanText(name, maxLength: DefinitionLimits.maxNameLength) else { return false }
        if let createdBy = fields["createdBy"], createdBy.stringValue == nil { return false }

        if Catalog.isCreatedVariationId(id) {
            guard let exerciseId = fields["exerciseId"]?.stringValue else { return false }
            return Catalog.isCreatedExerciseId(exerciseId) || (Catalog.isBuiltInId(exerciseId) && Catalog.exercise(exerciseId) != nil)
        }
        guard Catalog.isCreatedExerciseId(id) else { return false }
        switch fields["measure"] {
        case .string("count")?:
            guard let unit = fields["unit"]?.stringValue, isCleanText(unit, maxLength: DefinitionLimits.maxUnitLength) else { return false }
        case .string("time")?:
            if fields["unit"] != nil { return false }
        default:
            return false
        }
        guard let description = fields["description"] else { return true }
        return description.stringValue.map { isCleanText($0, maxLength: DefinitionLimits.maxDescriptionLength) } ?? false
    }
}
