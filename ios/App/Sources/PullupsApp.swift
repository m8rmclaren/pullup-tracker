import SwiftUI
import TrackerCore

@main
struct PullupsApp: App {
    @State private var model: AppModel? = {
        do {
            return try AppModel.live()
        } catch {
            return nil
        }
    }()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if let model {
                    RootView(model: model)
                } else {
                    ContentUnavailableView("Can't open this device's data", systemImage: "exclamationmark.triangle", description: Text("Reinstalling the app may help. Sets already synced are safe on the server."))
                }
            }
            .tint(.brand)
            .fontDesign(.rounded)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: model?.enterForeground()
            case .background: model?.enterBackground()
            default: break
            }
        }
    }
}

struct RootView: View {
    let model: AppModel

    var body: some View {
        NavigationStack {
            TodayView(model: model)
        }
        .task { await model.watchChanges() }
        .task {
            // Keeps "today" current and syncs every minute while the app is open.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                model.tick()
                model.syncNow()
            }
        }
    }
}

extension Color {
    static let brand = Color(red: 57 / 255, green: 135 / 255, blue: 229 / 255)
}
