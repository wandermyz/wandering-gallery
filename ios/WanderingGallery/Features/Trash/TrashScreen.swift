import SwiftUI

/// Deleted items, kept for the retention period: restore (back where it was, with its
/// favorite and rating), delete permanently, or delete all.
struct TrashScreen: View {
    @Environment(AppModel.self) private var model
    @State private var data: APIClient.TrashResponse?
    @State private var error: String?
    @State private var busy: Int?
    @State private var purgingAll = false
    @State private var purging: Asset?
    @State private var confirmAll = false
    @State private var toast: String?

    var body: some View {
        Group {
            if let data {
                List {
                    Section {
                        Text("Items are kept for \(data.retentionDays) day\(data.retentionDays == 1 ? "" : "s"), then deleted permanently. Restoring puts the file back where it was, with its favorite and rating.")
                            .font(.footnote).foregroundStyle(.secondary)
                        if let toast { Text(toast).font(.footnote).foregroundStyle(Theme.accent) }
                    }
                    if data.items.isEmpty {
                        ContentUnavailableView("Trash is empty", systemImage: "trash")
                    }
                    ForEach(data.items) { a in
                        row(a)
                            .swipeActions(edge: .leading) {
                                Button("Restore") { Task { await restore(a) } }.tint(.green)
                            }
                            .swipeActions {
                                Button("Delete", role: .destructive) { purging = a }
                            }
                    }
                }
            } else if let error {
                ErrorBanner(message: error) { Task { await load() } }.padding()
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Trash")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let data, !data.items.isEmpty {
                Button("Delete All", role: .destructive) { confirmAll = true }
                    .tint(.red)
                    .disabled(purgingAll || busy != nil)
            }
        }
        .refreshable { await load() }
        .task(id: model.visibilityEpoch) { await load() }
        .confirmationDialog("Delete permanently?", isPresented: Binding(get: { purging != nil }, set: { if !$0 { purging = nil } }), titleVisibility: .visible) {
            Button("Delete forever", role: .destructive) { if let a = purging { Task { await purge(a) } } }
        } message: {
            Text("\(purging?.name ?? "")\nThis cannot be undone.")
        }
        .confirmationDialog(deleteAllTitle, isPresented: $confirmAll, titleVisibility: .visible) {
            Button("Delete all forever", role: .destructive) { Task { await purgeAll() } }
        } message: {
            Text("Everything in the trash is deleted. This cannot be undone.")
        }
    }

    private var deleteAllTitle: String {
        let n = data?.items.count ?? 0
        return "Delete \(n == 1 ? "1 item" : "all \(n) items") permanently?"
    }

    private func row(_ a: Asset) -> some View {
        let days = max(0, Int(ceil(((a.expiresAtMs ?? 0) - Date.now.timeIntervalSince1970 * 1000) / 86_400_000)))
        return HStack(spacing: 12) {
            RemoteImage(url: model.client.thumbURL(a))
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 3) {
                Text(a.name).font(.subheadline.weight(.medium)).lineLimit(2)
                Text("\(a.libraryName ?? a.library) · \(a.folder.isEmpty ? "root" : a.folder) · \(Format.bytes(a.size))")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Text("Deleted \(a.trashedAtMs.map(Format.date) ?? "") · \(days > 0 ? "\(days) day\(days == 1 ? "" : "s") left" : "expires soon")" +
                     (a.favorite ? " · ♥" : "") + (a.rating > 0 ? " · \(a.rating)★" : ""))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if busy == a.id {
                ProgressView()
            } else {
                Menu {
                    Button("Restore", systemImage: "arrow.uturn.backward") { Task { await restore(a) } }
                    Button("Delete permanently", systemImage: "trash", role: .destructive) { purging = a }
                } label: {
                    Image(systemName: "ellipsis.circle").font(.title3)
                }
                .disabled(purgingAll)
                .accessibilityLabel("Actions for \(a.name)")
            }
        }
        .accessibilityIdentifier("trash-\(a.name)")
    }

    private func load() async {
        do {
            data = try await model.client.trashList()
            error = nil
        } catch is CancellationError {
        } catch { self.error = error.localizedDescription }
    }

    private func after(_ message: String) async {
        toast = message
        await load()
        await model.loadStatus()
        await model.loadLibraries()
    }

    private func restore(_ a: Asset) async {
        busy = a.id
        defer { busy = nil }
        do {
            let r = try await model.client.restore(a.id)
            await after(r.path != a.path ? "Restored as \(r.name)" : "Restored \(a.name)")
        } catch { await after(error.localizedDescription) }
    }

    private func purge(_ a: Asset) async {
        busy = a.id
        defer { busy = nil }
        do {
            try await model.client.purge(a.id)
            await after("Deleted \(a.name) permanently")
        } catch { await after(error.localizedDescription) }
    }

    private func purgeAll() async {
        purgingAll = true
        defer { purgingAll = false }
        do {
            let r = try await model.client.purgeAll()
            await after(r.failed > 0 ? "Deleted \(r.deleted), \(r.failed) failed: \(r.error ?? "")" : "Deleted \(r.deleted) item\(r.deleted == 1 ? "" : "s") permanently")
        } catch { await after(error.localizedDescription) }
    }
}
