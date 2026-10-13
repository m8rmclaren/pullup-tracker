import Foundation

// Leaderboards are evaluated on the client, over raw day totals the server returns. A board is a
// small spec, so a new metric, period or tiebreak ships in a client release. A port of boards.ts,
// held to it by test/fixtures/boards.json.

public enum BoardMetric: String, Codable, Hashable, Sendable, CaseIterable {
    case count, sets, bestSet, activeDays, goalPercent
}

public struct DayWindow: Codable, Hashable, Sendable {
    public var fromDay: String
    public var toDay: String

    public init(fromDay: String, toDay: String) {
        self.fromDay = fromDay
        self.toDay = toDay
    }
}

/// On the wire, a named period is a string and a fixed window is `{fromDay, toDay}`.
public enum BoardPeriod: Codable, Hashable, Sendable {
    case today
    case week
    case month
    case window(DayWindow)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let name = try? container.decode(String.self) {
            switch name {
            case "today": self = .today
            case "week": self = .week
            case "month": self = .month
            default: throw DecodingError.dataCorruptedError(in: container, debugDescription: "unknown board period \(name)")
            }
        } else {
            self = .window(try container.decode(DayWindow.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .today: try container.encode("today")
        case .week: try container.encode("week")
        case .month: try container.encode("month")
        case .window(let window): try container.encode(window)
        }
    }
}

public struct BoardSpec: Codable, Hashable, Sendable {
    public var metric: BoardMetric
    /// Nil: across exercises, which for count and bestSet means the ring (rep-unit sets).
    public var exerciseId: String?
    public var period: BoardPeriod

    public init(metric: BoardMetric, exerciseId: String? = nil, period: BoardPeriod) {
        self.metric = metric
        self.exerciseId = exerciseId
        self.period = period
    }
}

/// A stored day total as the server returns it; one written before v2 lacks holdSeconds and byExercise.
public struct BoardDay: Codable, Hashable, Sendable {
    public var day: String
    public var reps: Int
    public var sets: Int
    public var bestSetReps: Int
    public var holdSeconds: Int?
    public var byExercise: [String: ExerciseDayTotal]?

    public init(day: String, reps: Int, sets: Int, bestSetReps: Int, holdSeconds: Int? = nil, byExercise: [String: ExerciseDayTotal]? = nil) {
        self.day = day
        self.reps = reps
        self.sets = sets
        self.bestSetReps = bestSetReps
        self.holdSeconds = holdSeconds
        self.byExercise = byExercise
    }

    /// Per-exercise totals. A total written before v2 has no byExercise and was all pull-ups.
    public var exerciseTotals: [String: ExerciseDayTotal] {
        if let byExercise { return byExercise }
        return sets > 0 ? [Catalog.pullUp: ExerciseDayTotal(sets: sets, reps: reps, bestSetReps: bestSetReps)] : [:]
    }
}

public struct BoardMember: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var timeZone: String
    /// Nil until the member sets one; goalPercent has no value for them.
    public var dailyGoalReps: Int?
    public var days: [BoardDay]

    public init(id: String, name: String, timeZone: String, dailyGoalReps: Int? = nil, days: [BoardDay]) {
        self.id = id
        self.name = name
        self.timeZone = timeZone
        self.dailyGoalReps = dailyGoalReps
        self.days = days
    }
}

public struct BoardRow: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    /// Nil where the metric has no value for this member (goalPercent without a goal).
    public var value: Double?
    /// Shared by members tied on value and tiebreak (1, 1, 3); nil with no value.
    public var rank: Int?
}

extension BoardPeriod {
    /// The days this period covers for one member, in their own zone: weeks start Monday, and open periods end today.
    public func window(nowMs: Int64, calendar: DayCalendar) -> DayWindow {
        let today = calendar.dayKey(at: nowMs)
        switch self {
        case .window(let window): return window
        case .today: return DayWindow(fromDay: today, toDay: today)
        case .week: return DayWindow(fromDay: DayKey.startOfWeek(today), toDay: today)
        case .month: return DayWindow(fromDay: "\(today.prefix(7))-01", toDay: today)
        }
    }

    /// The widest window any member's period could need, for asking the server: zones put todays up to two dates apart.
    public func requestWindow(nowMs: Int64, calendar: DayCalendar) -> DayWindow {
        if case .window(let window) = self { return window }
        let window = window(nowMs: nowMs, calendar: calendar)
        return DayWindow(fromDay: DayKey.adding(-2, to: window.fromDay), toDay: DayKey.adding(2, to: window.toDay))
    }
}

/// count across a member's days in the window: the exercise's own unit, or ring reps across exercises.
private func count(in days: [BoardDay], exerciseId: String?) -> Int {
    days.reduce(0) { total, day in
        guard let exerciseId else { return total + day.reps }
        let share = day.exerciseTotals[exerciseId]
        return total + (share?.reps ?? 0) + (share?.holdSeconds ?? 0)
    }
}

private func sets(of day: BoardDay, exerciseId: String?) -> Int {
    guard let exerciseId else { return day.sets }
    return day.exerciseTotals[exerciseId]?.sets ?? 0
}

private func metricValue(_ metric: BoardMetric, exerciseId: String?, days: [BoardDay], member: BoardMember, window: DayWindow, nowMs: Int64) -> Double? {
    switch metric {
    case .count:
        return Double(count(in: days, exerciseId: exerciseId))
    case .sets:
        return Double(days.reduce(0) { $0 + sets(of: $1, exerciseId: exerciseId) })
    case .bestSet:
        return Double(days.reduce(0) { best, day in
            guard let exerciseId else { return max(best, day.bestSetReps) }
            let share = day.exerciseTotals[exerciseId]
            return max(best, share?.bestSetReps ?? share?.bestHoldSeconds ?? 0)
        })
    case .activeDays:
        return Double(days.filter { sets(of: $0, exerciseId: exerciseId) > 0 }.count)
    case .goalPercent:
        // Against the ring goal whatever the exercise: the goal is a ring number.
        guard let goal = member.dailyGoalReps, goal != 0 else { return nil }
        let memberToday = DayCalendar(accountZone: member.timeZone).dayKey(at: nowMs)
        let lastDay = min(window.toDay, memberToday)
        let elapsedDays = max(1, DayKey.daysBetween(window.fromDay, lastDay) + 1)
        return 100 * Double(count(in: days, exerciseId: nil)) / Double(goal * elapsedDays)
    }
}

private func days(of member: BoardMember, in window: DayWindow) -> [BoardDay] {
    member.days.filter { $0.day >= window.fromDay && $0.day <= window.toDay }
}

/// JavaScript's `localeCompare` for display names, so rows tied on everything list in the same order on every client.
private func localeOrder(_ a: String, _ b: String) -> ComparisonResult {
    a.compare(b, locale: Locale(identifier: "en"))
}

/// Ranks members by the spec's metric over each one's own period. Higher is better. Ties on the
/// value break by count (except for count itself); members still tied share a rank and are listed
/// by name, then id. A member without a value is listed last, unranked.
public func evaluateBoard(_ spec: BoardSpec, members: [BoardMember], nowMs: Int64) -> [BoardRow] {
    struct Scored {
        let member: BoardMember
        let value: Double?
        let tiebreak: Int
    }
    let scored = members.map { member in
        let window = spec.period.window(nowMs: nowMs, calendar: DayCalendar(accountZone: member.timeZone))
        let memberDays = days(of: member, in: window)
        return Scored(
            member: member,
            value: metricValue(spec.metric, exerciseId: spec.exerciseId, days: memberDays, member: member, window: window, nowMs: nowMs),
            tiebreak: spec.metric == .count ? 0 : count(in: memberDays, exerciseId: spec.exerciseId)
        )
    }.sorted { a, b in
        if (a.value == nil) != (b.value == nil) { return b.value == nil }
        if a.value != b.value { return a.value! > b.value! }
        if a.tiebreak != b.tiebreak { return a.tiebreak > b.tiebreak }
        let nameOrder = localeOrder(a.member.name, b.member.name)
        if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
        return utf16Precedes(a.member.id, b.member.id)
    }
    var rank = 0
    return scored.enumerated().map { index, row in
        let previous = index > 0 ? scored[index - 1] : nil
        if row.value != nil && !(previous != nil && previous!.value == row.value && previous!.tiebreak == row.tiebreak) { rank = index + 1 }
        return BoardRow(id: row.member.id, name: row.member.name, value: row.value, rank: row.value == nil ? nil : rank)
    }
}

/// A challenge's collective number: every member's count of its exercise over its window, summed.
public func groupTotal(exerciseId: String, window: DayWindow, members: [BoardMember]) -> Int {
    members.reduce(0) { $0 + count(in: days(of: $1, in: window), exerciseId: exerciseId) }
}

/// One member's day on a challenge board, cut down on the server to the challenge's exercise.
public struct ChallengeDay: Codable, Hashable, Sendable {
    public var day: String
    public var sets: Int
    public var reps: Int?
    public var bestSetReps: Int?
    public var holdSeconds: Int?
    public var bestHoldSeconds: Int?
    public var bestAddedWeightLbs: Double?

    var exerciseTotal: ExerciseDayTotal {
        ExerciseDayTotal(sets: sets, reps: reps, bestSetReps: bestSetReps, holdSeconds: holdSeconds, bestHoldSeconds: bestHoldSeconds, bestAddedWeightLbs: bestAddedWeightLbs)
    }
}

/// A challenge board's members as board members. The server sends each member's days already cut
/// down to the challenge's exercise, with no zone or goal, which is all a fixed window needs.
public func challengeBoardMembers(exerciseId: String, members: [(id: String, name: String, days: [ChallengeDay])]) -> [BoardMember] {
    members.map { member in
        BoardMember(
            id: member.id,
            name: member.name,
            timeZone: "UTC",
            days: member.days.map { BoardDay(day: $0.day, reps: 0, sets: $0.sets, bestSetReps: 0, byExercise: [exerciseId: $0.exerciseTotal]) }
        )
    }
}
