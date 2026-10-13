// A port of stats.ts, held to it by test/fixtures/stats.json, including the v1 golden history.

/// An exercise's unit if it is counted, nil if it is timed or unknown.
public typealias UnitLookup = (String) -> String?

public func builtInUnit(_ exerciseId: String) -> String? { Catalog.exercise(exerciseId)?.unit }

extension Entry {
    /// A live counted set in an exercise whose unit is "rep": what the ring and its stats sum.
    public func isRingEntry(unitOf: UnitLookup = builtInUnit) -> Bool {
        !isDeleted && reps != nil && unitOf(resolvedExerciseId) == Catalog.ringUnit
    }

    var isLivePullUp: Bool { !isDeleted && reps != nil && resolvedExerciseId == Catalog.pullUp }
}

public struct DayTotal: Hashable, Sendable, Codable {
    public var day: String
    public var reps: Int
    public var sets: Int

    public init(day: String, reps: Int = 0, sets: Int = 0) {
        self.day = day
        self.reps = reps
        self.sets = sets
    }
}

public func liveEntries(_ entries: some Sequence<Entry>) -> [Entry] {
    entries.filter { !$0.isDeleted }
}

/// Ring reps and sets per day.
public func dailyTotals(_ entries: some Sequence<Entry>, calendar: DayCalendar, unitOf: UnitLookup = builtInUnit) -> [String: DayTotal] {
    var totals: [String: DayTotal] = [:]
    for entry in entries where entry.isRingEntry(unitOf: unitOf) {
        let day = calendar.dayKey(at: entry.doneAt)
        totals[day, default: DayTotal(day: day)].reps += entry.reps ?? 0
        totals[day, default: DayTotal(day: day)].sets += 1
    }
    return totals
}

/// One exercise's amount and sets per day, in its own unit. `reps` holds the day's count, or its seconds for a timed exercise.
public func exerciseDailyTotals(_ entries: some Sequence<Entry>, calendar: DayCalendar, exerciseId: String) -> [String: DayTotal] {
    var totals: [String: DayTotal] = [:]
    for entry in entries where !entry.isDeleted && entry.resolvedExerciseId == exerciseId {
        let day = calendar.dayKey(at: entry.doneAt)
        totals[day, default: DayTotal(day: day)].reps += entry.amount
        totals[day, default: DayTotal(day: day)].sets += 1
    }
    return totals
}

/// `dayCount` consecutive days ending at `endDay`, zero-filled, oldest first.
public func dailySeries(_ totals: [String: DayTotal], endDay: String, dayCount: Int) -> [DayTotal] {
    stride(from: dayCount - 1, through: 0, by: -1).map { daysBack in
        let day = DayKey.adding(-daysBack, to: endDay)
        return totals[day] ?? DayTotal(day: day)
    }
}

/// Trailing mean of `windowDays` days ending at each point (shorter at the start of history).
public func trailingAverage(_ totals: [String: DayTotal], days: [String], windowDays: Int, firstDay: String?) -> [Double?] {
    days.map { day in
        guard let firstDay, day >= firstDay else { return nil }
        let spanDays = min(windowDays, DayKey.daysBetween(firstDay, day) + 1)
        let sum = (0..<spanDays).reduce(0) { $0 + (totals[DayKey.adding(-$1, to: day)]?.reps ?? 0) }
        return Double(sum) / Double(spanDays)
    }
}

public struct Stats: Hashable, Sendable, Codable {
    public var today: DayTotal
    /// Consecutive days with at least one set, ending today (or yesterday, if today has none yet).
    public var streak: Int
    /// Consecutive days meeting the goal, by the same rule.
    public var goalStreak: Int
    /// Mean daily reps over the last 7 / 30 completed days (excludes today; never counts days before the first set).
    public var avgDailyReps7Days: Double?
    public var avgDailyReps30Days: Double?
    public var bestDay: DayTotal?
    /// Reps this week (Mon–today) vs. last week over the same weekdays.
    public var weekToDate: Int
    public var lastWeekToDate: Int
    public var lifetimeReps: Int
    public var lifetimeSets: Int
    public var activeDays: Int
    public var avgSetReps30Days: Double?
    public var goalDaysLast30: Int
    public var firstDay: String?
}

/// Ring stats: only counted sets in rep-unit exercises (see Entry.isRingEntry).
public func computeStats(_ entries: some Sequence<Entry>, nowMs: Int64, goalReps: Int, calendar: DayCalendar, unitOf: UnitLookup = builtInUnit) -> Stats {
    statsFromTotals(dailyTotals(entries, calendar: calendar, unitOf: unitOf), nowMs: nowMs, goalReps: goalReps, calendar: calendar)
}

/// The same stats over any day totals: the ring's, or one exercise's (exerciseDailyTotals), where `reps` is that exercise's amount.
public func statsFromTotals(_ totals: [String: DayTotal], nowMs: Int64, goalReps: Int, calendar: DayCalendar) -> Stats {
    let todayKey = calendar.dayKey(at: nowMs)
    let today = totals[todayKey] ?? DayTotal(day: todayKey)

    var firstDay: String?
    var bestDay: DayTotal?
    var lifetimeReps = 0
    var lifetimeSets = 0
    var activeDays = 0
    for dayTotal in totals.values where dayTotal.day <= todayKey {
        if firstDay == nil || dayTotal.day < firstDay! { firstDay = dayTotal.day }
        if bestDay.map({ (dayTotal.reps, dayTotal.day) > ($0.reps, $0.day) }) ?? true { bestDay = dayTotal }
        lifetimeReps += dayTotal.reps
        lifetimeSets += dayTotal.sets
        activeDays += 1
    }

    func runLength(_ isCounted: (DayTotal?) -> Bool) -> Int {
        var day = isCounted(totals[todayKey]) ? todayKey : DayKey.adding(-1, to: todayKey)
        var runDays = 0
        while isCounted(totals[day]) {
            runDays += 1
            day = DayKey.adding(-1, to: day)
        }
        return runDays
    }

    func completedAverage(windowDays: Int) -> Double? {
        guard let firstDay else { return nil }
        let yesterday = DayKey.adding(-1, to: todayKey)
        let spanDays = min(windowDays, DayKey.daysBetween(firstDay, yesterday) + 1)
        guard spanDays > 0 else { return nil }
        let sum = (0..<spanDays).reduce(0) { $0 + (totals[DayKey.adding(-$1, to: yesterday)]?.reps ?? 0) }
        return Double(sum) / Double(spanDays)
    }

    let weekStart = DayKey.startOfWeek(todayKey)
    var weekToDate = 0
    var lastWeekToDate = 0
    for offset in 0...DayKey.daysBetween(weekStart, todayKey) {
        weekToDate += totals[DayKey.adding(offset, to: weekStart)]?.reps ?? 0
        lastWeekToDate += totals[DayKey.adding(offset - 7, to: weekStart)]?.reps ?? 0
    }

    var repsLast30 = 0
    var setsLast30 = 0
    var goalDaysLast30 = 0
    for daysBack in 0..<30 {
        guard let dayTotal = totals[DayKey.adding(-daysBack, to: todayKey)] else { continue }
        repsLast30 += dayTotal.reps
        setsLast30 += dayTotal.sets
        if dayTotal.reps >= goalReps { goalDaysLast30 += 1 }
    }

    return Stats(
        today: today,
        streak: runLength { ($0?.reps ?? 0) > 0 },
        goalStreak: runLength { $0 != nil && $0!.reps >= goalReps },
        avgDailyReps7Days: completedAverage(windowDays: 7),
        avgDailyReps30Days: completedAverage(windowDays: 30),
        bestDay: bestDay,
        weekToDate: weekToDate,
        lastWeekToDate: lastWeekToDate,
        lifetimeReps: lifetimeReps,
        lifetimeSets: lifetimeSets,
        activeDays: activeDays,
        avgSetReps30Days: setsLast30 > 0 ? Double(repsLast30) / Double(setsLast30) : nil,
        goalDaysLast30: goalDaysLast30,
        firstDay: firstDay
    )
}

/// The pull-up rep count logged most often in the last 30 days, for highlighting the usual button.
public func usualReps(_ entries: some Sequence<Entry>, nowMs: Int64, calendar: DayCalendar) -> Int? {
    let cutoff = DayKey.adding(-29, to: calendar.dayKey(at: nowMs))
    var setCountsByReps: [Int: Int] = [:]
    for entry in entries where entry.isLivePullUp && calendar.dayKey(at: entry.doneAt) >= cutoff {
        setCountsByReps[entry.reps!, default: 0] += 1
    }
    return mostCommon(setCountsByReps)
}

/// The most frequent amount, ties to the larger.
func mostCommon(_ countsByAmount: [Int: Int]) -> Int? {
    countsByAmount.max { a, b in a.value != b.value ? a.value < b.value : a.key < b.key }?.key
}

public struct HeaviestSet: Hashable, Sendable, Codable {
    public var addedWeightLbs: Double
    /// The set's amount: its count, or seconds for a hold.
    public var reps: Int
    public var day: String
}

/// Most added weight in one set of an exercise; ties go to the bigger amount, then the more recent day. Nil if every set was bodyweight.
public func heaviestSet(_ entries: some Sequence<Entry>, nowMs: Int64, calendar: DayCalendar, exerciseId: String = Catalog.pullUp) -> HeaviestSet? {
    let todayKey = calendar.dayKey(at: nowMs)
    var heaviest: HeaviestSet?
    for entry in entries where !entry.isDeleted && entry.resolvedExerciseId == exerciseId {
        guard let addedWeightLbs = entry.addedWeightLbs, addedWeightLbs != 0 else { continue }
        let day = calendar.dayKey(at: entry.doneAt)
        guard day <= todayKey else { continue }
        let candidate = HeaviestSet(addedWeightLbs: addedWeightLbs, reps: entry.amount, day: day)
        guard let current = heaviest else {
            heaviest = candidate
            continue
        }
        if (candidate.addedWeightLbs, candidate.reps) > (current.addedWeightLbs, current.reps) || ((candidate.addedWeightLbs, candidate.reps) == (current.addedWeightLbs, current.reps) && day > current.day) {
            heaviest = candidate
        }
    }
    return heaviest
}

public struct BestSet: Hashable, Sendable, Codable {
    public var amount: Int
    public var day: String
}

/// The biggest single set of an exercise up to today, in its own unit; ties go to the more recent day.
public func bestSet(_ entries: some Sequence<Entry>, nowMs: Int64, calendar: DayCalendar, exerciseId: String) -> BestSet? {
    let todayKey = calendar.dayKey(at: nowMs)
    var best: BestSet?
    for entry in entries where !entry.isDeleted && entry.resolvedExerciseId == exerciseId {
        let day = calendar.dayKey(at: entry.doneAt)
        guard day <= todayKey else { continue }
        if let current = best, (entry.amount, day) <= (current.amount, current.day) { continue }
        best = BestSet(amount: entry.amount, day: day)
    }
    return best
}

/// One exercise's share of a day, in that exercise's own unit. Counted exercises carry reps, timed ones holdSeconds.
public struct ExerciseDayTotal: Hashable, Sendable, Codable {
    public var sets: Int
    public var reps: Int?
    public var bestSetReps: Int?
    public var holdSeconds: Int?
    public var bestHoldSeconds: Int?
    /// The most added weight in any one set, nil when every set was bodyweight.
    public var bestAddedWeightLbs: Double?

    public init(sets: Int, reps: Int? = nil, bestSetReps: Int? = nil, holdSeconds: Int? = nil, bestHoldSeconds: Int? = nil, bestAddedWeightLbs: Double? = nil) {
        self.sets = sets
        self.reps = reps
        self.bestSetReps = bestSetReps
        self.holdSeconds = holdSeconds
        self.bestHoldSeconds = bestHoldSeconds
        self.bestAddedWeightLbs = bestAddedWeightLbs
    }
}

/// A user's whole day, as the server stores it for boards. `reps` and `bestSetReps` follow the
/// ring rule (rep-unit counted sets only); `sets` counts every set; `holdSeconds` sums every hold.
public struct DayTotalRecord: Hashable, Sendable, Codable {
    public var day: String
    public var reps: Int
    public var sets: Int
    public var bestSetReps: Int
    public var holdSeconds: Int
    public var byExercise: [String: ExerciseDayTotal]
}

/// Totals for one day's entries (already filtered to that day).
public func computeDayTotal(day: String, entries: some Sequence<Entry>, unitOf: UnitLookup = builtInUnit) -> DayTotalRecord {
    var dayTotal = DayTotalRecord(day: day, reps: 0, sets: 0, bestSetReps: 0, holdSeconds: 0, byExercise: [:])
    for entry in entries where !entry.isDeleted {
        var exerciseTotal = dayTotal.byExercise[entry.resolvedExerciseId] ?? ExerciseDayTotal(sets: 0)
        dayTotal.sets += 1
        exerciseTotal.sets += 1
        if let holdSeconds = entry.holdSeconds {
            dayTotal.holdSeconds += holdSeconds
            exerciseTotal.holdSeconds = (exerciseTotal.holdSeconds ?? 0) + holdSeconds
            exerciseTotal.bestHoldSeconds = max(exerciseTotal.bestHoldSeconds ?? 0, holdSeconds)
        } else if let reps = entry.reps {
            exerciseTotal.reps = (exerciseTotal.reps ?? 0) + reps
            exerciseTotal.bestSetReps = max(exerciseTotal.bestSetReps ?? 0, reps)
            if entry.isRingEntry(unitOf: unitOf) {
                dayTotal.reps += reps
                dayTotal.bestSetReps = max(dayTotal.bestSetReps, reps)
            }
        }
        if let addedWeightLbs = entry.addedWeightLbs, addedWeightLbs != 0 {
            exerciseTotal.bestAddedWeightLbs = max(exerciseTotal.bestAddedWeightLbs ?? 0, addedWeightLbs)
        }
        dayTotal.byExercise[entry.resolvedExerciseId] = exerciseTotal
    }
    return dayTotal
}
