import SwiftUI

/// Every tag with a cover and count; rename (renaming onto an existing tag merges),
/// delete, hide / unhide (needs an unlock to see hidden ones).
struct TagsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openGalleryRoute) private var openRoute
    @Environment(\.showUnlock) private var showUnlock
    @State private var tags: [Tag]?
    @State private var error: String?
    @State private var renaming: Tag?
    @State private var newName = ""
    @State private var deleting: Tag?
    @State private var search = ""

    var body: some View {
        Group {
            if let tags {
                if tags.isEmpty {
                    ContentUnavailableView("No tags yet", systemImage: "tag", description: Text("Add tags to an item from its details (ⓘ) in the viewer."))
                } else {
                    List(filtered(tags)) { t in
                        Button { openRoute(.tag(t.name)) } label: { row(t) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("tag-\(t.name)")
                            .swipeActions {
                                Button("Delete", role: .destructive) { deleting = t }
                                Button("Rename") { newName = t.name; renaming = t }.tint(.blue)
                                if model.hiddenEnabled {
                                    Button(t.hidden ? "Unhide" : "Hide") { Task { await hide(t) } }.tint(.gray)
                                }
                            }
                            .contextMenu {
                                Button("Rename", systemImage: "pencil") { newName = t.name; renaming = t }
                                if model.hiddenEnabled {
                                    Button(t.hidden ? "Unhide" : "Hide", systemImage: t.hidden ? "eye" : "eye.slash") { Task { await hide(t) } }
                                }
                                Button("Delete", systemImage: "trash", role: .destructive) { deleting = t }
                            }
                    }
                    .searchable(text: $search, prompt: "Filter tags")
                }
            } else if let error {
                ErrorBanner(message: error) { Task { await load() } }.padding()
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Tags")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: model.visibilityEpoch) { await load() }
        .onChange(of: model.changeCount) { Task { await load() } }
        .alert("Rename tag", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Rename") { if let t = renaming { Task { await rename(t) } } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Renaming to an existing tag merges the two.")
        }
        .confirmationDialog("Delete tag?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete “\(deleting?.name ?? "")”", role: .destructive) { if let t = deleting { Task { await delete(t) } } }
        } message: {
            Text("The tag is removed from \(deleting?.count ?? 0) item(s). The files are not touched.")
        }
        .errorAlert($error.animation())
        .toolbar {
            if model.hiddenEnabled && !model.unlocked {
                Button(action: showUnlock) { Image(systemName: "lock") }.accessibilityLabel("Show hidden tags")
            }
        }
    }

    private func filtered(_ tags: [Tag]) -> [Tag] {
        let n = search.trimmingCharacters(in: .whitespaces).lowercased()
        return n.isEmpty ? tags : tags.filter { $0.name.lowercased().contains(n) }
    }

    private func row(_ t: Tag) -> some View {
        HStack(spacing: 12) {
            Group {
                if let c = t.cover { RemoteImage(url: model.client.thumbURL(c)) } else {
                    Image(systemName: "tag").frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.surface2)
                }
            }
            .frame(width: 52, height: 52)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(t.name).font(.body.weight(.medium))
                    if t.hidden { Image(systemName: "eye.slash").font(.caption).foregroundStyle(.secondary) }
                }
                Text("\(t.count) item\(t.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        do {
            tags = try await model.client.tags()
        } catch is CancellationError {
        } catch { if tags == nil { self.error = error.localizedDescription } }
    }

    private func rename(_ t: Tag) async {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name != t.name else { return }
        do {
            _ = try await model.client.renameTag(t.id, to: name)
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func delete(_ t: Tag) async {
        do {
            try await model.client.deleteTag(t.id)
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func hide(_ t: Tag) async {
        if t.hidden && !model.unlocked {
            showUnlock()
            return
        }
        do {
            try await model.client.hideTag(t.id, !t.hidden)
            await load()
        } catch { self.error = error.localizedDescription }
    }
}
