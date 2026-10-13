import Foundation
import Testing
@testable import TrackerCore

@Suite("boards.json")
struct BoardFixtureTests {
    @Test func cases() throws {
        for testCase in try loadFixture("boards.json")["cases"]!.array {
            let name = testCase["name"]!.string
            let spec = try testCase["spec"]!.decoded(as: BoardSpec.self)
            let members = try testCase["members"]!.decoded(as: [BoardMember].self)
            let rows = evaluateBoard(spec, members: members, nowMs: instantMs(testCase["now"]))
            #expect(rows.map(\.id) == testCase["rows"]!.array.map { $0["id"]!.string }, "\(name): order")
            let found = try mismatches(rows, testCase["rows"])
            #expect(found.isEmpty, "\(name): \(found)")
            if let expectedGroupTotal = testCase["groupTotal"] {
                guard case .window(let window) = spec.period, let exerciseId = spec.exerciseId else {
                    Issue.record("\(name): a group total needs a fixed window and an exercise")
                    continue
                }
                #expect(groupTotal(exerciseId: exerciseId, window: window, members: members) == expectedGroupTotal.int, "\(name): group total")
            }
        }
    }

    @Test func windows() throws {
        let nowMs = instantMs(.string("2026-10-14T18:00:00Z"))
        let denver = try #require(DayCalendar(zone: "America/Denver"))
        let auckland = try #require(DayCalendar(zone: "Pacific/Auckland"))
        #expect(BoardPeriod.week.window(nowMs: nowMs, calendar: denver) == DayWindow(fromDay: "2026-10-12", toDay: "2026-10-14"))
        #expect(BoardPeriod.month.window(nowMs: nowMs, calendar: auckland) == DayWindow(fromDay: "2026-10-01", toDay: "2026-10-15"))
        #expect(BoardPeriod.today.requestWindow(nowMs: nowMs, calendar: denver) == DayWindow(fromDay: "2026-10-12", toDay: "2026-10-16"))
    }
}

@Suite("compose/names.json and compose/drafts.json")
struct ComposeFixtureTests {
    @Test func matchesAndSearches() throws {
        let fixture = try loadFixture("compose/names.json")
        let items = try fixture["items"]!.decoded(as: [NamedRef].self)
        for testCase in fixture["matches"]!.array {
            let expected = testCase["expected"]!.stringValue
            #expect(matchName(testCase["query"]!.string, in: items)?.id == expected, "\(testCase["name"]!.string)")
        }
        for testCase in fixture["searches"]!.array {
            let expected = testCase["expected"]!.array.map(\.string)
            #expect(searchNames(testCase["query"]!.string, in: items).map(\.id) == expected, "\(testCase["name"]!.string)")
        }
    }

    @Test func nameHelpers() {
        #expect(nameWords("Push-Ups!") == ["push", "up"])
        #expect(nameKey("Café  Dips") == "cafedip")
        #expect(editDistance("kitten", "sitting") == 3)
        #expect(editDistance("", "abc") == 3)
        #expect(typoAllowance(keyLength: 4) == 0)
        #expect(typoAllowance(keyLength: 20) == 3)
    }

    @Test func resolveDrafts() throws {
        let fixture = try loadFixture("compose/drafts.json")
        let known = try fixture["known"]!.decoded(as: [KnownExercise].self)
        let knownVariations = try fixture["knownVariations"]!.decoded(as: [String: [NamedRef]].self)
        let nowMs = instantMs(fixture["nowMs"])
        for testCase in fixture["cases"]!.array {
            let draft = try testCase["draft"]!.decoded(as: ComposedDraft.self)
            let resolved = resolveDraft(draft, known: known, variationsOf: { knownVariations[$0] ?? [] }, nowMs: nowMs)
            let found = try mismatches(resolved, testCase["expected"], isSubset: false)
            #expect(found.isEmpty, "\(testCase["name"]!.string): \(found)")
        }
    }
}

@Suite("catalog")
struct CatalogTests {
    @Test func bundledCopyMatchesTheShared() throws {
        let shared = try Data(contentsOf: repoRoot.appending(path: "src/shared/catalog.json"))
        let bundled = try Data(contentsOf: repoRoot.appending(path: "ios/TrackerCore/Sources/TrackerCore/Resources/catalog.json"))
        #expect(bundled == shared, "copy src/shared/catalog.json to ios/TrackerCore/Sources/TrackerCore/Resources/")
    }

    @Test func ids() {
        #expect(Catalog.exercise("pull-up")?.unit == "rep")
        #expect(Catalog.exercise("front-lever")?.measure == .time)
        #expect(Catalog.isCreatedExerciseId("x-k3p7aaaaaaaaaaaa"))
        #expect(!Catalog.isCreatedExerciseId("x-k3p9aaaaaaaaaaaa"))
        #expect(!Catalog.isCreatedExerciseId("x-k3p9aaaaaaaaaaa1"))
        #expect(Catalog.isCreatedVariationId("v-intotuckaaaaaaaa"))
        #expect(Catalog.isBuiltInId("wide-grip"))
        #expect(!Catalog.isBuiltInId("x-wide"))
    }
}
