import Foundation
import Observation

/// A backend the app can talk to.
struct Server: Codable, Hashable, Identifiable {
    var id = UUID()
    var name: String
    var url: String

    var baseURL: URL? {
        var s = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.contains("://") { s = "https://" + s }
        guard let u = URL(string: s), let scheme = u.scheme, ["http", "https"].contains(scheme.lowercased()), u.host != nil else { return nil }
        return u
    }
}

/// The saved backends and which one is in use, kept in UserDefaults.
@Observable
final class ServerStore {
    private(set) var servers: [Server]
    private(set) var currentID: UUID?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        servers = (defaults.data(forKey: "servers").flatMap { try? JSONDecoder().decode([Server].self, from: $0) }) ?? []
        currentID = defaults.string(forKey: "currentServer").flatMap(UUID.init(uuidString:))
        // UI tests (and a first launch from the command line) can point at a server directly.
        if let arg = ProcessInfo.processInfo.environment["WG_SERVER_URL"] {
            if let s = servers.first(where: { $0.url == arg }) {
                currentID = s.id
            } else {
                let s = Server(name: "Test server", url: arg)
                servers.append(s)
                currentID = s.id
            }
            save()
        }
        if current == nil { currentID = servers.first?.id }
    }

    var current: Server? { servers.first { $0.id == currentID } }

    func select(_ s: Server) {
        currentID = s.id
        save()
    }

    /// Adds or updates (by id).
    func upsert(_ s: Server) {
        if let i = servers.firstIndex(where: { $0.id == s.id }) { servers[i] = s } else { servers.append(s) }
        if currentID == nil { currentID = s.id }
        save()
    }

    func remove(_ s: Server) {
        servers.removeAll { $0.id == s.id }
        if currentID == s.id { currentID = servers.first?.id }
        save()
    }

    private func save() {
        defaults.set(try? JSONEncoder().encode(servers), forKey: "servers")
        defaults.set(currentID?.uuidString, forKey: "currentServer")
    }
}
