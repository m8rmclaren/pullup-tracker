import SwiftUI
import TrackerCore

/// A past session loaded for repeating: each Log logs the current item and moves on.
private struct SessionQueue {
    var items: [SetTemplate]
    var index = 0
    var current: SetTemplate { items[index] }
}

private enum Sheet: Identifiable {
    case exercisePicker, variationPicker, addedWeight, signIn, settings
    case edit(Entry)

    var id: String {
        switch self {
        case .exercisePicker: "exercisePicker"
        case .variationPicker: "variationPicker"
        case .addedWeight: "addedWeight"
        case .signIn: "signIn"
        case .settings: "settings"
        case .edit(let entry): "edit-\(entry.id)"
        }
    }
}

/// A second tap this soon after the last one is almost always a fat finger, not a new set.
private let doubleTapGuard: Duration = .milliseconds(600)
private let recentExerciseChips = 4
private let recentVariationChips = 4
private let sessionsOffered = 2

struct TodayView: View {
    let model: AppModel

    @State private var chosenAmount: Int?
    @State private var queue: SessionQueue?
    @State private var sheet: Sheet?
    @State private var timerStartedAt: Date?
    @State private var lastTapAt = ContinuousClock.now - .seconds(10)
    @State private var logCount = 0

    private var context: SetContext {
        queue.map { $0.current.context } ?? model.padContext
    }

    private var exercise: ExerciseInfo? { model.exercise(context.exerciseId) }
    private var isTimed: Bool { exercise?.measure == .time }

    private var usual: Int? {
        usualAmount(model.entries, context: context, nowMs: model.nowMs, calendar: model.calendar)
    }

    private var padAmounts: [Int] {
        isTimed ? padHoldSeconds(usual: usual) : padCounts(usual: usual, unit: exercise?.unit)
    }

    private var amount: Int {
        chosenAmount ?? queue.flatMap { $0.current.reps ?? $0.current.holdSeconds } ?? usual ?? padAmounts[2]
    }

    private var addedWeightLbs: Double {
        queue.map { $0.current.addedWeightLbs ?? 0 } ?? model.padAddedWeightLbs(exerciseId: context.exerciseId)
    }

    private var logLabel: String {
        let amountLabel = isTimed ? formatHoldSeconds(amount) : formatCount(amount, unit: exercise?.unit)
        let configuration = context.variationIds.map { model.variationName(exerciseId: context.exerciseId, variationId: $0) }.joined(separator: ", ")
        var label = [amountLabel, model.exerciseName(context.exerciseId), configuration].filter { !$0.isEmpty }.joined(separator: " · ")
        if addedWeightLbs > 0 { label += " @ \(formatAddedWeight(addedWeightLbs))" }
        return label
    }

    var body: some View {
        let stats = model.stats
        ScrollView {
            VStack(spacing: 20) {
                RingHeader(reps: stats.today.reps, goal: model.goalReps, setCount: model.todaysSets.count, streak: stats.streak)
                if !model.isSignedIn {
                    Button { sheet = .signIn } label: {
                        Text("Logging works offline. **Sign in or create an account** to back up, sync across devices and add friends.")
                            .font(.subheadline)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(Color.brand.opacity(0.12), in: .rect(cornerRadius: 14))
                    }
                    .buttonStyle(.plain)
                }
                pad
                todaysSetsSection
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.immediately)
        .navigationTitle(DayKey.format(model.today, weekday: true))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { SyncStatusBadge(model: model) }
            ToolbarItem(placement: .topBarTrailing) {
                Button { sheet = .settings } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
        }
        .overlay(alignment: .bottom) { undoToast }
        .sensoryFeedback(.impact(weight: .medium), trigger: logCount)
        .onChange(of: context) { chosenAmount = nil }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .exercisePicker:
                ExercisePickerView(model: model) { exerciseId in
                    changeContext(lastContext(for: exerciseId, in: model.entries))
                }
            case .variationPicker:
                VariationPickerView(model: model, context: context) { changeContext($0) }
            case .addedWeight:
                AddedWeightView(addedWeightLbs: addedWeightLbs, exerciseName: model.exerciseName(context.exerciseId)) { model.setPadAddedWeight($0, exerciseId: context.exerciseId) }
            case .signIn:
                SignInView(model: model)
            case .settings:
                SettingsView(model: model) { self.sheet = .signIn }
            case .edit(let entry):
                SetEditorView(model: model, entry: entry)
            }
        }
    }

    // MARK: - Pad

    private var pad: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let queue {
                HStack {
                    Text("Set \(queue.index + 1) of \(queue.items.count)").font(.subheadline.weight(.semibold))
                    Spacer()
                    Button("Skip") { advanceQueue() }
                    Button("Stop", role: .cancel) { self.queue = nil }.foregroundStyle(.secondary)
                }
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                ForEach(padAmounts, id: \.self) { padAmount in
                    PadButton(
                        label: isTimed ? formatHoldSeconds(padAmount) : String(padAmount),
                        unit: !isTimed && exercise?.unit != nil && exercise?.unit != Catalog.ringUnit ? "\(exercise!.unit!)s" : nil,
                        isOn: padAmount == amount,
                        isUsual: padAmount == usual
                    ) { chosenAmount = padAmount }
                }
            }

            if isTimed { holdTimer }

            ChipRow {
                ForEach(recentExercises, id: \.self) { exerciseId in
                    Chip(model.exerciseName(exerciseId), isOn: exerciseId == context.exerciseId) {
                        if exerciseId != context.exerciseId { changeContext(lastContext(for: exerciseId, in: model.entries)) }
                    }
                }
                Chip("More…", isOn: false) { sheet = .exercisePicker }
            }

            ChipRow {
                ForEach(variationChips, id: \.self) { variationId in
                    Chip(model.variationName(exerciseId: context.exerciseId, variationId: variationId), isOn: context.variationIds.contains(variationId)) {
                        changeContext(SetContext(exerciseId: context.exerciseId, variationIds: toggleVariation(context.variationIds, variationId)))
                    }
                }
                Chip(variationChips.isEmpty ? "+ Configuration" : "+", isOn: false) { sheet = .variationPicker }
                    .accessibilityLabel("Add a configuration")
                Chip(addedWeightLbs > 0 ? formatAddedWeight(addedWeightLbs) : "BW", isOn: addedWeightLbs > 0) { sheet = .addedWeight }
                    .disabled(queue != nil)
                    .accessibilityLabel(addedWeightLbs > 0 ? "Added weight \(formatAddedWeight(addedWeightLbs)). Change" : "Bodyweight. Add weight")
            }

            Button(action: logSet) {
                Text("Log \(logLabel)")
                    .font(.headline)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 54)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 16))

            if queue == nil {
                ChipRow {
                    if let previous = lastSet(model.entries) {
                        Chip("↻ \(model.formattedAmount(previous)) \(model.exerciseName(previous.resolvedExerciseId))", isOn: false) { repeatLastSet(previous) }
                            .accessibilityLabel("Repeat last set: \(model.describe(previous))")
                    }
                    ForEach(repeatableSessions(model.entries, nowMs: model.nowMs, limit: sessionsOffered), id: \.startMs) { session in
                        Chip("↻ \(sessionDayLabel(session.startMs)) · \(session.entries.count) sets", isOn: false) {
                            queue = SessionQueue(items: session.entries.map(\.template))
                        }
                    }
                }
            }
        }
        .padding(16)
        .background(.background.secondary, in: .rect(cornerRadius: 22))
    }

    private var holdTimer: some View {
        TimelineView(.periodic(from: .now, by: 0.25)) { timeline in
            Button {
                if let timerStartedAt {
                    chosenAmount = min(EntryLimits.maxHoldSeconds, max(1, Int(timeline.date.timeIntervalSince(timerStartedAt).rounded())))
                    self.timerStartedAt = nil
                } else {
                    timerStartedAt = timeline.date
                }
            } label: {
                Text(timerStartedAt.map { "Stop · \(formatHoldSeconds(max(0, Int(timeline.date.timeIntervalSince($0)))))" } ?? "Start timer")
                    .font(.headline.monospacedDigit())
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(timerStartedAt == nil ? .brand : .orange)
        }
    }

    private var recentExercises: [String] {
        let others = recentExerciseIds(model.entries, limit: recentExerciseChips + 1).filter { $0 != context.exerciseId }
        return Array(([context.exerciseId] + others).prefix(recentExerciseChips))
    }

    private var variationChips: [String] {
        var chips = context.variationIds
        for variationId in recentVariationIds(model.entries, exerciseId: context.exerciseId, limit: recentVariationChips) where !chips.contains(variationId) {
            chips.append(variationId)
        }
        return chips
    }

    // MARK: - Today's sets

    private var todaysSetsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            let sets = model.todaysSets
            if sets.isEmpty {
                Text("No sets yet today. Pick a number and Log after each set.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            } else {
                ForEach(sets, id: \.id) { entry in
                    Button { sheet = .edit(entry) } label: {
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
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .background(.background.secondary, in: .rect(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(model.describe(entry)) at \(model.calendar.formatClock(at: entry.doneAt)), edit")
                }
            }
        }
    }

    @ViewBuilder
    private var undoToast: some View {
        if let logged = model.justLogged {
            HStack {
                Text("Logged \(model.describe(logged))").lineLimit(1)
                Spacer()
                Button("Undo") { model.undoLastLog() }.fontWeight(.semibold)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 48)
            .background(.thickMaterial, in: .capsule)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: logged.id) {
                try? await Task.sleep(for: .seconds(4))
                if model.justLogged?.id == logged.id { model.dismissUndo() }
            }
        }
    }

    // MARK: - Actions

    private func isTapGuarded() -> Bool {
        let now = ContinuousClock.now
        if now - lastTapAt < doubleTapGuard { return true }
        lastTapAt = now
        return false
    }

    private func changeContext(_ next: SetContext) {
        guard var queue else {
            model.setPadContext(next)
            return
        }
        let current = queue.current
        let isSameMeasure = model.exercise(next.exerciseId)?.measure == model.exercise(current.context.exerciseId)?.measure
        queue.items[queue.index] = isSameMeasure
            ? SetTemplate(context: next, reps: current.reps, holdSeconds: current.holdSeconds, addedWeightLbs: current.addedWeightLbs)
            : SetTemplate(context: next, addedWeightLbs: current.addedWeightLbs)
        self.queue = queue
    }

    private func logSet() {
        guard !isTapGuarded() else { return }
        logCount += 1
        var template = SetTemplate(context: context, addedWeightLbs: addedWeightLbs > 0 ? addedWeightLbs : nil)
        if isTimed { template.holdSeconds = amount } else { template.reps = amount }
        model.log(template)
        if queue != nil { advanceQueue() }
    }

    private func repeatLastSet(_ previous: Entry) {
        guard !isTapGuarded() else { return }
        logCount += 1
        model.log(previous.template)
    }

    private func advanceQueue() {
        guard var queue else { return }
        if queue.index + 1 < queue.items.count {
            queue.index += 1
            self.queue = queue
        } else {
            self.queue = nil
        }
        chosenAmount = nil
    }

    private func sessionDayLabel(_ startMs: Int64) -> String {
        let day = model.calendar.dayKey(at: startMs)
        if day == model.today { return "Earlier" }
        if day == DayKey.adding(-1, to: model.today) { return "Yesterday" }
        return String(DayKey.format(day, weekday: true).prefix(3))
    }
}

// MARK: - Pieces

private struct RingHeader: View {
    let reps: Int
    let goal: Int
    let setCount: Int
    let streak: Int

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle().stroke(Color.secondary.opacity(0.18), lineWidth: 16)
                Circle()
                    .trim(from: 0, to: min(1, Double(reps) / Double(max(goal, 1))))
                    .stroke(Color.brand, style: StrokeStyle(lineWidth: 16, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.spring(duration: 0.5), value: reps)
                VStack(spacing: 2) {
                    Text("\(reps)")
                        .font(.system(size: 56, weight: .bold, design: .rounded).monospacedDigit())
                        .contentTransition(.numericText(value: Double(reps)))
                        .animation(.snappy, value: reps)
                    Text(reps < goal ? "\(goal - reps) to go" : reps == goal ? "Goal hit" : "+\(reps - goal) over goal")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 190, height: 190)
            .accessibilityElement(children: .combine)

            HStack(spacing: 18) {
                Text("**\(setCount)** \(setCount == 1 ? "set" : "sets")")
                Text("Goal **\(goal)**")
                Text("Streak **\(streak)** \(streak == 1 ? "day" : "days")")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .padding(.top, 8)
    }
}

private struct PadButton: View {
    let label: String
    let unit: String?
    let isOn: Bool
    let isUsual: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 0) {
                Text(label).font(.title2.weight(.semibold).monospacedDigit())
                if let unit { Text(unit).font(.caption2).foregroundStyle(isOn ? .white.opacity(0.8) : .secondary) }
            }
            .frame(maxWidth: .infinity, minHeight: 58)
            .foregroundStyle(isOn ? .white : .primary)
            .background(isOn ? Color.brand : Color.secondary.opacity(0.12), in: .rect(cornerRadius: 14))
            .overlay(alignment: .topTrailing) {
                if isUsual && !isOn {
                    Circle().fill(Color.brand).frame(width: 6, height: 6).padding(8)
                }
            }
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: isOn)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

struct Chip: View {
    let title: String
    let isOn: Bool
    let action: () -> Void

    init(_ title: String, isOn: Bool, action: @escaping () -> Void) {
        self.title = title
        self.isOn = isOn
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
                .padding(.horizontal, 14)
                .frame(minHeight: 36)
                .foregroundStyle(isOn ? Color.brand : .primary)
                .background(isOn ? Color.brand.opacity(0.16) : Color.secondary.opacity(0.12), in: .capsule)
                .overlay { if isOn { Capsule().stroke(Color.brand.opacity(0.6), lineWidth: 1) } }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

struct ChipRow<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) { content }
        }
        .scrollClipDisabled()
    }
}

private struct SyncStatusBadge: View {
    let model: AppModel

    var body: some View {
        switch model.status {
        case .synced, .unconfigured:
            EmptyView()
        case .syncing, .pending:
            Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(.secondary).accessibilityLabel("Syncing")
        case .offline:
            Image(systemName: "icloud.slash").foregroundStyle(.secondary).accessibilityLabel("Offline; sets are saved here and sync later")
        case .auth:
            Image(systemName: "person.crop.circle.badge.exclamationmark").foregroundStyle(.orange).accessibilityLabel("Signed out; sign in again")
        case .outdated:
            Image(systemName: "exclamationmark.arrow.circlepath").foregroundStyle(.orange).accessibilityLabel("Update the app to keep syncing")
        }
    }
}
