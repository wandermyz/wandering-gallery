import SwiftUI

/// Details for the viewer's asset (the web's info panel): tags, training caption,
/// generation metadata, raw metadata and file details.
struct InfoPanel: View {
    @Environment(AppModel.self) private var model
    let asset: Asset
    let onChange: (Asset) -> Void
    let onOpenTag: (String) -> Void

    @State private var meta: MetadataResponse?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if asset.status == "ready" {
                    Section {
                        TagEditor(asset: asset, onChange: onChange, onOpenTag: onOpenTag)
                    } header: {
                        Text("Tags")
                    }
                }
                if asset.status == "ready" && (asset.kind == .image || asset.kind == .video) {
                    CaptionSection(asset: asset)
                }
                metadata
                fileSection
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Details")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: RawMetadata.self) { RawMetadataView(raw: $0) }
        }
        .task(id: "\(asset.id)-\(asset.v)") { await load() }
    }

    private func load() async {
        meta = nil
        error = nil
        for _ in 0..<20 {
            do {
                let m = try await model.client.metadata(asset.id)
                meta = m
                // Still being read: look again shortly.
                if m.indexState != "pending" { return }
                try await Task.sleep(for: .seconds(1.5))
            } catch is CancellationError {
                return
            } catch {
                self.error = error.localizedDescription
                return
            }
        }
    }

    @ViewBuilder private var metadata: some View {
        if let error {
            Section { Text("Could not load metadata: \(error)").foregroundStyle(.red) }
        } else if let meta {
            if meta.indexState == "pending" {
                Section { Label("Reading metadata…", systemImage: "hourglass").foregroundStyle(.secondary) }
            } else if meta.indexState == "error" {
                Section { Text("Metadata could not be read: \(meta.indexError ?? "")").foregroundStyle(.red) }
            }
            if meta.indexState != "pending" {
                if let s = meta.summary {
                    GenerationSection(summary: s)
                    if !s.nodeTypes.isEmpty {
                        Section("Nodes (\(s.nodeTypes.count))") {
                            DisclosureGroup("Node types") {
                                Text(s.nodeTypes.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else if !meta.hasPrompt && !meta.hasWorkflow && meta.parameters == nil && asset.kind != .markdown {
                    Section { Label("No generation metadata found in this file.", systemImage: "info.circle").foregroundStyle(.secondary) }
                }
                if meta.hasPrompt || meta.hasWorkflow || meta.parameters != nil {
                    Section {
                        if meta.summary == nil {
                            Text("The workflow could not be interpreted automatically; the original data is below.").font(.footnote).foregroundStyle(.secondary)
                        }
                        if meta.hasPrompt {
                            NavigationLink(value: RawMetadata(id: asset.id, which: "prompt")) {
                                LabeledContent("prompt (API graph)", value: Format.bytes(meta.promptBytes))
                            }
                        }
                        if meta.hasWorkflow {
                            NavigationLink(value: RawMetadata(id: asset.id, which: "workflow")) {
                                LabeledContent("workflow", value: Format.bytes(meta.workflowBytes))
                            }
                        }
                        if let p = meta.parameters { PromptBlock(label: "parameters", text: p) }
                    } header: {
                        Text("Raw metadata")
                    }
                }
                if !meta.extra.isEmpty {
                    Section("Other embedded text") {
                        ForEach(meta.extra.sorted { $0.key < $1.key }, id: \.key) { k, v in
                            PromptBlock(label: k, text: v, lineLimit: 6)
                        }
                    }
                }
            }
        } else {
            Section { ProgressView().frame(maxWidth: .infinity) }
        }
    }

    private var fileSection: some View {
        Section("File") {
            LabeledContent("Name") { Text(asset.name).textSelection(.enabled) }
            LabeledContent("Folder", value: asset.folder.isEmpty ? "(library root)" : asset.folder)
            LabeledContent("Library", value: asset.libraryName ?? model.library(asset.library)?.name ?? asset.library)
            LabeledContent("Modified", value: Format.date(ms: asset.mtimeMs))
            LabeledContent("Size", value: Format.bytes(asset.size))
            if let w = asset.width, let h = asset.height { LabeledContent("Dimensions", value: "\(w) × \(h)") }
            if let d = asset.duration, d > 0 { LabeledContent("Duration", value: Format.duration(d)) }
            if let codec = asset.videoCodec.map({ v in asset.audioCodec.map { "\(v) + \($0)" } ?? v }) ?? asset.audioCodec {
                LabeledContent("Codec", value: codec)
            }
            LabeledContent("Type", value: asset.mime + (asset.animated ? " (animated)" : ""))
            Button("Copy path", systemImage: "doc.on.doc") { copyToPasteboard(asset.filePath ?? asset.path) }
            Link(destination: model.client.fileURL(asset)) { Label("Open original", systemImage: "safari") }
        }
    }
}

struct RawMetadata: Hashable {
    let id: Int
    let which: String
}

/// The raw `prompt` / `workflow` JSON, pretty-printed.
struct RawMetadataView: View {
    @Environment(AppModel.self) private var model
    let raw: RawMetadata
    @State private var text: String?
    @State private var error: String?

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            if let text {
                Text(text).font(.system(.caption, design: .monospaced)).textSelection(.enabled).padding()
            } else if let error {
                Text(error).foregroundStyle(.red).padding()
            } else {
                ProgressView().padding()
            }
        }
        .navigationTitle(raw.which)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let text { Button("Copy", systemImage: "doc.on.doc") { copyToPasteboard(text) } }
        }
        .task {
            do {
                let s = try await model.client.rawMetadata(raw.id, which: raw.which)
                text = Self.pretty(s)
            } catch { self.error = error.localizedDescription }
        }
    }

    nonisolated static func pretty(_ s: String) -> String {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(s.utf8)),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return s }
        return String(decoding: data, as: UTF8.self)
    }
}

/// A labeled block of prompt text with a copy button.
struct PromptBlock: View {
    let label: String
    let text: String
    var lineLimit: Int? = nil
    var tint: Color = .secondary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label).font(.caption.weight(.semibold)).foregroundStyle(tint).textCase(.uppercase)
                Spacer()
                Button { copyToPasteboard(text) } label: { Image(systemName: "doc.on.doc").font(.caption) }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Copy \(label)")
            }
            Text(text).font(.callout).textSelection(.enabled).lineLimit(lineLimit)
        }
    }
}

private struct GenerationSection: View {
    let summary: MetadataSummary

    var body: some View {
        Section(summary.source == "a1111" ? "Generation (A1111)" : "Generation") {
            ForEach(Array(summary.positive.enumerated()), id: \.offset) { i, p in
                PromptBlock(label: summary.positive.count > 1 ? "Positive \(i + 1)" : "Positive", text: p, tint: .green)
            }
            ForEach(Array(summary.negative.enumerated()), id: \.offset) { i, p in
                PromptBlock(label: summary.negative.count > 1 ? "Negative \(i + 1)" : "Negative", text: p, tint: .red)
            }
            ForEach(Array(summary.otherText.enumerated()), id: \.offset) { _, p in
                PromptBlock(label: "Text", text: p, lineLimit: 6)
            }
            ForEach(summary.samplers) { s in
                VStack(alignment: .leading, spacing: 6) {
                    Text(s.title ?? s.classType).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                        ForEach(samplerRows(s), id: \.0) { k, v in
                            GridRow {
                                Text(k).foregroundStyle(.secondary)
                                Text(v).textSelection(.enabled)
                            }
                        }
                    }
                    .font(.callout)
                }
            }
            if summary.samplers.isEmpty && !summary.params.isEmpty {
                ForEach(summary.params.sorted { $0.key < $1.key }, id: \.key) { k, v in
                    LabeledContent(k, value: v.description)
                }
            } else {
                ForEach(["width", "height", "batch_size"].filter { summary.params[$0] != nil }, id: \.self) { k in
                    LabeledContent(k, value: summary.params[k]!.description)
                }
            }
            ForEach(summary.models, id: \.self) { m in
                LabeledContent(m.kind.capitalized) { Text(m.name).textSelection(.enabled) }
            }
            ForEach(summary.loras, id: \.self) { l in
                LabeledContent("LoRA") {
                    VStack(alignment: .trailing) {
                        Text(l.name).textSelection(.enabled)
                        if let sm = l.strengthModel {
                            Text("model \(sm.formatted())" + (l.strengthClip.map { " · clip \($0.formatted())" } ?? "")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private func samplerRows(_ s: MetadataSummary.Sampler) -> [(String, String)] {
        [("Seed", s.seed), ("Steps", s.steps), ("CFG", s.cfg), ("Sampler", s.sampler), ("Scheduler", s.scheduler), ("Denoise", s.denoise)]
            .compactMap { k, v in v.map { (k, $0.description) } }
    }
}
