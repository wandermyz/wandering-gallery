import Foundation

// Mirrors of the server's JSON (web/src/client/*/api.ts). Field names match the wire
// format; optional where the server may send null or leave the key out.

nonisolated struct Library: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let name: String
    let writable: Bool
    let recursive: Bool
    let showInAll: Bool
    /// Only listed while unlocked.
    let hidden: Bool
    let count: Int
    let images: Int
    let videos: Int
    let audio: Int
    let documents: Int
    let available: Bool
    let error: String?
    let scanning: Bool
    let lastScanMs: Double?
}

nonisolated enum AssetKind: String, Codable, Hashable, Sendable, CaseIterable {
    case image, video, audio, markdown
}

nonisolated enum CaptionStatus: String, Codable, Hashable, Sendable, CaseIterable {
    case generated, edited, approved, needs_regen
    /// An unreadable caption json.
    case unknown

    var label: String {
        switch self {
        case .generated: "Generated"
        case .edited: "Edited"
        case .approved: "Approved"
        case .needs_regen: "Needs regen"
        case .unknown: "Unreadable"
        }
    }
}

/// What a thumbnail / file URL needs.
nonisolated protocol AssetRef: Sendable {
    var id: Int { get }
    var v: String { get }
}

nonisolated struct Asset: Codable, Hashable, Identifiable, Sendable, AssetRef {
    let id: Int
    let library: String
    let path: String
    /// Absolute path on the server (null for a library no longer configured).
    let filePath: String?
    let folder: String
    let name: String
    let kind: AssetKind
    let mime: String
    let size: Int
    let mtimeMs: Double
    let width: Int?
    let height: Int?
    let duration: Double?
    let videoCodec: String?
    let audioCodec: String?
    let playable: String
    let animated: Bool
    let hasMeta: Bool
    let indexState: String
    let indexError: String?
    var favorite: Bool
    var rating: Int
    var hidden: Bool
    let libraryHidden: Bool
    let status: String
    let trashedAtMs: Double?
    let caption: CaptionStatus?
    let captionCandidate: Bool
    let captionRev: Int
    var tags: [String]
    let v: String
    let needsPreview: Bool
    let libraryName: String?
    let writable: Bool?
    let expiresAtMs: Double?

    var date: Date { Date(timeIntervalSince1970: mtimeMs / 1000) }
    var aspect: Double? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return Double(width) / Double(height)
    }

    /// The file's content version: `v` without the suffix that marks a hidden item.
    var contentVersion: Substring { v.hasSuffix("h") ? v.dropLast() : Substring(v) }
}

nonisolated struct Cover: Codable, Hashable, Sendable, AssetRef {
    let id: Int
    let v: String
}

nonisolated struct Tag: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let name: String
    let count: Int
    let cover: Cover?
    let hidden: Bool
}

nonisolated struct Folder: Codable, Hashable, Identifiable, Sendable {
    let path: String
    let name: String
    let count: Int
    let latestMs: Double
    let cover: Cover?
    var id: String { path }
}

nonisolated struct AssetPage: Codable, Sendable {
    let items: [Asset]
    let next: String?
    let total: Int?
}

nonisolated struct ServerStatus: Codable, Sendable {
    let pending: Int
    let scanning: Bool
    let current: String?
    let trash: Int
    let trashRetentionDays: Int
}

nonisolated struct Session: Codable, Sendable {
    let csrf: String
    let hiddenEnabled: Bool
    let unlockMinutes: Int
    let unlockedForMs: Double
}

// MARK: - Metadata

/// `string | number | boolean`, shown as text.
nonisolated enum Scalar: Codable, Hashable, Sendable, CustomStringConvertible {
    case string(String), number(Double), bool(Bool)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else { self = .string(try c.decode(String.self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        }
    }

    var description: String {
        switch self {
        case .string(let s): s
        case .number(let n): n.rounded() == n && abs(n) < 1e15 ? String(Int64(n)) : String(n)
        case .bool(let b): b ? "true" : "false"
        }
    }
}

/// Arbitrary JSON (caption classification, vhotseat events, …).
nonisolated enum JSONValue: Codable, Hashable, Sendable, CustomStringConvertible {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var string: String? { if case .string(let s) = self { s } else { nil } }
    var object: [String: JSONValue]? { if case .object(let o) = self { o } else { nil } }

    var description: String {
        switch self {
        case .null: "null"
        case .bool(let b): b ? "true" : "false"
        case .number(let n): Scalar.number(n).description
        case .string(let s): s
        case .array(let a): a.map(\.description).joined(separator: ", ")
        case .object(let o): o.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: ", ")
        }
    }
}

nonisolated struct MetadataSummary: Codable, Sendable {
    nonisolated struct Sampler: Codable, Sendable, Identifiable {
        let nodeId: String
        let classType: String
        let title: String?
        let seed: Scalar?
        let steps: Scalar?
        let cfg: Scalar?
        let sampler: Scalar?
        let scheduler: Scalar?
        let denoise: Scalar?
        let positive: String?
        let negative: String?
        var id: String { nodeId }
    }

    nonisolated struct Model: Codable, Sendable, Hashable {
        let kind: String
        let name: String
        let nodeId: String?
    }

    nonisolated struct Lora: Codable, Sendable, Hashable {
        let name: String
        let strengthModel: Double?
        let strengthClip: Double?
    }

    let source: String
    let positive: [String]
    let negative: [String]
    let otherText: [String]
    let samplers: [Sampler]
    let models: [Model]
    let loras: [Lora]
    let params: [String: Scalar]
    let nodeTypes: [String]
}

nonisolated struct MetadataResponse: Codable, Sendable {
    let indexState: String
    let indexError: String?
    let summary: MetadataSummary?
    let extra: [String: String]
    let parameters: String?
    let hasPrompt: Bool
    let hasWorkflow: Bool
    let promptBytes: Int
    let workflowBytes: Int
}

// MARK: - Captions

nonisolated enum CaptionAction: String, Sendable {
    case save, approve, needs_regen, accept_candidate, discard_candidate
}

nonisolated enum CaptionFilter: String, CaseIterable, Sendable, Hashable {
    case any, none, generated, edited, approved, needs_regen, candidate

    var label: String {
        switch self {
        case .any: "Has caption"
        case .none: "No caption"
        case .generated: "Generated"
        case .edited: "Edited"
        case .approved: "Approved"
        case .needs_regen: "Needs regen"
        case .candidate: "Has candidate"
        }
    }
}

nonisolated struct CaptionResponse: Codable, Sendable {
    let txt: String?
    /// Parsed `<stem>.caption.json` (unknown keys kept).
    let json: JSONValue?
    let jsonError: String?
    let status: CaptionStatus?
    let updated_at: String?
    let txt_sha256: String?
    let json_sha256: String?
    let writable: Bool

    var description: String? { json?["description"]?.string }
    var candidateCaption: String? { json?["candidate"]?["caption"]?.string }
    var classification: [String: JSONValue]? { json?["classification"]?.object }
    var model: String? { json?["generation"]?["model"]?.string }
}

// MARK: - Generate

nonisolated struct FlowInfo: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let title: String
    /// `tags`: description → tags → images. `video`: image + prompt → video.
    let kind: String
    let ready: Bool
    let problem: String?
    let promptsFile: String
    let defaultTags: String
    let seconds: [Int]?
    let defaultSeconds: Int?
}

nonisolated struct ComfyStatus: Codable, Sendable {
    nonisolated struct Device: Codable, Sendable, Hashable {
        let name: String
        let vramTotal: Double
        let vramFree: Double
    }

    let url: String
    let online: Bool
    let error: String?
    let devices: [Device]
}

nonisolated struct OutputAsset: Codable, Hashable, Sendable, AssetRef {
    let id: Int
    let v: String
    let library: String
    let width: Int?
    let height: Int?
}

nonisolated struct RunOutput: Codable, Hashable, Sendable {
    let filename: String
    let subfolder: String
    let type: String
    /// The gallery asset once the output is indexed.
    let asset: OutputAsset?
}

nonisolated struct Job: Codable, Hashable, Sendable {
    let variation: Int
    let index: Int
    let seed: Int
    let promptId: String?
    /// pending | queued | running | completed | error | cancelled
    let status: String
    let progress: Double
    let error: String?
    let outputs: [RunOutput]
}

nonisolated struct Run: Codable, Hashable, Identifiable, Sendable {
    nonisolated struct Video: Codable, Hashable, Sendable {
        let sourcePath: String
        let sourceAsset: Int?
        let seconds: Int
    }

    let id: String
    let flow: String
    let createdAtMs: Double
    let finishedAtMs: Double?
    let prompt: String
    let variations: [String]
    let batch: Int
    let jobs: [Job]
    /// running | completed | error | cancelled
    let status: String
    let video: Video?
}

// MARK: - Dashboard

nonisolated struct DashJob: Codable, Hashable, Identifiable, Sendable {
    nonisolated struct Output: Codable, Hashable, Sendable {
        let filename: String
        let subfolder: String
        let type: String
        let asset: OutputAsset?
    }

    let id: String
    /// pending | running | completed | failed | cancelled
    let status: String
    let createdAtMs: Double?
    let startedAtMs: Double?
    let endedAtMs: Double?
    let error: String?
    let clientId: String?
    let title: String?
    let model: String?
    let flow: String?
    let progress: Double?
    let output: Output?
}

nonisolated struct GpuSample: Codable, Hashable, Sendable {
    let atMs: Double
    let name: String
    let util: Double
    let memUsedMib: Double
    let memTotalMib: Double
    let tempC: Double?
    let powerW: Double?
    let powerLimitW: Double?
}

nonisolated struct Workload: Codable, Hashable, Sendable {
    nonisolated struct Strata: Codable, Hashable, Sendable {
        let service: Bool
        let reachable: Bool
        let loaded: Bool
    }

    nonisolated struct Comfy: Codable, Hashable, Sendable {
        let service: Bool
        let reachable: Bool
        let running: Int
        let pending: Int
        let holds_models: Bool
    }

    nonisolated struct Gpu: Codable, Hashable, Sendable {
        let total_mib: Double?
        let free_mib: Double?
        let strata_mib: Double
        let comfy_mib: Double
        let other_mib: Double
        let error: String?
    }

    let mode: String
    let strata: Strata
    let comfy: Comfy
    let gpu: Gpu
    let last_event: JSONValue?
}

nonisolated struct Dashboard: Codable, Sendable {
    nonisolated struct ComfyState: Codable, Sendable {
        let url: String
        let online: Bool
        let error: String?
        let running: [DashJob]
        let pending: [DashJob]
        let recent: [DashJob]
    }

    nonisolated struct Gpu: Codable, Sendable {
        let now: GpuSample?
        let history: [GpuSample]
        let error: String?
    }

    nonisolated struct WorkloadState: Codable, Sendable {
        let status: Workload?
        let error: String?
    }

    let atMs: Double
    let comfy: ComfyState
    let gpu: Gpu
    /// nil when vhotseat is not configured.
    let workload: WorkloadState?
}

// MARK: - Live updates

nonisolated struct ChangeEvent: Codable, Sendable {
    let libraries: [String]
    let removed: [Int]
    let captions: [Int]?
}
