import Foundation

nonisolated struct APIError: LocalizedError, Sendable {
    let message: String
    /// HTTP status (0: no response).
    let status: Int
    /// The JSON body of an error response (e.g. a caption conflict's current state).
    var body: Data? = nil

    var errorDescription: String? { message }
}

/// Which assets a grid shows (the web app's `Query`).
nonisolated struct AssetQuery: Hashable, Sendable {
    var library: String?
    var folder: String?
    var recursive = true
    var favorite = false
    var minRating = 0
    var kind: AssetKind?
    var caption: CaptionFilter?
    var tag: String?
    var ascending = false

    func items(cursor: String?, limit: Int) -> [URLQueryItem] {
        var q: [URLQueryItem] = []
        func add(_ name: String, _ value: String?) {
            if let value, !value.isEmpty { q.append(URLQueryItem(name: name, value: value)) }
        }
        add("library", library)
        add("folder", folder)
        if !recursive { add("recursive", "0") }
        if favorite { add("favorite", "1") }
        if minRating > 0 { add("minRating", String(minRating)) }
        add("kind", kind?.rawValue)
        add("caption", caption?.rawValue)
        add("tag", tag)
        if ascending { add("order", "asc") }
        add("cursor", cursor)
        add("limit", String(limit))
        return q
    }
}

/// The server's JSON API. One per backend; the CSRF token is fetched on first use and
/// refreshed once when the server has restarted (it rotates on every start).
final class APIClient: Sendable {
    let baseURL: URL
    let session: URLSession
    private let csrf = Locked<String?>(nil)

    nonisolated init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    nonisolated func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let basePath = c.percentEncodedPath.hasSuffix("/") ? String(c.percentEncodedPath.dropLast()) : c.percentEncodedPath
        c.percentEncodedPath = basePath + path
        if !query.isEmpty { c.queryItems = query }
        return c.url!
    }

    nonisolated func thumbURL(_ a: AssetRef) -> URL { url("/api/assets/\(a.id)/thumb", query: [URLQueryItem(name: "v", value: a.v)]) }
    nonisolated func fileURL(_ a: AssetRef) -> URL { url("/api/assets/\(a.id)/file", query: [URLQueryItem(name: "v", value: a.v)]) }
    nonisolated func previewURL(_ a: AssetRef) -> URL { url("/api/assets/\(a.id)/preview", query: [URLQueryItem(name: "v", value: a.v)]) }
    /// What the viewer shows for an image (a browser-friendly preview for e.g. AVIF or huge files).
    nonisolated func displayURL(_ a: Asset) -> URL { a.needsPreview ? previewURL(a) : fileURL(a) }

    // MARK: Plumbing

    nonisolated func fetchSession() async throws -> Session {
        let s: Session = try await send("GET", "/api/session")
        csrf.set(s.csrf)
        return s
    }

    nonisolated func send<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil, retried: Bool = false) async throws -> T {
        let data = try await raw(method, path, query: query, body: body, retried: retried)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(message: "Unexpected response from the server (\(path)): \(error)", status: 200)
        }
    }

    nonisolated func raw(_ method: String, _ path: String, query: [URLQueryItem] = [], body: (any Encodable)? = nil, retried: Bool = false) async throws -> Data {
        var req = URLRequest(url: url(path, query: query))
        req.httpMethod = method
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if method != "GET" {
            let token: String
            if let t = csrf.get() { token = t } else { token = try await fetchSession().csrf }
            req.setValue(token, forHTTPHeaderField: "X-CSRF-Token")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try body.map { try JSONEncoder().encode($0) } ?? Data("{}".utf8)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError(message: "Network error: \(error.localizedDescription)", status: 0)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            var msg = "\(status) \(HTTPURLResponse.localizedString(forStatusCode: status))"
            if let e = try? JSONDecoder().decode(ErrorBody.self, from: data), let m = e.error { msg = m }
            else if status == 421, let text = String(data: data, encoding: .utf8) { msg = text }
            // The server restarted and rotated its token: fetch a new one and retry once.
            if status == 403, msg.lowercased().contains("csrf"), !retried {
                csrf.set(nil)
                return try await raw(method, path, query: query, body: body, retried: true)
            }
            throw APIError(message: msg, status: status, body: data)
        }
        return data
    }

    private nonisolated struct ErrorBody: Decodable { let error: String? }
}

/// A tiny lock-protected box, for state shared across concurrent requests.
nonisolated final class Locked<T: Sendable>: @unchecked Sendable {
    private var value: T
    private let lock = NSLock()
    init(_ value: T) { self.value = value }
    func get() -> T { lock.withLock { value } }
    func set(_ v: T) { lock.withLock { value = v } }
}

// MARK: - Endpoints (web/src/client/*/api.ts)

extension APIClient {
    nonisolated struct OK: Decodable, Sendable {}
    nonisolated struct LibrariesResponse: Decodable, Sendable { let libraries: [Library] }
    nonisolated struct FoldersResponse: Decodable, Sendable { let folders: [Folder] }
    nonisolated struct TagsResponse: Decodable, Sendable { let tags: [Tag] }
    nonisolated struct TrashResponse: Decodable, Sendable { let retentionDays: Int; let items: [Asset] }
    nonisolated struct MarkdownResponse: Decodable, Sendable { let text: String; let refs: [String: Asset?] }
    nonisolated struct RenameResponse: Decodable, Sendable { let id: Int; let name: String; let merged: Bool }
    nonisolated struct PurgeAllResponse: Decodable, Sendable { let deleted: Int; let failed: Int; let error: String? }

    nonisolated func libraries() async throws -> [Library] { try await (send("GET", "/api/libraries") as LibrariesResponse).libraries }
    nonisolated func status() async throws -> ServerStatus { try await send("GET", "/api/status") }
    nonisolated func folders(library: String, folder: String) async throws -> [Folder] {
        try await (send("GET", "/api/folders", query: [URLQueryItem(name: "library", value: library), URLQueryItem(name: "folder", value: folder)]) as FoldersResponse).folders
    }
    nonisolated func assets(_ q: AssetQuery, cursor: String? = nil, limit: Int = 120) async throws -> AssetPage {
        try await send("GET", "/api/assets", query: q.items(cursor: cursor, limit: limit))
    }
    nonisolated func asset(_ id: Int) async throws -> Asset { try await send("GET", "/api/assets/\(id)") }
    nonisolated func markdown(_ id: Int) async throws -> MarkdownResponse { try await send("GET", "/api/assets/\(id)/markdown") }
    nonisolated func metadata(_ id: Int) async throws -> MetadataResponse { try await send("GET", "/api/assets/\(id)/metadata") }
    /// The raw ComfyUI `prompt` or `workflow` JSON.
    nonisolated func rawMetadata(_ id: Int, which: String) async throws -> String {
        String(decoding: try await raw("GET", "/api/assets/\(id)/raw/\(which)"), as: UTF8.self)
    }
    nonisolated func caption(_ id: Int) async throws -> CaptionResponse { try await send("GET", "/api/assets/\(id)/caption") }
    /// `loaded` is the caption the edit is based on (for the server's conflict check).
    nonisolated func captionAction(_ id: Int, _ action: CaptionAction, loaded: CaptionResponse, caption: String? = nil, approve: Bool? = nil) async throws -> CaptionResponse {
        struct Body: Encodable {
            let action: String; let caption: String?; let approve: Bool?
            let updated_at: String?; let txt_sha256: String?; let json_sha256: String?
        }
        return try await send("POST", "/api/assets/\(id)/caption", body: Body(
            action: action.rawValue, caption: caption, approve: approve,
            updated_at: loaded.updated_at, txt_sha256: loaded.txt_sha256, json_sha256: loaded.json_sha256))
    }
    nonisolated func favorite(_ id: Int, _ favorite: Bool) async throws -> Asset {
        try await send("POST", "/api/assets/\(id)/favorite", body: ["favorite": favorite])
    }
    nonisolated func rate(_ id: Int, _ rating: Int) async throws -> Asset {
        try await send("POST", "/api/assets/\(id)/rating", body: ["rating": rating])
    }
    nonisolated func tags() async throws -> [Tag] { try await (send("GET", "/api/tags") as TagsResponse).tags }
    /// Unknown names in `add` create new tags.
    nonisolated func setTags(_ id: Int, add: [String] = [], remove: [String] = []) async throws -> Asset {
        try await send("POST", "/api/assets/\(id)/tags", body: ["add": add, "remove": remove])
    }
    nonisolated func renameTag(_ id: Int, to name: String) async throws -> RenameResponse {
        try await send("POST", "/api/tags/\(id)/rename", body: ["name": name])
    }
    nonisolated func hideTag(_ id: Int, _ hidden: Bool) async throws {
        let _: OK = try await send("POST", "/api/tags/\(id)/hidden", body: ["hidden": hidden])
    }
    nonisolated func deleteTag(_ id: Int) async throws {
        let _: OK = try await send("POST", "/api/tags/\(id)/delete")
    }
    nonisolated func hide(_ id: Int, _ hidden: Bool) async throws -> Asset {
        try await send("POST", "/api/assets/\(id)/hidden", body: ["hidden": hidden])
    }
    nonisolated func unlock(_ passphrase: String) async throws -> Session {
        try await send("POST", "/api/unlock", body: ["passphrase": passphrase])
    }
    nonisolated func lock() async throws -> Session { try await send("POST", "/api/lock") }
    nonisolated func trash(_ a: Asset) async throws -> Asset {
        struct Body: Encodable { let size: Int; let mtimeMs: Double }
        return try await send("POST", "/api/assets/\(a.id)/trash", body: Body(size: a.size, mtimeMs: a.mtimeMs))
    }
    nonisolated func trashList() async throws -> TrashResponse { try await send("GET", "/api/trash") }
    nonisolated func restore(_ id: Int) async throws -> Asset { try await send("POST", "/api/trash/\(id)/restore") }
    nonisolated func purge(_ id: Int) async throws {
        let _: OK = try await send("POST", "/api/trash/\(id)/purge")
    }
    nonisolated func purgeAll() async throws -> PurgeAllResponse { try await send("POST", "/api/trash/purge-all") }
    nonisolated func rescan(library: String? = nil) async throws {
        let _: OK = try await send("POST", "/api/rescan", body: library.map { ["library": $0] } ?? [:])
    }

    // Generate
    nonisolated struct FlowsResponse: Decodable, Sendable { let flows: [FlowInfo] }
    nonisolated struct TagsResult: Decodable, Sendable { let tags: String }
    nonisolated struct RunsResponse: Decodable, Sendable { let runs: [Run] }
    nonisolated struct VideoImageResponse: Decodable, Sendable { let asset: Asset }

    nonisolated func flows() async throws -> [FlowInfo] { try await (send("GET", "/api/generate/flows") as FlowsResponse).flows }
    nonisolated func comfyStatus() async throws -> ComfyStatus { try await send("GET", "/api/generate/status") }
    nonisolated func generateTags(flow: String, prompt: String, vary: Bool) async throws -> String {
        struct Body: Encodable { let prompt: String; let vary: Bool }
        return try await (send("POST", "/api/generate/flows/\(flow)/tags", body: Body(prompt: prompt, vary: vary)) as TagsResult).tags
    }
    nonisolated func startRun(flow: String, prompt: String, variations: [String], batch: Int) async throws -> Run {
        struct Body: Encodable { let prompt: String; let variations: [String]; let batch: Int }
        return try await send("POST", "/api/generate/flows/\(flow)/runs", body: Body(prompt: prompt, variations: variations, batch: batch))
    }
    /// The gallery image at a path (as copied in the viewer).
    nonisolated func videoImage(path: String) async throws -> Asset {
        try await (send("POST", "/api/generate/video/image", body: ["path": path]) as VideoImageResponse).asset
    }
    nonisolated func startVideo(flow: String, image: String, prompt: String, seconds: Int, batch: Int) async throws -> Run {
        struct Body: Encodable { let image: String; let prompt: String; let seconds: Int; let batch: Int }
        return try await send("POST", "/api/generate/flows/\(flow)/runs", body: Body(image: image, prompt: prompt, seconds: seconds, batch: batch))
    }
    /// Runs still being worked on.
    nonisolated func runs() async throws -> [Run] { try await (send("GET", "/api/generate/runs") as RunsResponse).runs }
    nonisolated func run(_ id: String) async throws -> Run { try await send("GET", "/api/generate/runs/\(id)") }
    nonisolated func cancelRun(_ id: String) async throws -> Run { try await send("POST", "/api/generate/runs/\(id)/cancel") }

    // Dashboard
    nonisolated func dashboard() async throws -> Dashboard { try await send("GET", "/api/dashboard") }
    nonisolated func cancelJob(_ id: String) async throws {
        let enc = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
        let _: OK = try await send("POST", "/api/dashboard/jobs/\(enc)/cancel")
    }
}
