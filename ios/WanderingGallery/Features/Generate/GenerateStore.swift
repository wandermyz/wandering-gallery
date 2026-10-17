import SwiftUI

/// The Generate section's state: flows, ComfyUI status and one form per flow. Like the web
/// page it lives in memory only, so drafts and runs survive switching tabs but not a relaunch;
/// tag requests and runs that finish while another flow is shown are not lost.
@Observable
final class GenerateStore {
    let client: APIClient
    var flows: [FlowInfo]?
    var error: String?
    var comfy: ComfyStatus?
    private(set) var tags: [String: TagsFlowState] = [:]
    private(set) var video: [String: VideoFlowState] = [:]

    init(client: APIClient) {
        self.client = client
    }

    func load() async {
        do {
            let fs = try await client.flows()
            for f in fs where tags[f.id] == nil && video[f.id] == nil {
                let runs = RunList(client: client, flow: f.id) { [weak self] in Task { await self?.loadStatus() } }
                if f.kind == "video" { video[f.id] = VideoFlowState(flow: f, client: client, runs: runs) }
                else { tags[f.id] = TagsFlowState(flow: f, client: client, runs: runs) }
                Task { await runs.loadActive() }
            }
            // A flow's setup state may have changed since it was first loaded.
            for f in fs { tags[f.id]?.flow = f; video[f.id]?.flow = f }
            flows = fs
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
        await loadStatus()
    }

    func loadStatus() async {
        if let s = try? await client.comfyStatus() { comfy = s }
    }

    /// "ComfyUI · <GPU>" or "ComfyUI offline".
    var comfySummary: String? {
        guard let comfy else { return nil }
        guard comfy.online else { return "ComfyUI offline" }
        let gpu = comfy.devices.first?.name.replacing(/\ : .*$/, with: "") ?? "online"
        return "ComfyUI · \(gpu)"
    }
}

/// A brief message over the form.
struct Toast: Identifiable, Equatable {
    let id = UUID()
    let text: String
    var isError = false
}

/// Errors from a page: a toast, and a ComfyUI re-check when it answered 503.
@Observable
final class Toaster {
    var toast: Toast?
    @ObservationIgnored var onComfyDown: () -> Void = {}

    func show(_ text: String, error: Bool = false) { toast = Toast(text: text, isError: error) }

    func fail(_ text: String, _ e: Error) {
        if (e as? APIError)?.status == 503 { onComfyDown() }
        show(text, error: true)
    }
}

/// Finished images may take a few seconds to be indexed; keep polling for them this long.
private let indexWait: TimeInterval = 60

/// A page's runs, kept current while any is being worked on. The server only knows the
/// runs still running (e.g. started before a relaunch); finished ones stay until cleared.
@Observable
final class RunList {
    let client: APIClient
    let flow: String
    var runs: [Run] = []
    let toaster = Toaster()
    @ObservationIgnored private var poller: Task<Void, Never>?

    init(client: APIClient, flow: String, onComfyDown: @escaping () -> Void) {
        self.client = client
        self.flow = flow
        toaster.onComfyDown = onComfyDown
    }

    func loadActive() async {
        guard let rs = try? await client.runs() else { return }
        let fresh = rs.filter { r in r.flow == flow && !runs.contains { $0.id == r.id } }
        runs = fresh + runs
        poll()
    }

    func add(_ run: Run) {
        runs.insert(run, at: 0)
        poll()
    }

    func cancel(_ run: Run) async {
        do { replace(try await client.cancelRun(run.id)) } catch { toaster.fail(error.localizedDescription, error) }
    }

    /// Drops the finished runs.
    func clear() { runs.removeAll { $0.status != "running" } }

    var canClear: Bool { runs.contains { $0.status != "running" } }

    private func replace(_ run: Run) {
        if let i = runs.firstIndex(where: { $0.id == run.id }) { runs[i] = run }
    }

    private static func unindexed(_ r: Run) -> Bool {
        r.jobs.contains { j in j.status == "completed" && j.outputs.contains { $0.asset == nil } }
    }

    private static func needsPoll(_ r: Run) -> Bool { r.status == "running" || unindexed(r) }

    private var active: Bool {
        let now = Date.now.timeIntervalSince1970 * 1000
        return runs.contains { r in r.status == "running" || (Self.unindexed(r) && now - (r.finishedAtMs ?? 0) < indexWait * 1000) }
    }

    /// Polls every 1.5 s (as the web page does) until nothing is left to wait for.
    private func poll() {
        guard poller == nil, active else { return }
        poller = Task {
            while active {
                try? await Task.sleep(for: .seconds(1.5))
                for r in runs where Self.needsPoll(r) {
                    if let fresh = try? await client.run(r.id) { replace(fresh) }
                }
            }
            poller = nil
        }
    }
}

/// Description → tag variations → images.
@Observable
final class TagsFlowState {
    static let maxVariations = 12
    static let maxBatch = 16

    var flow: FlowInfo
    let client: APIClient
    let runs: RunList
    var prompt = ""
    var variations: [String]
    var batch = 3
    /// Indexes of variations whose tags are being generated.
    var generating: Set<Int> = []
    var starting = false
    @ObservationIgnored private var tagQueue: Task<Void, Never>?

    init(flow: FlowInfo, client: APIClient, runs: RunList) {
        self.flow = flow
        self.client = client
        self.runs = runs
        variations = [flow.defaultTags]
    }

    private static func norm(_ tags: String) -> String {
        tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// Nothing beyond the prefilled quality and LoRA tags.
    func blank(_ v: String) -> Bool {
        v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || Self.norm(v) == Self.norm(flow.defaultTags)
    }

    var empty: [Int] { variations.indices.filter { blank(variations[$0]) && !generating.contains($0) } }
    var canTag: Bool { !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && flow.ready }
    var busyTags: Bool { !generating.isEmpty }
    var total: Int { variations.count * batch }
    /// Tags may be typed by hand, so the description is optional.
    var canRun: Bool {
        flow.ready && !busyTags && !starting && variations.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    var tagLabel: String {
        let e = empty.count
        return e == 0 ? "Regenerate all" : e == variations.count ? "Generate tags" : "Generate \(e) more"
    }

    /// Variation 1 is the description as-is; the others ask for a distinct character.
    func generateTags(_ index: Int) {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        generating.insert(index)
        let previous = tagQueue
        // One request at a time, as ComfyUI would run them anyway.
        tagQueue = Task {
            await previous?.value
            do {
                let tags = try await client.generateTags(flow: flow.id, prompt: text, vary: index > 0)
                if variations.indices.contains(index) { variations[index] = tags }
            } catch {
                runs.toaster.fail("Variation \(index + 1): \(error.localizedDescription)", error)
            }
            generating.remove(index)
        }
    }

    /// Fills the blank variations; false when all have tags (the caller confirms "regenerate all").
    func fillEmpty() -> Bool {
        let e = empty
        guard !e.isEmpty else { return false }
        e.forEach(generateTags)
        return true
    }

    func regenerateAll() { variations.indices.forEach(generateTags) }

    func setCount(_ n: Int) {
        let n = min(Self.maxVariations, max(1, n))
        if n > variations.count { variations += Array(repeating: flow.defaultTags, count: n - variations.count) }
        else { variations = Array(variations.prefix(n)) }
    }

    func remove(_ index: Int) {
        guard variations.indices.contains(index) else { return }
        if variations.count > 1 { variations.remove(at: index) } else { variations = [flow.defaultTags] }
    }

    func start() async {
        starting = true
        defer { starting = false }
        do {
            let run = try await client.startRun(flow: flow.id, prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                                                variations: variations.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }, batch: batch)
            runs.add(run)
            runs.toaster.show("Queued \(run.jobs.count) image\(run.jobs.count == 1 ? "" : "s")")
        } catch {
            runs.toaster.fail(error.localizedDescription, error)
        }
    }

    func reuse(_ run: Run) {
        prompt = run.prompt
        variations = run.variations
        batch = run.batch
    }
}

/// Image + prompt → video.
@Observable
final class VideoFlowState {
    static let maxBatch = 4

    var flow: FlowInfo
    let client: APIClient
    let runs: RunList
    /// The input image's absolute path on the server (as the viewer's "Copy path" gives it).
    var path = ""
    var image: Asset?
    /// The path `image` was looked up by (the field may have been edited since).
    @ObservationIgnored private var imagePath = ""
    var pathError: String?
    var loading = false
    var prompt = ""
    var seconds: Int
    var batch = 1
    var starting = false
    @ObservationIgnored private var pickSeq = 0

    init(flow: FlowInfo, client: APIClient, runs: RunList) {
        self.flow = flow
        self.client = client
        self.runs = runs
        seconds = flow.defaultSeconds ?? flow.seconds?.first ?? 5
    }

    var lengths: [Int] { flow.seconds ?? [5] }
    var canRun: Bool {
        flow.ready && image != nil && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !starting && !loading
    }

    /// Looks the path up in the gallery and shows the image.
    func pick(_ raw: String) async {
        var p = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if p.count >= 2, let q = p.first, q == "'" || q == "\"", p.last == q { p = String(p.dropFirst().dropLast()) }
        pickSeq += 1
        let seq = pickSeq
        path = p
        pathError = nil
        guard !p.isEmpty else {
            image = nil
            loading = false
            return
        }
        loading = true
        do {
            let a = try await client.videoImage(path: p)
            if seq == pickSeq { image = a; imagePath = p }
        } catch {
            guard seq == pickSeq else { return }
            image = nil
            pathError = error.localizedDescription
        }
        if seq == pickSeq { loading = false }
    }

    /// An image chosen in the app (the picker, or the viewer's "Use in video flow").
    func use(_ asset: Asset) {
        pickSeq += 1
        loading = false
        guard let p = asset.filePath else {
            image = nil
            path = ""
            pathError = "This image's library is no longer configured."
            return
        }
        path = p
        imagePath = p
        image = asset
        pathError = nil
    }

    func start() async {
        guard image != nil else { return }
        starting = true
        defer { starting = false }
        do {
            let run = try await client.startVideo(flow: flow.id, image: imagePath, prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                                                  seconds: seconds, batch: batch)
            runs.add(run)
            runs.toaster.show("Queued \(run.jobs.count) video\(run.jobs.count == 1 ? "" : "s")")
        } catch {
            runs.toaster.fail(error.localizedDescription, error)
        }
    }

    func reuse(_ run: Run) {
        prompt = run.prompt
        batch = min(Self.maxBatch, max(1, run.jobs.count))
        if let v = run.video {
            seconds = v.seconds
            Task { await pick(v.sourcePath) }
        }
    }
}
