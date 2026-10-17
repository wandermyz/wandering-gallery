import SwiftUI

enum AppTab: Hashable {
    case gallery, generate, dashboard, settings
}

/// State shared by every section for one backend: the client, libraries and server
/// status, the hidden-items unlock, and live updates.
@Observable
final class AppModel {
    let server: Server
    let client: APIClient

    var tab: AppTab = .gallery
    var libraries: [Library] = []
    var status: ServerStatus?
    var session: Session?
    /// When this device's unlock ends (nil: locked).
    var unlockedUntil: Date?
    var connectionError: String?
    /// Bumped on every live change event; views reload what they show.
    var changeCount = 0
    var lastChange: ChangeEvent?
    /// Bumped when what may be seen changes (unlock / lock): views reload from scratch.
    var visibilityEpoch = 0
    /// An image handed to the video flow from the viewer.
    var videoInput: Asset?

    private var listening = false

    init(server: Server, baseURL: URL) {
        self.server = server
        client = APIClient(baseURL: baseURL)
    }

    var hiddenEnabled: Bool { session?.hiddenEnabled ?? false }
    var unlocked: Bool { (unlockedUntil ?? .distantPast) > .now }

    func library(_ id: String?) -> Library? { libraries.first { $0.id == id } }

    func start() async {
        await refresh()
        guard !listening else { return }
        listening = true
        for await change in EventStream(client: client).changes() {
            lastChange = change
            changeCount += 1
            await loadLibraries()
            await loadStatus()
        }
    }

    func refresh() async {
        await syncSession()
        await loadLibraries()
        await loadStatus()
    }

    func loadLibraries() async {
        do {
            libraries = try await client.libraries()
            connectionError = nil
        } catch is CancellationError {
        } catch {
            connectionError = error.localizedDescription
        }
    }

    func loadStatus() async {
        status = try? await client.status()
    }

    func syncSession() async {
        guard let s = try? await client.fetchSession() else { return }
        apply(s)
    }

    func unlock(_ passphrase: String) async throws {
        apply(try await client.unlock(passphrase))
        visibilityChanged()
    }

    func lock() async {
        if let s = try? await client.lock() { apply(s) } else { unlockedUntil = nil }
        visibilityChanged()
    }

    /// Called when the countdown runs out.
    func unlockExpired() {
        guard unlockedUntil != nil else { return }
        unlockedUntil = nil
        visibilityChanged()
    }

    private func apply(_ s: Session) {
        session = s
        unlockedUntil = s.unlockedForMs > 0 ? Date.now.addingTimeInterval(s.unlockedForMs / 1000) : nil
    }

    private func visibilityChanged() {
        ImageLoader.shared.clearMemory()
        visibilityEpoch += 1
        Task { await loadLibraries() }
    }
}
