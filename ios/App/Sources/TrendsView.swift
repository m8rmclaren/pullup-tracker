import Charts
import SwiftUI
import TrackerCore

private let heatmapWeeks = 26
private let historyDays = 30

/// The ring across exercises, or one exercise in its own unit.
struct TrendsView: View {
    let model: AppModel

    @State private var exerciseId: String?

    private var exerciseIds: [String] {
        recentExerciseIds(model.entries, limit: 100).sorted { model.exerciseName($0).localizedStandardCompare(model.exerciseName($1)) == .orderedAscending }
    }

    var body: some View {
        let summary = exerciseId.map { exerciseSummary($0) } ?? ringSummary()
        ScrollView {
            VStack(spacing: 16) {
                TileGrid(tiles: summary.tiles)
                DailyChartCard(summary: summary, today: model.today)
                HeatmapCard(summary: summary, today: model.today)
                HistoryCard(summary: summary, today: model.today)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .navigationTitle(exerciseId.map { model.exerciseName($0) } ?? "Trends")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            let exerciseIds = exerciseIds
            if exerciseIds.count > 1 || (exerciseIds.count == 1 && exerciseIds[0] != Catalog.pullUp) {
                ToolbarItem(placement: .principal) { exerciseMenu(exerciseIds) }
            }
        }
        .navigationDestination(for: DayDestination.self) { DayView(model: model, day: $0.day) }
    }

    private func exerciseMenu(_ exerciseIds: [String]) -> some View {
        Menu {
            Picker("Exercise", selection: $exerciseId) {
                Text("All exercises · reps on the ring").tag(String?.none)
                ForEach(exerciseIds, id: \.self) { exerciseId in
                    Text(model.exerciseName(exerciseId)).tag(String?.some(exerciseId))
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(exerciseId.map { model.exerciseName($0) } ?? "All exercises").font(.headline)
                Image(systemName: "chevron.down.circle.fill").font(.subheadline).foregroundStyle(.secondary)
            }
            .foregroundStyle(.primary)
        }
        .accessibilityLabel("Exercise: \(exerciseId.map { model.exerciseName($0) } ?? "All exercises")")
    }

    // MARK: - Summaries

    private func ringSummary() -> TrendsSummary {
        let stats = model.stats
        let today = model.today
        let goal = model.goalReps
        var tiles = [
            StatTile(label: "Streak", value: "\(stats.streak)", unit: stats.streak == 1 ? "day" : "days", note: "\(stats.goalStreak) at goal"),
            StatTile(label: "7-day avg", value: formatOneDecimal(stats.avgDailyReps7Days), unit: "/day", note: "30-day \(formatOneDecimal(stats.avgDailyReps30Days))"),
            StatTile(label: "This week", value: "\(stats.weekToDate)", unit: "reps", note: weekOverWeekNote(stats, formatAmount: String.init)),
            StatTile(label: "Best day", value: stats.bestDay.map { "\($0.reps)" } ?? "—", unit: "reps", note: stats.bestDay.map { dayLabel($0.day, today: today) } ?? "No sets yet"),
            StatTile(label: "Avg set", value: formatOneDecimal(stats.avgSetReps30Days), unit: "reps", note: "last 30 days"),
            StatTile(label: "Goal days", value: "\(stats.goalDaysLast30)", unit: "/ 30", note: "goal \(goal)"),
        ]
        if let heaviest = heaviestSet(model.entries, nowMs: model.nowMs, calendar: model.calendar) {
            tiles.append(StatTile(label: "Heaviest pull-up", value: formatAddedWeight(heaviest.addedWeightLbs), unit: "× \(heaviest.reps)", note: dayLabel(heaviest.day, today: today), isWide: true))
        }
        tiles.append(StatTile(label: "Lifetime", value: stats.lifetimeReps.formatted(), unit: "reps", note: "\(stats.lifetimeSets.formatted()) sets · \(stats.activeDays) days", isWide: true))
        return TrendsSummary(
            tiles: tiles,
            dayTotals: dailyTotals(model.entries, calendar: model.calendar, unitOf: model.unitLookup),
            firstDay: stats.firstDay,
            goal: goal,
            heatScale: goal,
            chartTitle: "Daily reps",
            isTimed: false,
            unit: Catalog.ringUnit
        )
    }

    private func exerciseSummary(_ exerciseId: String) -> TrendsSummary {
        let exercise = model.exercise(exerciseId)
        let isTimed = exercise?.measure == .time
        let unit = exercise?.unit ?? Catalog.ringUnit
        let unitLabel = isTimed ? "" : "\(unit)s"
        let formatTotal: (Int) -> String = { isTimed ? formatHoldSeconds($0) : $0.formatted() }
        let formatAverage: (Double?) -> String = { average in
            guard let average else { return "—" }
            return isTimed ? formatHoldSeconds(Int(average.rounded())) : formatOneDecimal(average)
        }
        let today = model.today
        let dayTotals = exerciseDailyTotals(model.entries, calendar: model.calendar, exerciseId: exerciseId)
        let stats = statsFromTotals(dayTotals, nowMs: model.nowMs, goalReps: 0, calendar: model.calendar)
        let best = bestSet(model.entries, nowMs: model.nowMs, calendar: model.calendar, exerciseId: exerciseId)

        var tiles = [
            StatTile(label: "Today", value: formatTotal(stats.today.reps), unit: unitLabel, note: "\(stats.today.sets) \(stats.today.sets == 1 ? "set" : "sets")"),
            StatTile(label: "Streak", value: "\(stats.streak)", unit: stats.streak == 1 ? "day" : "days", note: "\(stats.activeDays) days in all"),
            StatTile(label: "This week", value: formatTotal(stats.weekToDate), unit: unitLabel, note: weekOverWeekNote(stats, formatAmount: formatTotal)),
            StatTile(label: "7-day avg", value: formatAverage(stats.avgDailyReps7Days), unit: "/day", note: "30-day \(formatAverage(stats.avgDailyReps30Days))"),
            StatTile(label: "Best day", value: stats.bestDay.map { formatTotal($0.reps) } ?? "—", unit: unitLabel, note: stats.bestDay.map { dayLabel($0.day, today: today) } ?? "No sets yet"),
            StatTile(label: "Best set", value: best.map { formatTotal($0.amount) } ?? "—", unit: unitLabel, note: best.map { dayLabel($0.day, today: today) } ?? "No sets yet"),
            StatTile(label: "Avg set", value: formatAverage(stats.avgSetReps30Days), unit: unitLabel, note: "last 30 days"),
        ]
        if let heaviest = heaviestSet(model.entries, nowMs: model.nowMs, calendar: model.calendar, exerciseId: exerciseId) {
            tiles.append(StatTile(label: "Heaviest set", value: formatAddedWeight(heaviest.addedWeightLbs), unit: "× \(formatTotal(heaviest.reps))", note: dayLabel(heaviest.day, today: today)))
        }
        tiles.append(StatTile(label: "Lifetime", value: formatTotal(stats.lifetimeReps), unit: unitLabel, note: "\(stats.lifetimeSets.formatted()) sets · \(stats.activeDays) days", isWide: true))

        // One exercise has no goal, so its heatmap tops out at its biggest day in view.
        let heatScale = (0..<(heatmapWeeks * 7)).reduce(1) { max($0, dayTotals[DayKey.adding(-$1, to: today)]?.reps ?? 0) }
        return TrendsSummary(
            tiles: tiles,
            dayTotals: dayTotals,
            firstDay: stats.firstDay,
            goal: nil,
            heatScale: heatScale,
            chartTitle: "Daily \(isTimed ? "time" : unitLabel)",
            isTimed: isTimed,
            unit: unit
        )
    }
}

/// What the cards below the tiles draw, for the ring or one exercise.
private struct TrendsSummary {
    var tiles: [StatTile]
    var dayTotals: [String: DayTotal]
    var firstDay: String?
    var goal: Int?
    var heatScale: Int
    var chartTitle: String
    var isTimed: Bool
    var unit: String

    /// "42 reps", "3 laps", "1m 30s".
    func formatAmount(_ amount: Int) -> String {
        if isTimed { return formatHoldSeconds(amount) }
        return "\(amount.formatted()) \(amount == 1 ? unit : "\(unit)s")"
    }

    /// An axis label: the bare number, or a hold's duration.
    func formatAxisAmount(_ amount: Int) -> String {
        isTimed ? formatHoldSeconds(amount) : amount.formatted()
    }

    func isGoalHit(_ amount: Int) -> Bool {
        goal.map { amount >= $0 } ?? false
    }
}

private struct DayDestination: Hashable {
    var day: String
}

private func formatOneDecimal(_ value: Double?) -> String {
    guard let value else { return "—" }
    return value.formatted(.number.precision(.fractionLength(value >= 100 ? 0 : 1)))
}

private func weekOverWeekNote(_ stats: Stats, formatAmount: (Int) -> String) -> String {
    guard stats.lastWeekToDate != 0 || stats.weekToDate != 0 else { return "Mon–today" }
    let delta = stats.weekToDate - stats.lastWeekToDate
    return "\(delta >= 0 ? "▲" : "▼") \(formatAmount(abs(delta))) vs last week"
}

private func dayLabel(_ day: String, today: String) -> String {
    DayKey.format(day, year: day.prefix(4) != today.prefix(4))
}

private func relativeDayLabel(_ day: String, today: String) -> String {
    if day == today { return "Today" }
    if day == DayKey.adding(-1, to: today) { return "Yesterday" }
    return DayKey.format(day, weekday: true)
}

// MARK: - Tiles

private struct StatTile: Identifiable {
    var label: String
    var value: String
    var unit: String
    var note: String
    var isWide = false

    var id: String { label }
}

private struct TileGrid: View {
    let tiles: [StatTile]

    var body: some View {
        VStack(spacing: 10) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 2), spacing: 10) {
                ForEach(tiles.filter { !$0.isWide }) { TileView(tile: $0) }
            }
            ForEach(tiles.filter(\.isWide)) { TileView(tile: $0) }
        }
        .padding(.top, 8)
    }
}

private struct TileView: View {
    let tile: StatTile

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(tile.label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(tile.value).font(.title2.weight(.bold).monospacedDigit())
                Text(tile.unit).font(.subheadline).foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            Text(tile.note).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.background.secondary, in: .rect(cornerRadius: 16))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Cards

private struct Card<Header: View, Content: View>: View {
    let title: String
    @ViewBuilder let header: Header
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                header
            }
            content
        }
        .padding(16)
        .background(.background.secondary, in: .rect(cornerRadius: 22))
    }
}

private enum ChartRange: Int, CaseIterable, Identifiable {
    case month = 30, quarter = 90
    var id: Int { rawValue }
}

private struct DailyChartCard: View {
    let summary: TrendsSummary
    let today: String

    @State private var range = ChartRange.month
    @State private var selectedDay: String?

    var body: some View {
        let days = dailySeries(summary.dayTotals, endDay: today, dayCount: range.rawValue)
        let averages = trailingAverage(summary.dayTotals, days: days.map(\.day), windowDays: 7, firstDay: summary.firstDay)
        let selectedIndex = selectedDay.flatMap { day in days.firstIndex { $0.day == day } } ?? days.count - 1

        Card(title: summary.chartTitle) {
            Picker("Range", selection: $range) {
                ForEach(ChartRange.allCases) { Text("\($0.rawValue)D").tag($0) }
            }
            .pickerStyle(.segmented)
            .fixedSize()
        } content: {
            readout(days[selectedIndex], average: averages[selectedIndex])
            chart(days: days, averages: averages, selectedIndex: selectedIndex)
            legend
        }
        .onChange(of: range) { selectedDay = nil }
    }

    private func readout(_ dayTotal: DayTotal, average: Double?) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(relativeDayLabel(dayTotal.day, today: today)).font(.subheadline.weight(.medium))
            Spacer()
            Group {
                Text(summary.formatAmount(dayTotal.reps)).fontWeight(.semibold)
                    + Text(" · \(dayTotal.sets) \(dayTotal.sets == 1 ? "set" : "sets")")
                    + Text(average.map { " · 7d avg \(summary.isTimed ? formatHoldSeconds(Int($0.rounded())) : formatOneDecimal($0))" } ?? "").foregroundStyle(.secondary)
            }
            .font(.subheadline.monospacedDigit())
        }
        .accessibilityElement(children: .combine)
    }

    private func chart(days: [DayTotal], averages: [Double?], selectedIndex: Int) -> some View {
        let labelEveryDays = days.count > 45 ? 14 : 7
        // Counted back from today, and kept off the edges, where a centered label would be clipped.
        let labeledDays = days.indices.filter { (days.count - 1 - $0) % labelEveryDays == 0 && $0 >= 3 && $0 < days.count - 3 }.map { days[$0].day }
        let maxAmount = max(Double(summary.goal ?? 0) * 1.15, Double(days.map(\.reps).max() ?? 0), summary.isTimed ? 60 : 10)
        let selected = days[selectedIndex].day
        let ticks = axisTicks(maxAmount: maxAmount)

        return Chart {
            ForEach(days, id: \.day) { dayTotal in
                if dayTotal.reps > 0 {
                    BarMark(x: .value("Day", dayTotal.day), y: .value(summary.chartTitle, dayTotal.reps))
                        .foregroundStyle(Color.brand.opacity(dayTotal.day == selected ? 1 : summary.isGoalHit(dayTotal.reps) ? 0.85 : 0.5))
                        .clipShape(.rect(topLeadingRadius: 3, topTrailingRadius: 3))
                }
            }
            if let goal = summary.goal {
                RuleMark(y: .value("Goal", goal))
                    .foregroundStyle(Color.secondary)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 4]))
            }
            ForEach(Array(zip(days, averages)), id: \.0.day) { dayTotal, average in
                if let average {
                    LineMark(x: .value("Day", dayTotal.day), y: .value("7-day average", average), series: .value("Series", "average"))
                        .foregroundStyle(Color.primary)
                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .interpolationMethod(.monotone)
                }
            }
        }
        .chartXSelection(value: $selectedDay)
        // Inside a ScrollView the built-in selection only answers a press-and-drag, so a tap selects too.
        .chartGesture { proxy in
            SpatialTapGesture().onEnded { proxy.selectXValue(at: $0.location.x) }
        }
        // Empty days draw no bar, so the domain is given rather than inferred from the marks.
        .chartXScale(domain: days.map(\.day))
        .chartYScale(domain: 0...(ticks.last ?? maxAmount))
        .chartXAxis {
            AxisMarks(values: labeledDays) { value in
                AxisValueLabel {
                    if let day = value.as(String.self) { Text(DayKey.format(day)) }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: ticks) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let amount = value.as(Double.self) { Text(summary.formatAxisAmount(Int(amount))) }
                }
            }
        }
        .frame(height: 180)
        .sensoryFeedback(.selection, trigger: selectedDay)
    }

    /// Holds tick on whole durations (30s, 1m, 2m), counts on round numbers.
    private func axisTicks(maxAmount: Double) -> [Double] {
        let steps: [Double] = summary.isTimed ? [15, 30, 60, 120, 300, 600, 900, 1800, 3600] : [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]
        let step = steps.first { maxAmount / $0 <= 4 } ?? (maxAmount / 4).rounded(.up)
        return Array(stride(from: 0, through: (maxAmount / step).rounded(.up) * step, by: step))
    }

    private var legend: some View {
        HStack(spacing: 14) {
            Label { Text("Daily total") } icon: { RoundedRectangle(cornerRadius: 2).fill(Color.brand.opacity(0.7)).frame(width: 10, height: 10) }
            Label { Text("7-day avg") } icon: { Capsule().fill(.primary).frame(width: 14, height: 2) }
            if let goal = summary.goal {
                Label { Text("Goal \(goal)") } icon: {
                    Line().stroke(.secondary, style: StrokeStyle(lineWidth: 1, dash: [3, 3])).frame(width: 14, height: 1)
                }
            }
        }
        .labelStyle(LegendLabelStyle())
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

private struct Line: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        }
    }
}

private struct LegendLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon
            configuration.title
        }
    }
}

/// Bucket thresholds are fractions of the scale so the shading means something at any volume.
private func heatLevel(_ amount: Int, scale: Int) -> Int {
    if amount <= 0 { return 0 }
    if amount >= scale { return 4 }
    if Double(amount) >= Double(scale) * 2 / 3 { return 3 }
    if Double(amount) >= Double(scale) / 3 { return 2 }
    return 1
}

private struct HeatmapCard: View {
    let summary: TrendsSummary
    let today: String

    @State private var selectedDay: String?

    var body: some View {
        let firstDay = DayKey.adding(-7 * (heatmapWeeks - 1), to: DayKey.startOfWeek(today))
        let weekStarts = (0..<heatmapWeeks).map { DayKey.adding($0 * 7, to: firstDay) }

        Card(title: "Last 6 months") {
            EmptyView()
        } content: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 3) {
                    ForEach(Array(weekStarts.enumerated()), id: \.element) { index, weekStart in
                        // The first column's month is shown only if it has room before the next month's label.
                        let isNewMonth = index == 0
                            ? weekStarts.prefix(3).allSatisfy { $0.dropFirst(5).prefix(2) == weekStart.dropFirst(5).prefix(2) }
                            : weekStart.dropFirst(5).prefix(2) != weekStarts[index - 1].dropFirst(5).prefix(2)
                        Color.clear
                            .frame(maxWidth: .infinity, maxHeight: 12)
                            .overlay(alignment: .leading) {
                                if isNewMonth {
                                    Text(DayKey.format(weekStart).split(separator: " ")[0])
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .fixedSize()
                                }
                            }
                    }
                }
                HStack(spacing: 3) {
                    ForEach(weekStarts, id: \.self) { weekStart in
                        VStack(spacing: 3) {
                            ForEach(0..<7, id: \.self) { weekday in
                                cell(DayKey.adding(weekday, to: weekStart))
                            }
                        }
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Daily totals over the last six months")

                selection
                    .padding(.top, 6)
            }
        }
    }

    private func cell(_ day: String) -> some View {
        let amount = summary.dayTotals[day]?.reps ?? 0
        let isFuture = day > today
        let level = heatLevel(amount, scale: summary.heatScale)
        return RoundedRectangle(cornerRadius: 2.5)
            .fill(isFuture ? Color.clear : level == 0 ? Color.secondary.opacity(0.12) : Color.brand.opacity([0, 0.3, 0.5, 0.75, 1][level]))
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if day == selectedDay || (selectedDay == nil && day == today) {
                    RoundedRectangle(cornerRadius: 2.5).stroke(.primary, lineWidth: 1.5)
                }
            }
            .contentShape(.rect)
            .onTapGesture {
                guard !isFuture else { return }
                selectedDay = day
            }
    }

    private var selection: some View {
        let day = selectedDay ?? today
        let dayTotal = summary.dayTotals[day] ?? DayTotal(day: day)
        return NavigationLink(value: DayDestination(day: day)) {
            HStack {
                Text(relativeDayLabel(day, today: today)).fontWeight(.medium)
                Spacer()
                Text("\(summary.formatAmount(dayTotal.reps)) · \(dayTotal.sets) \(dayTotal.sets == 1 ? "set" : "sets")")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .font(.subheadline)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: selectedDay)
    }
}

private struct HistoryCard: View {
    let summary: TrendsSummary
    let today: String

    var body: some View {
        let days = dailySeries(summary.dayTotals, endDay: today, dayCount: historyDays).reversed()
        let maxAmount = max(summary.goal ?? 1, days.map(\.reps).max() ?? 0, 1)

        Card(title: "History") {
            Text("Tap a day to edit").font(.caption).foregroundStyle(.secondary)
        } content: {
            VStack(spacing: 0) {
                ForEach(days, id: \.day) { dayTotal in
                    NavigationLink(value: DayDestination(day: dayTotal.day)) {
                        HStack(spacing: 10) {
                            Text(relativeDayLabel(dayTotal.day, today: today))
                                .frame(width: 104, alignment: .leading)
                            GeometryReader { geometry in
                                Capsule()
                                    .fill(summary.isGoalHit(dayTotal.reps) ? Color.brand : Color.brand.opacity(0.5))
                                    .frame(width: geometry.size.width * Double(dayTotal.reps) / Double(maxAmount))
                                    .frame(maxHeight: .infinity, alignment: .center)
                            }
                            .frame(height: 6)
                            Text(dayTotal.reps > 0 ? summary.formatAxisAmount(dayTotal.reps) : "0")
                                .monospacedDigit()
                                .frame(minWidth: 40, alignment: .trailing)
                            Text(dayTotal.sets > 0 ? "\(dayTotal.sets)×" : "")
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .frame(width: 28, alignment: .trailing)
                        }
                        .font(.subheadline)
                        .frame(minHeight: 40)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(relativeDayLabel(dayTotal.day, today: today)): \(summary.formatAmount(dayTotal.reps)), \(dayTotal.sets) \(dayTotal.sets == 1 ? "set" : "sets")")
                    if dayTotal.day != days.last?.day { Divider() }
                }
            }
        }
    }
}

// MARK: - Day

/// One day's sets, each opening the editor.
struct DayView: View {
    let model: AppModel
    let day: String

    @State private var editing: EditingSet?

    private struct EditingSet: Identifiable {
        let entry: Entry
        var id: String { entry.id }
    }

    var body: some View {
        let sets = model.sets(on: day)
        let ringReps = dailyTotals(sets, calendar: model.calendar, unitOf: model.unitLookup)[day]?.reps ?? 0
        List {
            Section {
                HStack {
                    Text("**\(ringReps)** reps · \(sets.count) \(sets.count == 1 ? "set" : "sets")")
                    Spacer()
                    if ringReps >= model.goalReps {
                        Label("Goal", systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.subheadline.weight(.medium))
                    }
                }
            }
            Section {
                if sets.isEmpty {
                    Text("No sets this day.").foregroundStyle(.secondary)
                }
                ForEach(sets, id: \.id) { entry in
                    Button { editing = EditingSet(entry: entry) } label: {
                        HStack(spacing: 10) {
                            Text(model.formattedAmount(entry)).font(.headline.monospacedDigit())
                            if entry.resolvedExerciseId != Catalog.pullUp {
                                Text(model.exerciseName(entry.resolvedExerciseId)).foregroundStyle(.secondary)
                            }
                            if let addedWeightLbs = entry.addedWeightLbs {
                                Text(formatAddedWeight(addedWeightLbs)).foregroundStyle(Color.brand)
                            }
                            Spacer()
                            Text(model.calendar.formatClock(at: entry.doneAt)).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                    .tint(.primary)
                    .accessibilityLabel("\(model.describe(entry)) at \(model.calendar.formatClock(at: entry.doneAt)), edit")
                }
            }
        }
        .navigationTitle(DayKey.format(day, weekday: true, year: day.prefix(4) != model.today.prefix(4)))
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editing) { SetEditorView(model: model, entry: $0.entry) }
    }
}
