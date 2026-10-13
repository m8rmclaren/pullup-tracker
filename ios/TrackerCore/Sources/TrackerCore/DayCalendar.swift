import Foundation

// Day keys are "YYYY-MM-DD" strings in a user's own zone. Arithmetic on them is pure proleptic
// Gregorian calendar math, so DST never shifts a day. A port of time.ts, held to it by
// test/fixtures/days.json. Only the zone's UTC offset comes from Foundation; the calendar math
// is done here, so it matches JavaScript's Date on every platform.

private let dayMs: Int64 = 86_400_000

/// A wall-clock reading in some zone.
public struct WallClock: Hashable, Sendable {
    public var year: Int64
    public var month: Int
    public var day: Int
    public var hour: Int
    public var minute: Int
    public var second: Int
}

/// Days in one IANA zone: which day an instant falls on, and when a wall-clock time happened.
public struct DayCalendar: Hashable, Sendable {
    /// The zone of every account made before zones were per user; their stored day keys are in it.
    public static let defaultTimeZoneIdentifier = "America/Denver"
    public static let maxTimeZoneLength = 64

    public let timeZone: TimeZone

    public init(timeZone: TimeZone) {
        self.timeZone = timeZone
    }

    /// Nil for a zone this platform doesn't know.
    public init?(zone identifier: String) {
        guard !identifier.isEmpty, identifier.utf16.count <= Self.maxTimeZoneLength, let timeZone = TimeZone(identifier: identifier) else { return nil }
        self.timeZone = timeZone
    }

    /// An account's calendar: its zone, or the default zone when it has none or one this platform doesn't know.
    public init(accountZone identifier: String?) {
        self = identifier.flatMap(DayCalendar.init(zone:)) ?? DayCalendar(zone: Self.defaultTimeZoneIdentifier) ?? DayCalendar(timeZone: TimeZone(identifier: "UTC")!)
    }

    /// Wall-clock time in this zone minus UTC, in ms (-6h for Denver in summer).
    public func zoneOffsetMs(at epochMs: Int64) -> Int64 {
        Int64(timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(epochMs) / 1000))) * 1000
    }

    public func wallClock(at epochMs: Int64) -> WallClock {
        let localSeconds = floorDivide(epochMs, 1000) + zoneOffsetMs(at: epochMs) / 1000
        let days = floorDivide(localSeconds, 86_400)
        let secondOfDay = Int(localSeconds - days * 86_400)
        let civil = civilDate(fromDays: days)
        return WallClock(year: civil.year, month: civil.month, day: civil.day, hour: secondOfDay / 3600, minute: secondOfDay / 60 % 60, second: secondOfDay % 60)
    }

    public func dayKey(at epochMs: Int64) -> String {
        let wallClock = wallClock(at: epochMs)
        return formatDayKey(year: wallClock.year, month: wallClock.month, day: wallClock.day)
    }

    public func monthKey(at epochMs: Int64) -> String {
        String(dayKey(at: epochMs).prefix(7))
    }

    /// Epoch ms for a wall-clock time ("HH:MM") on a day. A time skipped by spring-forward resolves
    /// an hour later (2:30 → 3:30), as clocks do; an ambiguous fall-back time resolves to the first
    /// (daylight) occurrence.
    public func epochMs(day: String, time: String) -> Int64 {
        let parts = time.split(separator: ":").map { Int64($0) ?? 0 }
        let hour = parts.first ?? 0
        let minute = parts.count > 1 ? parts[1] : 0
        let naiveUtcMs = DayKey.days(from: day) * dayMs + hour * 3_600_000 + minute * 60_000
        let viaEarlierOffset = naiveUtcMs - zoneOffsetMs(at: naiveUtcMs - 12 * 3_600_000)
        let viaLaterOffset = naiveUtcMs - zoneOffsetMs(at: naiveUtcMs + 12 * 3_600_000)
        for candidate in [viaEarlierOffset, viaLaterOffset].sorted() {
            let wallClock = wallClock(at: candidate)
            if wallClock.hour == hour && wallClock.minute == minute && dayKey(at: candidate) == day { return candidate }
        }
        return max(viaEarlierOffset, viaLaterOffset)
    }

    /// "HH:MM", 24-hour.
    public func timeOfDay(at epochMs: Int64) -> String {
        let wallClock = wallClock(at: epochMs)
        return "\(zeroPadded(wallClock.hour)):\(zeroPadded(wallClock.minute))"
    }

    /// Ms until the next midnight in this zone after `epochMs`.
    public func msUntilNextDay(after epochMs: Int64) -> Int64 {
        let nextMidnightMs = self.epochMs(day: DayKey.adding(1, to: dayKey(at: epochMs)), time: "00:00")
        return max(1000, nextMidnightMs - epochMs)
    }

    /// "7:05a", "12:30p".
    public func formatClock(at epochMs: Int64) -> String {
        let wallClock = wallClock(at: epochMs)
        let hour12 = wallClock.hour % 12 == 0 ? 12 : wallClock.hour % 12
        return "\(hour12):\(zeroPadded(wallClock.minute))\(wallClock.hour < 12 ? "a" : "p")"
    }
}

/// Zone-free arithmetic on day keys.
public enum DayKey {
    public static func adding(_ days: Int, to day: String) -> String {
        let civil = civilDate(fromDays: Self.days(from: day) + Int64(days))
        return formatDayKey(year: civil.year, month: civil.month, day: civil.day)
    }

    /// Whole days from `fromDay` to `toDay` (toDay - fromDay).
    public static func daysBetween(_ fromDay: String, _ toDay: String) -> Int {
        Int(days(from: toDay) - days(from: fromDay))
    }

    /// 0 = Monday … 6 = Sunday.
    public static func weekdayIndexFromMonday(_ day: String) -> Int {
        // 1970-01-01 was a Thursday, index 3.
        Int(positiveModulo(days(from: day) + 3, 7))
    }

    public static func startOfWeek(_ day: String) -> String {
        adding(-weekdayIndexFromMonday(day), to: day)
    }

    private static let monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    private static let weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    /// "Oct 8", "Thu, Oct 8", "Oct 8, 2026".
    public static func format(_ day: String, weekday: Bool = false, year: Bool = false) -> String {
        let (yearNumber, month, dayOfMonth) = parse(day)
        var label = "\(monthNames[Int(month) - 1]) \(dayOfMonth)"
        if weekday { label = "\(weekdayNames[weekdayIndexFromMonday(day)]), \(label)" }
        if year { label += ", \(yearNumber)" }
        return label
    }

    /// Days since 1970-01-01.
    static func days(from day: String) -> Int64 {
        let (year, month, dayOfMonth) = parse(day)
        return daysFromCivil(year: year, month: month, day: dayOfMonth)
    }

    private static func parse(_ day: String) -> (Int64, Int64, Int64) {
        let parts = day.split(separator: "-").map { Int64($0) ?? 1 }
        guard parts.count == 3 else { return (1970, 1, 1) }
        return (parts[0], parts[1], parts[2])
    }
}

private func formatDayKey(year: Int64, month: Int, day: Int) -> String {
    "\(zeroPadded(Int(year), width: 4))-\(zeroPadded(month))-\(zeroPadded(day))"
}

private func zeroPadded(_ value: Int, width: Int = 2) -> String {
    let digits = String(value)
    return digits.count >= width ? digits : String(repeating: "0", count: width - digits.count) + digits
}

private func floorDivide(_ dividend: Int64, _ divisor: Int64) -> Int64 {
    let quotient = dividend / divisor
    return dividend % divisor < 0 ? quotient - 1 : quotient
}

private func positiveModulo(_ dividend: Int64, _ divisor: Int64) -> Int64 {
    let remainder = dividend % divisor
    return remainder < 0 ? remainder + divisor : remainder
}

// Howard Hinnant's days_from_civil and civil_from_days, over the proleptic Gregorian calendar
// JavaScript's Date uses. Out-of-range months and days roll over as Date.UTC's do.

private func daysFromCivil(year: Int64, month: Int64, day: Int64) -> Int64 {
    let shiftedYear = month <= 2 ? year - 1 : year
    let era = (shiftedYear >= 0 ? shiftedYear : shiftedYear - 399) / 400
    let yearOfEra = shiftedYear - era * 400
    let shiftedMonth = month > 2 ? month - 3 : month + 9
    let dayOfYear = (153 * shiftedMonth + 2) / 5 + day - 1
    let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
    return era * 146_097 + dayOfEra - 719_468
}

private func civilDate(fromDays days: Int64) -> (year: Int64, month: Int, day: Int) {
    let shifted = days + 719_468
    let era = (shifted >= 0 ? shifted : shifted - 146_096) / 146_097
    let dayOfEra = shifted - era * 146_097
    let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146_096) / 365
    let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
    let shiftedMonth = (5 * dayOfYear + 2) / 153
    let day = dayOfYear - (153 * shiftedMonth + 2) / 5 + 1
    let month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9
    let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
    return (year, Int(month), Int(day))
}
