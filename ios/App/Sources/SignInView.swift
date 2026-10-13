import SwiftUI
import TrackerCore

/// Sign-up is a name and a passkey; signing in is the passkey alone. A device link from another
/// signed-in device works too, which is also the way in on the Simulator during development.
struct SignInView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var deviceLink = ""
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var ceremony = PasskeyCeremony()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Your name", text: $name)
                        .textContentType(.nickname)
                        .submitLabel(.go)
                        .onSubmit(createAccount)
                    Button("Create account with a passkey", action: createAccount)
                        .disabled(cleanName(name) == nil || isWorking)
                } header: {
                    Text("New here")
                } footer: {
                    Text("No email or phone number. Your passkey syncs through iCloud Keychain, so you can sign back in on a new phone.")
                }

                Section {
                    Button("Sign in with a passkey", action: signInWithPasskey)
                        .disabled(isWorking)
                }

                Section {
                    TextField("Paste a device link", text: $deviceLink)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Sign in with the link", action: redeemDeviceLink)
                        .disabled(Links.deviceCode(in: deviceLink) == nil || isWorking)
                } header: {
                    Text("From another device")
                } footer: {
                    Text("On a signed-in device, open Settings and make a device link.")
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .disabled(isWorking)
            .overlay { if isWorking { ProgressView() } }
            .navigationTitle("Sign in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func createAccount() {
        guard let cleanedName = cleanName(name) else { return }
        signIn {
            let options = try await model.api.signupOptions(SignupOptionsRequest(name: cleanedName, timeZone: model.engine.deviceTimeZone, dailyGoalReps: model.goalReps))
            let registration = try await ceremony.register(with: options)
            return try await model.api.finishSignup(registration, label: deviceLabel)
        }
    }

    private func signInWithPasskey() {
        signIn {
            let options = try await model.api.loginOptions()
            let assertion = try await ceremony.assert(with: options)
            return try await model.api.finishLogin(assertion, label: deviceLabel)
        }
    }

    private func redeemDeviceLink() {
        guard let code = Links.deviceCode(in: deviceLink) else { return }
        signIn { try await model.api.redeemDeviceLink(code: code) }
    }

    private func signIn(_ start: @escaping () async throws -> SessionResponse) {
        isWorking = true
        errorMessage = nil
        Task {
            defer { isWorking = false }
            do {
                try await model.signIn(with: try await start())
                dismiss()
            } catch {
                errorMessage = PasskeyCeremony.message(for: error)
            }
        }
    }
}

struct SettingsView: View {
    let model: AppModel
    let onSignIn: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var goal = DeviceSettings.defaultGoalReps
    @State private var name = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Daily goal") {
                    Stepper(value: $goal, in: 1...1000, step: 5) {
                        Text("\(goal) reps").monospacedDigit()
                    }
                }
                if model.isSignedIn {
                    Section("Account") {
                        TextField("Name", text: $name)
                        LabeledContent("Days kept in", value: model.timeZone)
                        LabeledContent("Sync", value: syncDescription)
                        if let lastError = model.lastError, model.status != .synced {
                            Text(lastError).font(.footnote).foregroundStyle(.secondary)
                        }
                        Button("Sync now") { model.syncNow() }
                    }
                    Section {
                        Button("Sign out", role: .destructive) {
                            model.run { try await $0.signOut() }
                            dismiss()
                        }
                    } footer: {
                        Text("Sets not yet synced stay on this device and go up when you sign back in.")
                    }
                } else {
                    Section {
                        Button("Sign in or create an account") {
                            dismiss()
                            onSignIn()
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        save()
                        dismiss()
                    }
                }
            }
            .onAppear {
                goal = model.goalReps
                name = model.accountName ?? ""
            }
        }
    }

    private var syncDescription: String {
        switch model.status {
        case .synced: "Up to date"
        case .syncing: "Syncing…"
        case .pending: "\(model.pendingCount) waiting"
        case .offline: "Offline, \(model.pendingCount) waiting"
        case .auth: "Signed out. Sign in again"
        case .outdated: "Update the app to sync"
        case .unconfigured: "Not signed in"
        }
    }

    private func save() {
        let newGoal = goal != model.goalReps ? goal : nil
        let newName = cleanName(name).flatMap { $0 != model.accountName ? $0 : nil }
        guard newGoal != nil || newName != nil else { return }
        model.run { try await $0.updateProfile(name: newName, dailyGoalReps: newGoal) }
    }
}
