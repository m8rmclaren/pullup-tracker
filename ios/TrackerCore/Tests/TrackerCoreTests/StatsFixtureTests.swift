import Foundation
import Testing
@testable import TrackerCore

@Suite("stats.json")
struct StatsFixtureTests {
    let fixture: JSONValue

    init() throws {
        fixture = try loadFixture("stats.json")
    }

    @Test func checks() throws {
        for testCase in fixture["cases"]!.array {
            let name = testCase["name"]!.string
            let entries = try toEntries(testCase["entries"])
            let calendar = try #require(DayCalendar(zone: testCase["timeZone"]!.string))
            let goalReps = testCase["goalReps"]!.int
            let definitions = testCase["definitions"]?.array ?? []
            let unitOf: UnitLookup = { exerciseId in
                builtInUnit(exerciseId) ?? definitions.first { $0["id"]?.stringValue == exerciseId }?["unit"]?.stringValue
            }

            for check in testCase["checks"]!.array {
                let label = "\(name) at \(check["now"]!.string)"
                let nowMs = instantMs(check["now"])
                if let expected = check["stats"] {
                    let found = try mismatches(computeStats(entries, nowMs: nowMs, goalReps: goalReps, calendar: calendar, unitOf: unitOf), expected)
                    #expect(found.isEmpty, "\(label): stats \(found)")
                }
                if let expected = check["dayTotals"] {
                    let totals = dailyTotals(entries, calendar: calendar, unitOf: unitOf)
                    for (day, expectedDay) in expected.object {
                        let found = try mismatches(totals[day], expectedDay)
                        #expect(found.isEmpty, "\(label): dayTotals \(day) \(found)")
                    }
                }
                if let expected = check["usualReps"] {
                    let usual = usualReps(entries, nowMs: nowMs, calendar: calendar)
                    #expect(usual.map { JSONValue.number(Double($0)) } ?? .null == expected, "\(label): usualReps")
                }
                if let expected = check["heaviestSet"] {
                    let found = try mismatches(heaviestSet(entries, nowMs: nowMs, calendar: calendar), expected, isSubset: false)
                    #expect(found.isEmpty, "\(label): heaviestSet \(found)")
                }
                for (exerciseId, expected) in check["exercises"]?.object ?? [:] {
                    let totals = exerciseDailyTotals(entries, calendar: calendar, exerciseId: exerciseId)
                    if let expectedDayTotals = expected["dayTotals"] {
                        let actual = totals.mapValues { ["reps": $0.reps, "sets": $0.sets] }
                        let found = try mismatches(actual, expectedDayTotals, isSubset: false)
                        #expect(found.isEmpty, "\(label): \(exerciseId) dayTotals \(found)")
                    }
                    if let expectedStats = expected["stats"] {
                        let found = try mismatches(statsFromTotals(totals, nowMs: nowMs, goalReps: goalReps, calendar: calendar), expectedStats)
                        #expect(found.isEmpty, "\(label): \(exerciseId) stats \(found)")
                    }
                    if let expectedBestSet = expected["bestSet"] {
                        let found = try mismatches(bestSet(entries, nowMs: nowMs, calendar: calendar, exerciseId: exerciseId), expectedBestSet, isSubset: false)
                        #expect(found.isEmpty, "\(label): \(exerciseId) bestSet \(found)")
                    }
                    if let expectedHeaviestSet = expected["heaviestSet"] {
                        let found = try mismatches(heaviestSet(entries, nowMs: nowMs, calendar: calendar, exerciseId: exerciseId), expectedHeaviestSet, isSubset: false)
                        #expect(found.isEmpty, "\(label): \(exerciseId) heaviestSet \(found)")
                    }
                }
            }

            let entriesByDay = Dictionary(grouping: entries) { calendar.dayKey(at: $0.doneAt) }
            for (day, expected) in testCase["dayTotalRecords"]?.object ?? [:] {
                let found = try mismatches(computeDayTotal(day: day, entries: entriesByDay[day] ?? [], unitOf: unitOf), expected, isSubset: false)
                #expect(found.isEmpty, "\(name): dayTotalRecords \(day) \(found)")
            }

            if let storedDayTotals = testCase["dayTotals"]?.object {
                for (day, dayEntries) in entriesByDay {
                    let recomputed = computeDayTotal(day: day, entries: dayEntries, unitOf: unitOf)
                    let storedInV1 = try #require(storedDayTotals[day], "\(name): no stored total for \(day)")
                    let found = try mismatches(["reps": recomputed.reps, "sets": recomputed.sets, "bestSetReps": recomputed.bestSetReps], storedInV1, isSubset: false)
                    #expect(found.isEmpty, "\(name): v1 stored total \(day) \(found)")
                    let legacy = BoardDay(day: day, reps: storedInV1["reps"]!.int, sets: storedInV1["sets"]!.int, bestSetReps: storedInV1["bestSetReps"]!.int)
                    let withoutWeight = recomputed.byExercise.mapValues { total in
                        var total = total
                        total.bestAddedWeightLbs = nil
                        return total
                    }
                    #expect(legacy.exerciseTotals == withoutWeight, "\(name): v1 stored total \(day) by exercise")
                }
                let actual = dailyTotals(entries, calendar: calendar).mapValues { ["reps": $0.reps, "sets": $0.sets] }
                let expected = JSONValue.object(storedDayTotals.filter { $0.value["sets"]!.int > 0 }.mapValues { .object(["reps": $0["reps"]!, "sets": $0["sets"]!]) })
                let found = try mismatches(actual, expected, isSubset: false)
                #expect(found.isEmpty, "\(name): per-day reps and sets \(found)")
            }
        }
    }

    @Test func legacyDayTotals() throws {
        for testCase in fixture["legacyDayTotals"]!.array {
            let dayTotal = try testCase["dayTotal"]!.decoded(as: BoardDay.self)
            let found = try mismatches(dayTotal.exerciseTotals, testCase["byExercise"], isSubset: false)
            #expect(found.isEmpty, "\(testCase["name"]!.string): \(found)")
        }
    }

    @Test func seriesAndTrailingAverage() throws {
        let denver = try #require(DayCalendar(zone: "America/Denver"))
        let set = { (day: String, time: String, reps: Int) in Entry(id: "\(day)\(time)", doneAt: denver.epochMs(day: day, time: time), reps: reps, updatedAt: 1) }
        let totals = dailyTotals([set("2026-10-06", "08:00", 10), set("2026-10-08", "08:00", 20)], calendar: denver)
        let series = dailySeries(totals, endDay: "2026-10-08", dayCount: 4)
        #expect(series.map(\.day) == ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"])
        #expect(series.map(\.reps) == [0, 10, 0, 20])
        #expect(trailingAverage(totals, days: series.map(\.day), windowDays: 2, firstDay: "2026-10-06") == [nil, 10, 5, 10])
    }
}
