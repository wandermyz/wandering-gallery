import Foundation
import Observation

/// A backend the app can talk to.
struct Server: Codable, Hashable, Identifiable {
    var id = UUID()
    var name: String
    var url: String

    /// The URL to use, or nil when `urlProblem` says why it can't be used.
    var baseURL: URL? { Self.parse(url).url }

    /// Why the URL can't be used (nil: it can).
    var urlProblem: String? { Self.parse(url).problem }

    /// HTTPS only (e.g. Tailscale Serve). Plain HTTP is allowed just for this device's own
    /// loopback address, for the simulator against a local dev server. No scheme means https.
    static func parse(_ text: String) -> (url: URL?, problem: String?) {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return (nil, "Enter the server's address.") }
        if !s.contains("://") { s = "https://" + s }
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), let host = u.host()?.lowercased(), !host.isEmpty else {
            return (nil, "That isn't a valid address.")
        }
        switch scheme {
        case "https":
            return (u, nil)
        case "http" where ["localhost", "127.0.0.1", "::1"].contains(host):
            return (u, nil)
        case "http":
            return (nil, "Use https://. Put the server behind Tailscale Serve (or another HTTPS proxy); plain HTTP is only allowed for localhost.")
        default:
            return (nil, "Use an https:// address.")
        }
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
