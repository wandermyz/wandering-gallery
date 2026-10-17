import SwiftUI

/// The Dashboard tab (web: dashboard/DashboardApp.tsx): ComfyUI's queue and the GPU; jobs can
/// be cancelled. Polls every few seconds while the tab is selected and the app is active.
struct DashboardView: View {
    /// How often the page refreshes while it is on screen.
    static let pollInterval: Duration = .seconds(3)

    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var data: Dashboard?
    @State private var error: String?
    @State private var confirming: DashJob?
    /// Jobs with a cancel request in flight.
    @State private var cancelling: Set<String> = []
    @State private var toast: DashToast?
    @State private var preview: DashPreview?

    private var visible: Bool { model.tab == .dashboard && scenePhase == .active }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let error {
                        ErrorBanner(message: error) { Task { await load() } }
                            .accessibilityIdentifier("dash-error")
                    }
                    if let data {
                        content(data)
                    } else if error == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                    }
                }
                .padding(12)
                .frame(maxWidth: sizeClass == .regular ? 1200 : .infinity)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.background)
            .navigationTitle("Dashboard")
            .refreshable { await load() }
            .task(id: visible) {
                guard visible else { return }
                while !Task.isCancelled {
                    await load()
                    try? await Task.sleep(for: Self.pollInterval)
                }
            }
            .alert(confirmTitle, isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), presenting: confirming) { job in
                Button(job.status == "running" ? "Stop job" : "Remove job", role: .destructive) {
                    Task { await cancel(job) }
                }
                .accessibilityIdentifier("job-cancel-confirm")
                Button("Keep", role: .cancel) {}
            } message: { job in
                Text(confirmMessage(job))
            }
            .overlay(alignment: .bottom) {
                if let toast {
                    ToastView(toast: toast)
                        .padding(.bottom, 16)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .task(id: toast.id) {
                            try? await Task.sleep(for: .seconds(3.5))
                            if self.toast?.id == toast.id { withAnimation { self.toast = nil } }
                        }
                }
            }
            .fullScreenCover(item: $preview) { p in
                AssetByIDViewer(id: p.asset.id)
            }
        }
    }

    @ViewBuilder
    private func content(_ data: Dashboard) -> some View {
        let gpu = GpuCard(gpu: data.gpu)
        let workload = data.workload.map { WorkloadCard(workload: $0) }
        if sizeClass == .regular, let workload {
            // The GPU cards side by side above the queue on wide screens.
            HStack(alignment: .top, spacing: 12) {
                gpu.frame(maxWidth: .infinity)
                workload.frame(maxWidth: .infinity)
            }
        } else {
            gpu
            workload
        }
        ComfyCard(
            comfy: data.comfy,
            cancelling: cancelling,
            onCancel: { confirming = $0 },
            onOpen: { job, asset in preview = DashPreview(asset: asset, title: job.output?.filename ?? "Output") }
        )
    }

    private var confirmTitle: String {
        confirming?.status == "running" ? "Stop this job?" : "Remove this job from the queue?"
    }

    private func confirmMessage(_ job: DashJob) -> String {
        var s = "\(DashText.jobName(job))\(job.flow != nil ? " was queued from Generate." : " was not queued from this app.")"
        if job.status == "running" { s += " Whatever it has made so far is discarded." }
        return s
    }

    private func load() async {
        do {
            data = try await model.client.dashboard()
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func cancel(_ job: DashJob) async {
        let running = job.status == "running"
        cancelling.insert(job.id)
        defer { cancelling.remove(job.id) }
        do {
            try await model.client.cancelJob(job.id)
            show(DashToast(text: running ? "Job stopped" : "Job removed from the queue"))
            await load()
        } catch {
            show(DashToast(text: "Cancel failed: \(error.localizedDescription)", isError: true))
        }
    }

    private func show(_ t: DashToast) {
        withAnimation { toast = t }
    }
}

// MARK: - Toast

struct DashToast: Equatable {
    let id = UUID()
    let text: String
    var isError = false
}

private struct ToastView: View {
    let toast: DashToast

    var body: some View {
        HStack(spacing: 8) {
            if toast.isError { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red) }
            Text(toast.text).font(.callout)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .accessibilityIdentifier("dash-toast")
    }
}

// MARK: - Output preview

struct DashPreview: Identifiable {
    let asset: OutputAsset
    let title: String
    var id: Int { asset.id }
}

// MARK: - Shared bits

/// A card like the web's `.gen-card.dash-card`.
struct DashCard<Accessory: View, Content: View>: View {
    let title: String
    @ViewBuilder var accessory: Accessory
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                accessory
            }
            .padding(.bottom, 10)
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
    }
}

enum DashPillStyle {
    case running, ok, error, plain

    var colors: (bg: Color, fg: Color) {
        switch self {
        case .running: (Color(red: 139 / 255, green: 124 / 255, blue: 246 / 255).opacity(0.2), Color(red: 0xc9 / 255, green: 0xc1 / 255, blue: 1))
        case .ok: (Color(red: 91 / 255, green: 214 / 255, blue: 154 / 255).opacity(0.18), Color(red: 0x8e / 255, green: 0xe6 / 255, blue: 0xb9 / 255))
        case .error: (Color(red: 1, green: 107 / 255, blue: 129 / 255).opacity(0.18), Color(red: 1, green: 0x9a / 255, blue: 0xaa / 255))
        case .plain: (Theme.surface2, .secondary)
        }
    }
}

struct DashPill: View {
    let text: String
    var style: DashPillStyle = .plain
    var icon: String?

    var body: some View {
        HStack(spacing: 3) {
            if let icon { Image(systemName: icon).font(.caption2) }
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(style.colors.fg)
        .background(style.colors.bg, in: Capsule())
    }
}

/// A red error line inside a card.
struct DashErrorLine: View {
    let text: String

    var body: some View {
        Label {
            Text(text).font(.subheadline).textSelection(.enabled)
        } icon: {
            Image(systemName: "exclamationmark.triangle")
        }
        .foregroundStyle(Color(red: 1, green: 0.42, blue: 0.5))
    }
}

enum DashText {
    static func jobName(_ job: DashJob) -> String {
        if let t = job.title { return t }
        if let f = job.output?.filename { return f.replacing(#/_?\d*_?\.\w+$/#, with: "") }
        return "Job"
    }

    /// "comfy-render-9b7e2e04" → "comfy-render"; the ComfyUI page's random ids → "ComfyUI".
    static func clientLabel(_ id: String) -> String {
        if id.wholeMatch(of: #/[0-9a-f]{32}/#) != nil { return "ComfyUI" }
        let s = id.replacing(#/-[0-9a-fA-F-]{6,}$/#, with: "")
        return s.isEmpty ? id : s
    }

    static func status(_ s: String) -> String {
        switch s {
        case "pending": "Queued"
        case "running": "Running"
        case "completed": "Done"
        case "failed": "Failed"
        case "cancelled": "Cancelled"
        default: s.capitalized
        }
    }

    /// A short age: 45 s, 12 min, 3 h, 2 d.
    static func ago(_ ms: Double) -> String {
        let s = max(0, Int((ms / 1000).rounded()))
        if s < 60 { return "\(s) s" }
        if s < 3600 { return "\(s / 60) min" }
        if s < 86400 { return "\(s / 3600) h" }
        return "\(s / 86400) d"
    }

    static func gib(_ mib: Double) -> String { String(format: "%.1f", mib / 1024) }
}
