import SwiftUI

@main
struct WanderingGalleryApp: App {
    @State private var servers = ServerStore()

    init() {
        // Thumbnails and media are cached on disk by URL (the URLs are versioned).
        URLCache.shared = URLCache(memoryCapacity: 64 * 1024 * 1024, diskCapacity: 1024 * 1024 * 1024)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(servers)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}

/// Picks the backend, then shows the app for it (rebuilt from scratch when it changes).
struct RootView: View {
    @Environment(ServerStore.self) private var servers

    var body: some View {
        if let server = servers.current, let url = server.baseURL {
            MainView(model: AppModel(server: server, baseURL: url))
                .id(server)
        } else {
            NavigationStack {
                ServerEditor(server: nil, firstRun: true)
            }
        }
    }
}

struct MainView: View {
    @State var model: AppModel

    var body: some View {
        TabView(selection: $model.tab) {
            GalleryRoot()
                .tabItem { Label("Gallery", systemImage: "photo.on.rectangle") }
                .tag(AppTab.gallery)
            GenerateRoot()
                .tabItem { Label("Generate", systemImage: "sparkles") }
                .tag(AppTab.generate)
            DashboardView()
                .tabItem { Label("Dashboard", systemImage: "gauge.with.dots.needle.33percent") }
                .tag(AppTab.dashboard)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(AppTab.settings)
        }
        .environment(model)
        .task { await model.start() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            Task { await model.refresh() }
        }
    }
}
