// The composer turns a sentence into a draft of sets for you to confirm; it never logs. The model
// only names things. Picking ids is this deterministic resolver, a port of compose.ts held to it
// by test/fixtures/compose/drafts.json.

/// One line of the model's draft. `repeat` expands into that many identical sets.
public struct ComposedSet: Codable, Hashable, Sendable {
    public var exercise: String
    public var variations: [String]
    public var reps: Int?
    public var holdSeconds: Int?
    public var addedWeightLbs: Double?
    public var `repeat`: Int
    /// How long before the request's `nowMs` the set was done: 0 for now, 1440 for this time yesterday.
    public var minutesAgo: Int
}

/// An exercise the model didn't find among the known ones, described in the person's words.
public struct ComposedExercise: Codable, Hashable, Sendable {
    public var name: String
    public var measure: Measure
    public var unit: String?
    public var description: String?

    public init(name: String, measure: Measure, unit: String? = nil, description: String? = nil) {
        self.name = name
        self.measure = measure
        self.unit = unit
        self.description = description
    }
}

/// The model's output, the same shape whichever model produced it.
public struct ComposedDraft: Codable, Hashable, Sendable {
    public var sets: [ComposedSet]
    public var newExercises: [ComposedExercise]
}

public struct KnownExercise: NamedItem, Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var measure: Measure
    public var unit: String?

    public init(id: String, name: String, measure: Measure, unit: String? = nil) {
        self.id = id
        self.name = name
        self.measure = measure
        self.unit = unit
    }
}

/// POST /api/compose. Only the known exercises' names reach the model.
public struct ComposeRequest: Codable, Hashable, Sendable {
    public var text: String
    public var nowMs: Int64
    public var timeZone: String
    public var knownExercises: [KnownExercise]

    public init(text: String, nowMs: Int64, timeZone: String, knownExercises: [KnownExercise]) {
        self.text = text
        self.nowMs = nowMs
        self.timeZone = timeZone
        self.knownExercises = knownExercises
    }
}

/// `draft` is nil when the text couldn't be read as sets.
public struct ComposeResponse: Codable, Hashable, Sendable {
    public var draft: ComposedDraft?
}

public enum ComposeLimits {
    public static let maxTextLength = 1000
    public static let maxKnownExercises = 300
    /// Sets expanded from one line are this far apart, so their order survives.
    public static let draftSetSpacingMs: Int64 = 1000
}

/// A set ready to confirm. Its exercise is a known id or one of the draft's new exercises; likewise its variations.
public struct DraftItem: Codable, Hashable, Sendable {
    public var exerciseId: String?
    /// Index into ResolvedDraft.newExercises.
    public var newExerciseIndex: Int?
    public var variationIds: [String]
    /// Variations not found for this exercise, by name, to create when logging.
    public var newVariations: [String]
    public var reps: Int?
    public var holdSeconds: Int?
    public var addedWeightLbs: Double?
    public var doneAt: Int64
}

public struct ResolvedDraft: Codable, Hashable, Sendable {
    public var items: [DraftItem]
    public var newExercises: [ComposedExercise]
}

/// Resolves names to ids and expands repeats. An exercise name matches a known exercise
/// (matchName), else a new exercise in the draft by name, else becomes a new one, counted in reps
/// or timed by the set's amount. A proposed new exercise that matches a known one is dropped in
/// its favour. An amount in the wrong measure for a known exercise moves to the right one (a timed
/// exercise's "reps" are seconds). Sets of one line are a second apart, the last at its line's time.
public func resolveDraft(_ draft: ComposedDraft, known: [KnownExercise], variationsOf: (String) -> [NamedRef], nowMs: Int64) -> ResolvedDraft {
    var newExercises: [ComposedExercise] = []
    var newIndexByKey: [String: Int] = [:]
    func addNew(_ exercise: ComposedExercise) -> Int {
        let key = nameKey(exercise.name)
        if let index = newIndexByKey[key] { return index }
        newIndexByKey[key] = newExercises.count
        newExercises.append(exercise)
        return newExercises.count - 1
    }
    var proposedByKey: [String: ComposedExercise] = [:]
    for exercise in draft.newExercises { proposedByKey[nameKey(exercise.name)] = exercise }

    var items: [DraftItem] = []
    for set in draft.sets {
        var item = DraftItem(variationIds: [], newVariations: [], doneAt: 0)
        let measure: Measure
        if let match = matchName(set.exercise, in: known) {
            item.exerciseId = match.id
            measure = match.measure
        } else {
            let isTimed = set.holdSeconds != nil
            let proposal = proposedByKey[nameKey(set.exercise)] ?? ComposedExercise(name: set.exercise, measure: isTimed ? .time : .count, unit: isTimed ? nil : Catalog.ringUnit)
            item.newExerciseIndex = addNew(proposal)
            measure = proposal.measure
        }

        // A built-in exercise takes built-in variations from its own groups only, as the picker offers them.
        let groups = item.exerciseId.flatMap { Catalog.exercise($0)?.variationGroups }
        let builtIns = Catalog.variations.filter { groups?.contains($0.group) ?? true }.map { NamedRef(id: $0.id, name: $0.name) }
        let knownVariations = (item.exerciseId.map(variationsOf) ?? []) + builtIns
        for variationName in set.variations {
            if let variation = matchName(variationName, in: knownVariations) {
                item.variationIds = toggleVariation(item.variationIds, variation.id)
            } else if !item.newVariations.contains(where: { nameKey($0) == nameKey(variationName) }) {
                item.newVariations.append(variationName)
            }
        }

        let amount = set.reps ?? set.holdSeconds ?? 0
        if measure == .time { item.holdSeconds = min(EntryLimits.maxHoldSeconds, amount) } else { item.reps = amount }
        if let addedWeightLbs = set.addedWeightLbs, addedWeightLbs != 0 { item.addedWeightLbs = addedWeightLbs }

        let lastAtMs = nowMs - Int64(set.minutesAgo) * 60_000
        for i in 0..<set.repeat {
            item.doneAt = lastAtMs - Int64(set.repeat - 1 - i) * ComposeLimits.draftSetSpacingMs
            items.append(item)
        }
    }
    return ResolvedDraft(items: items, newExercises: newExercises)
}
