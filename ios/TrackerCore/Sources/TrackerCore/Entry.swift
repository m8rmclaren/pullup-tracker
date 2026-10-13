// The data model is a state-based CRDT: a map of entries keyed by id, where each entry is a
// last-writer-wins register and deletes are tombstones. A port of src/shared/model.ts, held to
// the same results by test/fixtures/merge.json and validation.json.

public struct Entry: Hashable, Sendable, Codable {
    public var id: String
    /// When the set was done (epoch ms). Decides which day, in the user's zone, it counts toward.
    public var doneAt: Int64
    /// A built-in slug or a created `x-` id. Nil means pull-up, which normalization enforces.
    public var exerciseId: String?
    /// Built-in slugs or created `v-` ids, unique and sorted. Nil means none.
    public var variationIds: [String]?
    /// The count in the exercise's unit (reps, laps, steps). Exactly one of reps and holdSeconds is present.
    public var reps: Int?
    public var holdSeconds: Int?
    /// Added weight in lb (belt, vest, dumbbell). Nil means bodyweight.
    public var addedWeightLbs: Double?
    /// When this version was written (epoch ms). The LWW clock.
    public var updatedAt: Int64
    public var isDeleted: Bool

    public init(id: String, doneAt: Int64, exerciseId: String? = nil, variationIds: [String]? = nil, reps: Int? = nil, holdSeconds: Int? = nil, addedWeightLbs: Double? = nil, updatedAt: Int64, isDeleted: Bool = false) {
        self.id = id
        self.doneAt = doneAt
        self.exerciseId = exerciseId
        self.variationIds = variationIds
        self.reps = reps
        self.holdSeconds = holdSeconds
        self.addedWeightLbs = addedWeightLbs
        self.updatedAt = updatedAt
        self.isDeleted = isDeleted
    }

    private enum CodingKeys: String, CodingKey {
        case id, doneAt, exerciseId, variationIds, reps, holdSeconds, addedWeightLbs, updatedAt
        case isDeleted = "deleted"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        doneAt = try container.decode(Int64.self, forKey: .doneAt)
        exerciseId = try container.decodeIfPresent(String.self, forKey: .exerciseId)
        variationIds = try container.decodeIfPresent([String].self, forKey: .variationIds)
        reps = try container.decodeIfPresent(Int.self, forKey: .reps)
        holdSeconds = try container.decodeIfPresent(Int.self, forKey: .holdSeconds)
        addedWeightLbs = try container.decodeIfPresent(Double.self, forKey: .addedWeightLbs)
        updatedAt = try container.decode(Int64.self, forKey: .updatedAt)
        isDeleted = try container.decodeIfPresent(Bool.self, forKey: .isDeleted) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(doneAt, forKey: .doneAt)
        try container.encodeIfPresent(exerciseId, forKey: .exerciseId)
        try container.encodeIfPresent(variationIds, forKey: .variationIds)
        try container.encodeIfPresent(reps, forKey: .reps)
        try container.encodeIfPresent(holdSeconds, forKey: .holdSeconds)
        try container.encodeIfPresent(addedWeightLbs, forKey: .addedWeightLbs)
        try container.encode(updatedAt, forKey: .updatedAt)
        if isDeleted { try container.encode(true, forKey: .isDeleted) }
    }
}

public enum EntryLimits {
    public static let minReps = 1
    public static let maxReps = 100_000
    public static let minHoldSeconds = 1
    public static let maxHoldSeconds = 86_400
    public static let maxVariations = 6
    public static let maxAddedWeightLbs: Double = 300
    /// Smallest weight increment: half a pound, so 2.5 lb plates and kg conversions fit.
    public static let addedWeightStepLbs = 0.5
    public static let maxPushedEntries = 1000
}

extension Entry {
    public var resolvedExerciseId: String { exerciseId ?? Catalog.pullUp }

    /// A set's amount in its exercise's own unit: the count, or seconds for a hold.
    public var amount: Int { reps ?? holdSeconds ?? 0 }

    private var variationKey: String { (variationIds ?? []).joined(separator: ",") }

    /// Total order over versions of one entry; returns the winner. Each step only runs on a tie in
    /// every step before it, and fields old entries lack compare as their defaults.
    public static func pickWinner(_ a: Entry, _ b: Entry) -> Entry {
        if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt ? a : b }
        // Same clock tick on two devices: break the tie deterministically, preferring delete.
        if a.isDeleted != b.isDeleted { return a.isDeleted ? a : b }
        if (a.reps ?? 0) != (b.reps ?? 0) { return (a.reps ?? 0) > (b.reps ?? 0) ? a : b }
        if (a.holdSeconds ?? 0) != (b.holdSeconds ?? 0) { return (a.holdSeconds ?? 0) > (b.holdSeconds ?? 0) ? a : b }
        if (a.addedWeightLbs ?? 0) != (b.addedWeightLbs ?? 0) { return (a.addedWeightLbs ?? 0) > (b.addedWeightLbs ?? 0) ? a : b }
        if a.resolvedExerciseId != b.resolvedExerciseId { return utf16Precedes(b.resolvedExerciseId, a.resolvedExerciseId) ? a : b }
        if a.variationKey != b.variationKey { return utf16Precedes(b.variationKey, a.variationKey) ? a : b }
        return a.doneAt >= b.doneAt ? a : b
    }

    public static func isSameVersion(_ a: Entry, _ b: Entry) -> Bool {
        a.updatedAt == b.updatedAt
            && a.isDeleted == b.isDeleted
            && (a.reps ?? 0) == (b.reps ?? 0)
            && (a.holdSeconds ?? 0) == (b.holdSeconds ?? 0)
            && (a.addedWeightLbs ?? 0) == (b.addedWeightLbs ?? 0)
            && a.resolvedExerciseId == b.resolvedExerciseId
            && a.variationKey == b.variationKey
            && a.doneAt == b.doneAt
    }

    /// Drops default-valued fields so stored and compared versions have one shape.
    public func normalized() -> Entry {
        Entry(
            id: id,
            doneAt: doneAt,
            exerciseId: exerciseId == Catalog.pullUp || exerciseId?.isEmpty == true ? nil : exerciseId,
            variationIds: variationIds.flatMap { $0.isEmpty ? nil : $0.sorted(by: utf16Precedes) },
            reps: reps,
            holdSeconds: holdSeconds,
            addedWeightLbs: addedWeightLbs == 0 ? nil : addedWeightLbs,
            updatedAt: updatedAt,
            isDeleted: isDeleted
        )
    }
}

/// Merges `incoming` into `entriesById` in place. Returns the ids whose stored version changed.
@discardableResult
public func mergeEntries(into entriesById: inout [String: Entry], _ incoming: some Sequence<Entry>) -> [String] {
    var changedIds: [String] = []
    for entry in incoming {
        guard let stored = entriesById[entry.id] else {
            entriesById[entry.id] = entry.normalized()
            changedIds.append(entry.id)
            continue
        }
        let winner = Entry.pickWinner(stored, entry)
        if !Entry.isSameVersion(winner, stored) {
            entriesById[entry.id] = winner.normalized()
            changedIds.append(entry.id)
        }
    }
    return changedIds
}

/// Rounds to the nearest step and clamps; 0 means bodyweight.
public func clampAddedWeight(_ addedWeightLbs: Double) -> Double {
    guard addedWeightLbs.isFinite else { return 0 }
    let step = EntryLimits.addedWeightStepLbs
    // JavaScript's Math.round rounds halves up, toward +∞.
    let rounded = (addedWeightLbs / step + 0.5).rounded(.down) * step
    return min(EntryLimits.maxAddedWeightLbs, max(0, rounded))
}

/// "+25 lb", or "" for bodyweight.
public func formatAddedWeight(_ addedWeightLbs: Double?) -> String {
    guard let addedWeightLbs, addedWeightLbs != 0 else { return "" }
    return "+\(formatNumber(addedWeightLbs)) lb"
}

/// A number as JavaScript prints it: no ".0" on whole numbers.
func formatNumber(_ value: Double) -> String {
    value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
}

// MARK: - Validation

extension Entry {
    /// Shape checks, plus what the bundled catalog can decide: a built-in exercise must exist and
    /// match the entry's measure, and built-in variations are at most one per group. Whether a
    /// created exercise's measure matches needs its definition, so the server checks that.
    public static func isValid(_ value: JSONValue) -> Bool {
        guard case .object(let fields) = value else { return false }
        guard let id = fields["id"]?.stringValue, !id.isEmpty, id.utf16.count <= 64, id.utf8.allSatisfy(isIdByte) else { return false }
        guard let doneAt = fields["doneAt"]?.safeInteger, doneAt > 0 else { return false }
        guard let updatedAt = fields["updatedAt"]?.safeInteger, updatedAt > 0 else { return false }
        let reps = fields["reps"]
        let holdSeconds = fields["holdSeconds"]
        if (reps == nil) == (holdSeconds == nil) { return false }
        if let reps, !isInteger(reps, between: EntryLimits.minReps, and: EntryLimits.maxReps) { return false }
        if let holdSeconds, !isInteger(holdSeconds, between: EntryLimits.minHoldSeconds, and: EntryLimits.maxHoldSeconds) { return false }
        if let addedWeight = fields["addedWeightLbs"], !isValidAddedWeight(addedWeight) { return false }
        if let deleted = fields["deleted"] {
            guard case .bool = deleted else { return false }
        }

        let exerciseId: String
        switch fields["exerciseId"] {
        case nil, .null?: exerciseId = Catalog.pullUp
        case .string(let string)?: exerciseId = string
        default: return false
        }
        if !Catalog.isCreatedExerciseId(exerciseId) {
            guard Catalog.isBuiltInId(exerciseId), let exercise = Catalog.exercise(exerciseId) else { return false }
            if (exercise.measure == .time) != (holdSeconds != nil) { return false }
        }
        guard let variationIds = fields["variationIds"] else { return true }
        return isValidVariationIds(variationIds)
    }

    private static func isIdByte(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "_"), UInt8(ascii: "-"): true
        default: false
        }
    }

    private static func isValidVariationIds(_ value: JSONValue) -> Bool {
        guard case .array(let values) = value, values.count <= EntryLimits.maxVariations, Set(values).count == values.count else { return false }
        var builtInGroups = Set<String>()
        for value in values {
            guard let id = value.stringValue else { return false }
            if Catalog.isCreatedVariationId(id) { continue }
            guard Catalog.isBuiltInId(id), let variation = Catalog.variation(id), !builtInGroups.contains(variation.group) else { return false }
            builtInGroups.insert(variation.group)
        }
        return true
    }

    private static func isValidAddedWeight(_ value: JSONValue) -> Bool {
        guard case .number(let weight) = value, weight > 0, weight <= EntryLimits.maxAddedWeightLbs else { return false }
        let steps = weight / EntryLimits.addedWeightStepLbs
        return steps.rounded() == steps
    }
}

func isInteger(_ value: JSONValue, between minimum: Int, and maximum: Int) -> Bool {
    guard let integer = value.safeInteger else { return false }
    return integer >= minimum && integer <= maximum
}
