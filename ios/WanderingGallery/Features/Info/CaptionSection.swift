import SwiftUI

/// The training caption sidecars (`<stem>.txt` + `<stem>.caption.json`): edit, approve,
/// ask for regeneration, accept or discard a candidate. Edits carry what they were based
/// on, and the server answers 409 if the files changed meanwhile.
struct CaptionSection: View {
    @Environment(AppModel.self) private var model
    let asset: Asset

    @State private var cap: CaptionResponse?
    @State private var draft = ""
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var stale = false

    private var dirty: Bool { cap != nil && draft != (cap?.txt ?? "") }

    var body: some View {
        Group {
            if let cap, cap.txt != nil || cap.json != nil || cap.jsonError != nil {
                section(cap)
            } else if let error, cap == nil {
                Section { Text("Could not load caption: \(error)").foregroundStyle(.red) }
            }
        }
        .task(id: asset.id) { await load() }
        .onChange(of: model.changeCount) {
            // Changed on disk (pipeline, another device): reload unless that would drop an edit.
            guard model.lastChange?.captions?.contains(asset.id) == true, !busy else { return }
            if dirty { stale = true } else { Task { await load() } }
        }
    }

    @ViewBuilder private func section(_ cap: CaptionResponse) -> some View {
        let ro = !cap.writable
        let status = cap.status ?? (cap.txt == nil ? nil : .edited)
        Section {
            if ro { Label("This library is read-only, so the caption cannot be edited.", systemImage: "lock").font(.footnote).foregroundStyle(.secondary) }
            if let e = cap.jsonError { Text("The caption json cannot be read: \(e)").font(.footnote).foregroundStyle(.red) }
            if let notice { Text(notice).font(.footnote).foregroundStyle(.orange) }
            if stale {
                VStack(alignment: .leading) {
                    Text("The caption changed on disk.").font(.footnote).foregroundStyle(.orange)
                    Button("Discard my edit and reload") { Task { await load() } }.font(.footnote)
                }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            TextField(cap.txt == nil ? "No caption yet" : "", text: $draft, axis: .vertical)
                .lineLimit(3...10)
                .disabled(ro || busy)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("caption-text")
            if !ro {
                HStack {
                    Button("Save") { Task { await act(.save, caption: draft) } }
                        .disabled(busy || !dirty || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                    if dirty {
                        Button("Save & approve") { Task { await act(.save, caption: draft, approve: true) } }
                            .buttonStyle(.borderedProminent).foregroundStyle(Theme.onAccent)
                            .disabled(busy || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                    } else {
                        Button("Approve") { Task { await act(.approve) } }
                            .buttonStyle(.borderedProminent).foregroundStyle(Theme.onAccent)
                            .disabled(busy || cap.txt == nil || status == .approved)
                            .accessibilityIdentifier("caption-approve")
                    }
                    Button("Regenerate") { Task { await act(.needs_regen) } }
                        .disabled(busy || dirty || status == .needs_regen)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            if let candidate = cap.candidateCaption {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Candidate" + (cap.json?["candidate"]?["generation"]?["model"]?.string.map { " · \($0)" } ?? ""))
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    TagDiff(from: cap.txt ?? "", to: candidate)
                    if let d = cap.json?["candidate"]?["description"]?.string { Text(d).font(.footnote).foregroundStyle(.secondary) }
                    if !ro {
                        HStack {
                            Button("Accept") { Task { await act(.accept_candidate) } }
                                .buttonStyle(.borderedProminent).foregroundStyle(Theme.onAccent).disabled(busy || dirty)
                            Button("Discard") { Task { await act(.discard_candidate) } }
                                .buttonStyle(.bordered).disabled(busy)
                        }
                        .controlSize(.small)
                    }
                }
            }
            if let d = cap.description { LabeledContent("Description") { Text(d).font(.callout) } }
            if let c = cap.classification, !c.isEmpty {
                ForEach(c.sorted { $0.key < $1.key }, id: \.key) { k, v in
                    LabeledContent(k.replacingOccurrences(of: "_", with: " "), value: v.description)
                }
            }
            if let m = cap.model { LabeledContent("Model", value: m) }
        } header: {
            HStack {
                Text("Caption")
                Spacer()
                if let status {
                    Text(status.label).font(.caption2.weight(.semibold)).textCase(nil)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background(Theme.caption(status).opacity(0.25), in: Capsule())
                        .foregroundStyle(Theme.caption(status))
                }
            }
        }
    }

    private func load() async {
        do {
            let c = try await model.client.caption(asset.id)
            cap = c
            draft = c.txt ?? ""
            stale = false
            error = nil
        } catch is CancellationError {
        } catch let e as APIError where e.status == 404 {
            cap = nil
        } catch { self.error = error.localizedDescription }
    }

    private func act(_ action: CaptionAction, caption: String? = nil, approve: Bool? = nil) async {
        guard let cap, !busy else { return }
        busy = true
        error = nil
        notice = nil
        defer { busy = false }
        do {
            let c = try await model.client.captionAction(asset.id, action, loaded: cap, caption: caption, approve: approve)
            // Only a save consumes the edit; other actions keep an unsaved draft.
            let keepDraft = action != .save && dirty
            self.cap = c
            if !keepDraft { draft = c.txt ?? "" }
            stale = false
        } catch let e as APIError where e.status == 409 {
            notice = e.message
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

/// A candidate caption's tags against the current ones: added tags highlighted, removed struck.
struct TagDiff: View {
    let from: String
    let to: String

    var body: some View {
        let old = Self.tags(from), new = Self.tags(to)
        let oldSet = Set(old), newSet = Set(new)
        FlowLayout(spacing: 4) {
            ForEach(Array(new.enumerated()), id: \.offset) { _, t in
                Text(t).font(.caption)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background((oldSet.contains(t) ? Color.white.opacity(0.08) : Color.green.opacity(0.25)), in: Capsule())
            }
            ForEach(old.filter { !newSet.contains($0) }, id: \.self) { t in
                Text(t).font(.caption).strikethrough()
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.red.opacity(0.2), in: Capsule())
            }
        }
    }

    nonisolated static func tags(_ s: String) -> [String] {
        s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}
