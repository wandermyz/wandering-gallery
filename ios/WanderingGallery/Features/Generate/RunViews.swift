import AVKit
import SwiftUI

/// A finished output to show full screen.
struct OutputItem: Identifiable {
    let asset: OutputAsset
    let isVideo: Bool
    var id: Int { asset.id }
}

/// "Runs" with a Clear button, then one section per run (newest first).
struct RunsSections: View {
    let runs: RunList
    let onReuse: (Run) -> Void
    let onOpen: (OutputItem) -> Void

    var body: some View {
        if !runs.runs.isEmpty {
            Section {
                HStack {
                    Text("Runs").font(.title3.bold())
                    Spacer()
                    Button("Clear", systemImage: "trash") { runs.clear() }
                        .buttonStyle(.bordered).controlSize(.small)
                        .disabled(!runs.canClear)
                        .accessibilityIdentifier("run-clear")
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 16, leading: 4, bottom: 0, trailing: 4))
            }
        }
        ForEach(runs.runs) { run in
            RunSection(run: run, onCancel: { Task { await runs.cancel(run) } }, onReuse: { onReuse(run) }, onOpen: onOpen)
                .id(run.id)
        }
    }
}

private let runStatus = ["running": "Running", "completed": "Done", "error": "Finished with errors", "cancelled": "Cancelled"]

private func statusColor(_ s: String) -> Color {
    switch s {
    case "running": Theme.accent
    case "completed": .green
    case "error": .red
    default: .gray
    }
}

struct RunSection: View {
    let run: Run
    let onCancel: () -> Void
    let onReuse: () -> Void
    let onOpen: (OutputItem) -> Void

    private var done: Int { run.jobs.filter { $0.status == "completed" }.count }

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                head
                if let v = run.video {
                    Text("**From** \(URL(fileURLWithPath: v.sourcePath).lastPathComponent)")
                        .font(.footnote).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    Text(run.prompt).font(.callout).lineLimit(4)
                    thumbs(run.jobs)
                } else {
                    if !run.prompt.isEmpty { Text(run.prompt).font(.callout).lineLimit(4) }
                    ForEach(Array(run.variations.enumerated()), id: \.offset) { v, tags in
                        VStack(alignment: .leading, spacing: 6) {
                            (Text("V\(v + 1) ").foregroundStyle(.secondary) + Text(tags))
                                .font(.footnote).lineLimit(2)
                            thumbs(run.jobs.filter { $0.variation == v })
                        }
                    }
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("run-\(run.id)")
        }
    }

    private var head: some View {
        HStack(spacing: 8) {
            Text(runStatus[run.status] ?? run.status)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(statusColor(run.status).opacity(0.2), in: Capsule())
                .foregroundStyle(statusColor(run.status))
                .accessibilityIdentifier("run-status")
            Text("\(Date(timeIntervalSince1970: run.createdAtMs / 1000).formatted(.dateTime.month(.abbreviated).day().hour().minute())) · \(run.video.map { "\($0.seconds) s · " } ?? "")\(done)/\(run.jobs.count)")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 0)
            if run.status == "running" {
                Button("Cancel", action: onCancel)
                    .buttonStyle(.bordered).controlSize(.small)
                    .accessibilityIdentifier("run-cancel")
            }
            Button("Reuse", action: onReuse)
                .buttonStyle(.bordered).controlSize(.small)
                .accessibilityIdentifier("run-reuse")
        }
    }

    private func thumbs(_ jobs: [Job]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: run.video == nil ? 84 : 140), spacing: 6)], alignment: .leading, spacing: 6) {
            ForEach(jobs, id: \.index) { j in
                JobCell(job: j, isVideo: run.video != nil, onOpen: onOpen)
            }
        }
    }
}

/// A job's output thumbnail, or its state while there is none.
struct JobCell: View {
    @Environment(AppModel.self) private var model
    let job: Job
    let isVideo: Bool
    let onOpen: (OutputItem) -> Void

    var body: some View {
        let out = job.outputs.first
        if let a = out?.asset {
            Button { onOpen(OutputItem(asset: a, isVideo: isVideo)) } label: {
                Color.clear
                    .aspectRatio(aspect(a), contentMode: .fit)
                    .overlay { RemoteImage(url: model.client.thumbURL(a)) }
                    .overlay {
                        if isVideo { Image(systemName: "play.circle.fill").font(.title).foregroundStyle(.white.opacity(0.9)).shadow(radius: 4) }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(out?.filename ?? "Output")
            .accessibilityIdentifier("job-thumb")
        } else {
            Color.clear
                .aspectRatio(isVideo ? 16 / 9 : 2 / 3, contentMode: .fit)
                .overlay {
                    VStack(spacing: 6) {
                        if job.status == "error" { Image(systemName: "exclamationmark.triangle").foregroundStyle(.red) }
                        Text(label(out)).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).lineLimit(4)
                        if job.status == "running" {
                            ProgressView(value: job.progress).padding(.horizontal, 10)
                        }
                    }
                    .padding(4)
                }
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            .help(job.error ?? label(out))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("job-\(job.status)")
            .contextMenu {
                if let e = job.error { Button("Copy error", systemImage: "doc.on.doc") { copyToPasteboard(e) } }
            }
        }
    }

    private func aspect(_ a: OutputAsset) -> CGFloat {
        guard let w = a.width, let h = a.height, w > 0, h > 0 else { return 1 }
        return CGFloat(w) / CGFloat(h)
    }

    private func label(_ out: RunOutput?) -> String {
        switch job.status {
        case "completed": out == nil ? "No image" : "Indexing…"
        case "running": "\(Int((job.progress * 100).rounded()))%"
        case "error": job.error.map { "Failed: \($0)" } ?? "Failed"
        case "cancelled": "Cancelled"
        default: "Queued"
        }
    }
}

/// A labelled stepper row, like the web's `Stepper`.
struct CountStepper: View {
    let label: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    var id: String

    var body: some View {
        Stepper(value: $value, in: range) {
            HStack {
                Text(label)
                Spacer()
                Text("\(value)").monospacedDigit().foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier(id)
    }
}

func dismissKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

extension View {
    /// Shows the page's toast at the bottom for a few seconds.
    func toast(_ toaster: Toaster) -> some View {
        overlay(alignment: .bottom) {
            if let t = toaster.toast {
                Text(t.text)
                    .font(.callout)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(t.isError ? AnyShapeStyle(Color.red.opacity(0.85)) : AnyShapeStyle(.regularMaterial), in: Capsule())
                    .padding()
                    .onTapGesture { toaster.toast = nil }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityIdentifier("generate-toast")
                    .task(id: t.id) {
                        try? await Task.sleep(for: .seconds(t.isError ? 7 : 3.5))
                        if toaster.toast?.id == t.id { toaster.toast = nil }
                    }
            }
        }
        .animation(.default, value: toaster.toast)
    }
}
