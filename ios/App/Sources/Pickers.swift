import SwiftUI
import TrackerCore

/// Every exercise, searchable, with a way to make a new one.
struct ExercisePickerView: View {
    let model: AppModel
    let onPick: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var isCreating = false

    private var results: [KnownExercise] {
        query.isEmpty ? model.allExercises : searchNames(query, in: model.allExercises)
    }

    /// Typing an exercise's own name means that exercise, not a new one.
    private var hasExactMatch: Bool {
        let key = nameKey(query)
        return !key.isEmpty && model.allExercises.contains { nameKey($0.name) == key }
    }

    var body: some View {
        NavigationStack {
            List {
                if !hasExactMatch {
                    Section {
                        Button { isCreating = true } label: {
                            Label(query.isEmpty ? "New exercise" : "New exercise “\(query)”", systemImage: "plus")
                        }
                    }
                }
                Section {
                    ForEach(results, id: \.id) { exercise in
                        Button {
                            onPick(exercise.id)
                            dismiss()
                        } label: {
                            HStack {
                                Text(exercise.name)
                                Spacer()
                                Text(exercise.measure == .time ? "timed" : exercise.unit == Catalog.ringUnit ? "reps" : "\(exercise.unit ?? "")s")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .tint(.primary)
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search exercises")
            .navigationTitle("Exercise")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .sheet(isPresented: $isCreating) {
                NewExerciseView(model: model, initialName: query) { exerciseId in
                    onPick(exerciseId)
                    dismiss()
                }
            }
        }
    }
}

struct NewExerciseView: View {
    let model: AppModel
    let onCreated: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var measure = Measure.count
    @State private var unit = ""
    @State private var description = ""
    @State private var isSaving = false

    init(model: AppModel, initialName: String, onCreated: @escaping (String) -> Void) {
        self.model = model
        self.onCreated = onCreated
        _name = State(initialValue: initialName)
    }

    private var cleanedName: String? { cleanName(name, maxLength: DefinitionLimits.maxNameLength) }
    /// Left empty, a count is in reps.
    private var cleanedUnit: String? { unit.isEmpty ? Catalog.ringUnit : cleanName(unit.lowercased(), maxLength: DefinitionLimits.maxUnitLength) }
    private var existing: KnownExercise? { matchName(name, in: model.allExercises) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name, like Red Rocks stairs", text: $name)
                    if let existing, !isSaving {
                        Text("You already have **\(existing.name)**. Logging to it keeps everyone on one board.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                Section("Measured in") {
                    Picker("Measured in", selection: $measure) {
                        Text("Count").tag(Measure.count)
                        Text("Time").tag(Measure.time)
                    }
                    .pickerStyle(.segmented)
                    if measure == .count {
                        TextField("rep", text: $unit, prompt: Text("rep (or lap, flight…)"))
                            .textInputAutocapitalization(.never)
                    }
                }
                Section("Description (optional)") {
                    TextField("What counts as one", text: $description, axis: .vertical)
                }
            }
            .navigationTitle("New exercise")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }
                        .disabled(cleanedName == nil || (measure == .count && cleanedUnit == nil) || isSaving)
                }
            }
        }
    }

    private func create() {
        guard let cleanedName else { return }
        isSaving = true
        let unit = measure == .count ? cleanedUnit : nil
        let description = description.isEmpty ? nil : cleanName(description, maxLength: DefinitionLimits.maxDescriptionLength)
        Task {
            if let exercise = try? await model.engine.createExercise(name: cleanedName, measure: measure, unit: unit, description: description) {
                onCreated(exercise.id)
            }
            dismiss()
        }
    }
}

/// Turns configurations on and off for the pad's exercise, and makes new ones.
struct VariationPickerView: View {
    let model: AppModel
    let onChange: (SetContext) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var context: SetContext
    @State private var newName = ""

    init(model: AppModel, context: SetContext, onChange: @escaping (SetContext) -> Void) {
        self.model = model
        self.onChange = onChange
        _context = State(initialValue: context)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("New configuration, like Into tuck", text: $newName)
                            .onSubmit(create)
                        Button("Add", action: create).disabled(cleanName(newName, maxLength: DefinitionLimits.maxNameLength) == nil)
                    }
                }
                Section(model.exerciseName(context.exerciseId)) {
                    ForEach(model.variations(of: context.exerciseId), id: \.id) { variation in
                        Button { toggle(variation.id) } label: {
                            HStack {
                                Text(variation.name)
                                Spacer()
                                if context.variationIds.contains(variation.id) { Image(systemName: "checkmark").foregroundStyle(Color.brand) }
                            }
                        }
                        .tint(.primary)
                    }
                }
            }
            .navigationTitle("Configuration")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func toggle(_ variationId: String) {
        context.variationIds = toggleVariation(context.variationIds, variationId)
        onChange(context)
    }

    private func create() {
        guard let name = cleanName(newName, maxLength: DefinitionLimits.maxNameLength) else { return }
        if let existing = matchName(name, in: model.variations(of: context.exerciseId)) {
            if !context.variationIds.contains(existing.id) { toggle(existing.id) }
            newName = ""
            return
        }
        newName = ""
        let exerciseId = context.exerciseId
        Task {
            if let variation = try? await model.engine.createVariation(exerciseId: exerciseId, name: name) {
                toggle(variation.id)
            }
        }
    }
}

/// The pad's added weight for one exercise, for today.
struct AddedWeightView: View {
    let exerciseName: String
    let onSave: (Double) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var addedWeightLbs: Double

    init(addedWeightLbs: Double, exerciseName: String, onSave: @escaping (Double) -> Void) {
        self.exerciseName = exerciseName
        self.onSave = onSave
        _addedWeightLbs = State(initialValue: addedWeightLbs)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Stepper(value: $addedWeightLbs, in: 0...EntryLimits.maxAddedWeightLbs, step: 2.5) {
                        Text(addedWeightLbs > 0 ? formatAddedWeight(addedWeightLbs) : "Bodyweight").font(.title3.monospacedDigit())
                    }
                    ChipRow {
                        ForEach([0, 10, 25, 35, 45], id: \.self) { pounds in
                            Chip(pounds == 0 ? "BW" : "+\(pounds)", isOn: addedWeightLbs == Double(pounds)) { addedWeightLbs = Double(pounds) }
                        }
                    }
                } footer: {
                    Text("Belt, vest or dumbbell, for \(exerciseName) today. It resets to bodyweight tomorrow, so a forgotten belt doesn't weight tomorrow's sets.")
                }
            }
            .navigationTitle("Added weight")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        onSave(addedWeightLbs)
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

/// Changes or deletes one set.
struct SetEditorView: View {
    let model: AppModel
    let entry: Entry

    @Environment(\.dismiss) private var dismiss
    @State private var amount: Int
    @State private var addedWeightLbs: Double
    @State private var doneAt: Date

    init(model: AppModel, entry: Entry) {
        self.model = model
        self.entry = entry
        _amount = State(initialValue: entry.amount)
        _addedWeightLbs = State(initialValue: entry.addedWeightLbs ?? 0)
        _doneAt = State(initialValue: Date(timeIntervalSince1970: Double(entry.doneAt) / 1000))
    }

    private var isTimed: Bool { entry.holdSeconds != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section(model.exerciseName(entry.resolvedExerciseId)) {
                    Stepper(value: $amount, in: isTimed ? EntryLimits.minHoldSeconds...EntryLimits.maxHoldSeconds : EntryLimits.minReps...EntryLimits.maxReps, step: isTimed ? 5 : 1) {
                        Text(isTimed ? formatHoldSeconds(amount) : formatCount(amount, unit: model.unit(of: entry.resolvedExerciseId))).font(.title3.monospacedDigit())
                    }
                    Stepper(value: $addedWeightLbs, in: 0...EntryLimits.maxAddedWeightLbs, step: 2.5) {
                        Text(addedWeightLbs > 0 ? formatAddedWeight(addedWeightLbs) : "Bodyweight")
                    }
                    DatePicker("Done at", selection: $doneAt, in: ...Date.now)
                }
                Section {
                    Button("Delete set", role: .destructive) {
                        model.run { try await $0.remove(id: entry.id) }
                        dismiss()
                    }
                }
            }
            .navigationTitle("Edit set")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: save) }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() {
        let id = entry.id
        let amount = amount
        let addedWeightLbs = addedWeightLbs
        let doneAtMs = Int64(doneAt.timeIntervalSince1970 * 1000)
        let isTimed = isTimed
        model.run { engine in
            try await engine.update(id: id, reps: isTimed ? nil : amount, holdSeconds: isTimed ? amount : nil, doneAt: doneAtMs, addedWeightLbs: addedWeightLbs)
        }
        dismiss()
    }
}
