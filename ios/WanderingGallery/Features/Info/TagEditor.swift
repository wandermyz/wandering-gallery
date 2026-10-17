import SwiftUI

/// The item's tags: tap a name to browse it, × to remove; type to pick an existing tag
/// or create a new one (case-insensitive, like the web).
struct TagEditor: View {
    @Environment(AppModel.self) private var model
    let asset: Asset
    let onChange: (Asset) -> Void
    let onOpenTag: (String) -> Void

    @State private var text = ""
    @State private var all: [Tag] = []
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !asset.tags.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(asset.tags, id: \.self) { t in
                        HStack(spacing: 4) {
                            Button(t) { onOpenTag(t) }
                                .accessibilityHint("Show everything with this tag")
                            Button { Task { await change(remove: [t]) } } label: {
                                Image(systemName: "xmark").font(.caption2.weight(.bold))
                            }
                            .accessibilityLabel("Remove tag \(t)")
                        }
                        .buttonStyle(.borderless)
                        .font(.callout)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Theme.accent.opacity(0.2), in: Capsule())
                    }
                }
            }
            TextField("Add a tag", text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focused)
                .onSubmit { add(text) }
                .accessibilityIdentifier("tag-input")
            if focused || !text.isEmpty {
                ForEach(suggestions, id: \.self) { s in
                    Button { add(s) } label: { Label(s, systemImage: "tag") }
                }
                if let create = createName {
                    Button { add(create) } label: { Label("Create “\(create)”", systemImage: "plus") }
                        .accessibilityIdentifier("tag-create")
                }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .task(id: model.visibilityEpoch) { all = (try? await model.client.tags()) ?? [] }
    }

    private var needle: String { text.trimmingCharacters(in: .whitespaces).lowercased() }

    private var suggestions: [String] {
        let have = Set(asset.tags.map { $0.lowercased() })
        return all.map(\.name)
            .filter { !have.contains($0.lowercased()) && (needle.isEmpty || $0.lowercased().contains(needle)) }
            .prefix(needle.isEmpty ? 6 : 8)
            .map { $0 }
    }

    private var createName: String? {
        let n = text.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, !all.contains(where: { $0.name.lowercased() == n.lowercased() }),
              !asset.tags.contains(where: { $0.lowercased() == n.lowercased() }) else { return nil }
        return n
    }

    private func add(_ name: String) {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        // An existing tag keeps the spelling it was created with.
        let existing = all.first { $0.name.lowercased() == n.lowercased() }?.name ?? n
        text = ""
        Task { await change(add: [existing]) }
    }

    private func change(add: [String] = [], remove: [String] = []) async {
        do {
            onChange(try await model.client.setTags(asset.id, add: add, remove: remove))
            error = nil
            if !add.isEmpty { all = (try? await model.client.tags()) ?? all }
        } catch { self.error = error.localizedDescription }
    }
}

/// Lays out children left to right, wrapping onto new lines.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for i in row.indices {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
        var y: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows = [Row()]
        for (i, v) in subviews.enumerated() {
            let size = v.sizeThatFits(.unspecified)
            if !rows[rows.count - 1].indices.isEmpty, rows[rows.count - 1].width + spacing + size.width > width {
                let last = rows[rows.count - 1]
                rows.append(Row(y: last.y + last.height + spacing))
            }
            var r = rows[rows.count - 1]
            r.width += (r.indices.isEmpty ? 0 : spacing) + size.width
            r.height = max(r.height, size.height)
            r.indices.append(i)
            rows[rows.count - 1] = r
        }
        return rows
    }
}
