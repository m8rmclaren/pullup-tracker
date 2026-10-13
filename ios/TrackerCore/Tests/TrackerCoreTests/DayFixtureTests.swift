import Foundation
import Testing
@testable import TrackerCore

@Suite("days.json")
struct DayFixtureTests {
    let fixture: JSONValue

    init() throws {
        fixture = try loadFixture("days.json")
    }

    private func calendar(_ testCase: JSONValue) throws -> DayCalendar {
        try #require(DayCalendar(zone: testCase["timeZone"]!.string))
    }

    @Test func dayKeys() throws {
        for testCase in fixture["dayKeys"]!.array {
            #expect(try calendar(testCase).dayKey(at: instantMs(testCase["at"])) == testCase["day"]!.string, "\(testCase["name"]!.string)")
        }
    }

    @Test func wallClockToInstant() throws {
        for testCase in fixture["wallClockToInstant"]!.array {
            let epochMs = try calendar(testCase).epochMs(day: testCase["day"]!.string, time: testCase["time"]!.string)
            #expect(epochMs == instantMs(testCase["at"]), "\(testCase["name"]!.string)")
        }
    }

    @Test func timeOfDay() throws {
        for testCase in fixture["timeOfDay"]!.array {
            #expect(try calendar(testCase).timeOfDay(at: instantMs(testCase["at"])) == testCase["time"]!.string, "\(testCase["name"]!.string)")
        }
    }

    @Test func msUntilNextDay() throws {
        for testCase in fixture["msUntilNextDay"]!.array {
            #expect(try calendar(testCase).msUntilNextDay(after: instantMs(testCase["at"])) == Int64(testCase["ms"]!.int), "\(testCase["name"]!.string)")
        }
    }

    @Test func addDays() {
        for testCase in fixture["addDays"]!.array {
            #expect(DayKey.adding(testCase["days"]!.int, to: testCase["day"]!.string) == testCase["result"]!.string, "\(testCase)")
        }
    }

    @Test func daysBetween() {
        for testCase in fixture["daysBetween"]!.array {
            #expect(DayKey.daysBetween(testCase["fromDay"]!.string, testCase["toDay"]!.string) == testCase["days"]!.int, "\(testCase)")
        }
    }

    @Test func startOfWeek() {
        for testCase in fixture["startOfWeek"]!.array {
            #expect(DayKey.startOfWeek(testCase["day"]!.string) == testCase["result"]!.string, "\(testCase["name"]!.string)")
        }
    }

    @Test func formatting() throws {
        let denver = try #require(DayCalendar(zone: "America/Denver"))
        let morning = instantMs(.string("2026-10-08T07:05:00-06:00"))
        #expect(denver.formatClock(at: morning) == "7:05a")
        #expect(denver.formatClock(at: instantMs(.string("2026-10-08T12:30:00-06:00"))) == "12:30p")
        #expect(denver.formatClock(at: instantMs(.string("2026-10-08T00:15:00-06:00"))) == "12:15a")
        #expect(denver.monthKey(at: morning) == "2026-10")
        #expect(DayKey.format("2026-10-08") == "Oct 8")
        #expect(DayKey.format("2026-10-08", weekday: true, year: true) == "Thu, Oct 8, 2026")
    }

    @Test func unknownZones() {
        #expect(DayCalendar(zone: "Mars/Olympus_Mons") == nil)
        #expect(DayCalendar(accountZone: nil).timeZone.identifier == DayCalendar.defaultTimeZoneIdentifier)
    }
}
