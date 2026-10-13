// What the Today pad offers, derived from history: the exercise and configuration to prefill,
// the counts around your usual, and past sessions to repeat. A port of pad.ts.

/// An exercise and its configuration: what a set is of, apart from its amount.
public struct SetContext: Hashable, Sendable, Codable {
    public var exerciseId: String
    /// Unique and sorted, as entries store them.
    public var variationIds: [String]

    public init(exerciseId: String, variationIds: [String] = []) {
        self.exerciseId = exerciseId
        self.variationIds = variationIds
    }
}

/// One set to log, without an id or a time: a repeat, a queue item, a composed draft.
public struct SetTemplate: Hashable, Sendable, Codable {
    public var context: SetContext
    public var reps: Int?
    public var holdSeconds: Int?
    public var addedWeightLbs: Double?

    public init(context: SetContext, reps: Int? = nil, holdSeconds: Int? = nil, addedWeightLbs: Double? = nil) {
        self.context = context
        self.reps = reps
        self.holdSeconds = holdSeconds
        self.addedWeightLbs = addedWeightLbs
    }
}

public enum Pad {
    /// A gap this long or longer starts a new session, so there is no "start workout" to forget.
    public static let sessionGapMs: Int64 = 90 * 60_000
    public static let size = 6
    static let usualWindowDays = 30
    /// Quick durations a timed pad picks six from, around your usual hold.
    public static let holdStepsSeconds = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1200, 1800, 3600]
}

private func isNewerFirst(_ a: Entry, _ b: Entry) -> Bool {
    a.doneAt != b.doneAt ? a.doneAt > b.doneAt : utf16Precedes(b.id, a.id)
}

private func liveNewestFirst(_ entries: some Sequence<Entry>) -> [Entry] {
    entries.filter { !$0.isDeleted }.sorted(by: isNewerFirst)
}

extension Entry {
    public var context: SetContext { SetContext(exerciseId: resolvedExerciseId, variationIds: variationIds ?? []) }

    public var template: SetTemplate {
        SetTemplate(context: context, reps: reps, holdSeconds: holdSeconds, addedWeightLbs: addedWeightLbs == 0 ? nil : addedWeightLbs)
    }
}

/// The most recently done live set, which "Repeat last set" copies; nil with no history.
public func lastSet(_ entries: some Sequence<Entry>) -> Entry? {
    entries.filter { !$0.isDeleted }.min(by: isNewerFirst)
}

/// Exercises by most recent use, newest first, without repeats.
public func recentExerciseIds(_ entries: some Sequence<Entry>, limit: Int) -> [String] {
    var exerciseIds: [String] = []
    for entry in liveNewestFirst(entries) where !exerciseIds.contains(entry.resolvedExerciseId) {
        exerciseIds.append(entry.resolvedExerciseId)
        if exerciseIds.count == limit { break }
    }
    return exerciseIds
}

/// Variations you've used with an exercise, most recent first, without repeats.
public func recentVariationIds(_ entries: some Sequence<Entry>, exerciseId: String, limit: Int) -> [String] {
    var variationIds: [String] = []
    for entry in liveNewestFirst(entries) where entry.resolvedExerciseId == exerciseId {
        for variationId in entry.variationIds ?? [] where !variationIds.contains(variationId) {
            variationIds.append(variationId)
        }
        if variationIds.count >= limit { break }
    }
    return Array(variationIds.prefix(limit))
}

/// The context of your most recent set of this exercise: what picking it prefills.
public func lastContext(for exerciseId: String, in entries: some Sequence<Entry>) -> SetContext {
    liveNewestFirst(entries).first { $0.resolvedExerciseId == exerciseId }?.context ?? SetContext(exerciseId: exerciseId)
}

/// Turns a variation on or off. A built-in variation is at most one per group, so turning one on
/// turns off any other from its group. Created variations have no group. A set holds at most
/// maxVariations, so turning on one more past that changes nothing.
public func toggleVariation(_ variationIds: [String], _ variationId: String) -> [String] {
    if variationIds.contains(variationId) { return variationIds.filter { $0 != variationId } }
    let group = Catalog.isCreatedVariationId(variationId) ? nil : Catalog.variation(variationId)?.group
    let kept = group.map { group in variationIds.filter { Catalog.isCreatedVariationId($0) || Catalog.variation($0)?.group != group } } ?? variationIds
    if kept.count >= EntryLimits.maxVariations { return variationIds }
    return (kept + [variationId]).sorted(by: utf16Precedes)
}

/// The amount logged most often for this context in the last 30 days (reps, or seconds for a
/// hold), ties to the larger. Falls back to the exercise with any configuration, then nil.
public func usualAmount(_ entries: some Sequence<Entry>, context: SetContext, nowMs: Int64, calendar: DayCalendar) -> Int? {
    let cutoff = DayKey.adding(-(Pad.usualWindowDays - 1), to: calendar.dayKey(at: nowMs))
    let sameExercise = entries.filter { !$0.isDeleted && $0.resolvedExerciseId == context.exerciseId && calendar.dayKey(at: $0.doneAt) >= cutoff }
    func countsByAmount(_ entries: [Entry]) -> [Int: Int] {
        entries.reduce(into: [:]) { $0[$1.amount, default: 0] += 1 }
    }
    return mostCommon(countsByAmount(sameExercise.filter { $0.context == context })) ?? mostCommon(countsByAmount(sameExercise))
}

/// Six counts around your usual: two below and three above, never below 1. With no usual, a
/// rep-counted exercise starts at 3 and anything else at 1.
public func padCounts(usual: Int?, unit: String?) -> [Int] {
    let start = usual.map { max(1, $0 - 2) } ?? (unit == Catalog.ringUnit ? 3 : 1)
    return Array(start..<(start + Pad.size))
}

/// Six quick durations around your usual hold, from Pad.holdStepsSeconds. With no usual, 10s to 60s.
public func padHoldSeconds(usual: Int?) -> [Int] {
    let steps = Pad.holdStepsSeconds
    let target = usual ?? 20
    var nearest = 0
    for i in steps.indices where abs(steps[i] - target) < abs(steps[nearest] - target) {
        nearest = i
    }
    let start = min(max(0, nearest - 2), steps.count - Pad.size)
    var offered = Array(steps[start..<(start + Pad.size)])
    // A usual between steps (say 40s) is offered as itself.
    if let usual, !offered.contains(usual) { offered[min(2, Pad.size - 1)] = usual }
    return offered.sorted()
}

public struct Session: Hashable, Sendable {
    /// The first set's doneAt, which also identifies the session.
    public var startMs: Int64
    public var endMs: Int64
    /// Oldest first, the order a repeat walks them.
    public var entries: [Entry]
}

/// Live sets grouped into sessions, newest session first.
public func sessions(of entries: some Sequence<Entry>) -> [Session] {
    var sessions: [Session] = []
    for entry in liveNewestFirst(entries).reversed() {
        if let last = sessions.indices.last, entry.doneAt - sessions[last].endMs < Pad.sessionGapMs {
            sessions[last].entries.append(entry)
            sessions[last].endMs = entry.doneAt
        } else {
            sessions.append(Session(startMs: entry.doneAt, endMs: entry.doneAt, entries: [entry]))
        }
    }
    return sessions.reversed()
}

/// Past sessions worth offering as a repeat, newest first: more than one set, and over (the
/// last set is at least a session gap ago, so it isn't the one you're in).
public func repeatableSessions(_ entries: some Sequence<Entry>, nowMs: Int64, limit: Int) -> [Session] {
    Array(sessions(of: entries).filter { $0.entries.count > 1 && nowMs - $0.endMs >= Pad.sessionGapMs }.prefix(limit))
}
