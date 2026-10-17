import SwiftUI

/// What a grid lists before filters.
enum GridScope: Hashable {
    case all, favorites
    case library(String, folder: String)
    case tag(String)
}

/// The filter sheet's state (the web's route filters).
struct GridFilters: Equatable {
    var favorite = false
    var minRating = 0
    var kind: AssetKind?
    var caption: CaptionFilter?
    var ascending = false
    /// Libraries: only this folder, not its subfolders.
    var flat = false

    var active: Bool { self != GridFilters() }
}

enum GridDensity: String, CaseIterable {
    case s, m, l

    var minWidth: CGFloat {
        switch self {
        case .s: 72
        case .m: 112
        case .l: 170
        }
    }

    var label: String {
        switch self {
        case .s: "Small"
        case .m: "Medium"
        case .l: "Large"
        }
    }
}

struct AssetGridScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openGalleryRoute) private var openRoute
    @Environment(\.showUnlock) private var showUnlock
    let scope: GridScope

    @State private var filters = GridFilters()
    @State private var list: AssetListModel?
    @State private var folders: [Folder] = []
    @State private var showFilters = false
    @State private var search = ""
    @State private var viewer: ViewerStart?
    @AppStorage("gridDensity") private var density = GridDensity.m

    var body: some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .searchable(text: $search, placement: .toolbar, prompt: "Filter by filename")
            .sheet(isPresented: $showFilters) {
                FilterSheet(filters: $filters, density: $density, isLibrary: libraryID != nil, isFavorites: scope == .favorites)
                    .presentationDetents([.medium, .large])
            }
            .fullScreenCover(item: $viewer) { start in
                if let list {
                    ViewerScreen(list: list, startID: start.id, onOpenTag: { tag in
                        viewer = nil
                        openRoute(.tag(tag))
                    })
                }
            }
            .task(id: TaskKey(query: query, epoch: model.visibilityEpoch)) {
                let l = AssetListModel(client: model.client, query: query)
                list = l
                await l.reload()
                await loadFolders()
            }
            .onChange(of: model.changeCount) {
                guard let change = model.lastChange, let list else { return }
                if libraryID == nil || change.libraries.contains(libraryID!) {
                    Task {
                        await list.refreshHead(removed: change.removed)
                        await loadFolders()
                    }
                }
            }
    }

    private struct TaskKey: Equatable {
        let query: AssetQuery
        let epoch: Int
    }

    struct ViewerStart: Identifiable {
        let id: Int
    }

    // MARK: Query

    private var libraryID: String? {
        if case .library(let id, _) = scope { return id }
        return nil
    }

    private var folder: String {
        if case .library(_, let f) = scope { return f }
        return ""
    }

    private var query: AssetQuery {
        var q = AssetQuery()
        switch scope {
        case .all: break
        case .favorites: q.favorite = true
        case .library(let id, let folder):
            q.library = id
            q.folder = folder
        case .tag(let t): q.tag = t
        }
        if filters.favorite { q.favorite = true }
        q.minRating = filters.minRating
        q.kind = filters.kind
        q.caption = filters.caption
        q.ascending = filters.ascending
        // The web's rule: flat only applies inside a library.
        q.recursive = libraryID == nil ? true : !filters.flat
        return q
    }

    private var title: String {
        switch scope {
        case .all: "All media"
        case .favorites: "Favorites"
        case .tag(let t): "# \(t)"
        case .library(let id, let folder):
            folder.isEmpty ? (model.library(id)?.name ?? id) : String(folder.split(separator: "/").last ?? "")
        }
    }

    private var shown: [Asset] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard let list else { return [] }
        return needle.isEmpty ? list.items : list.items.filter { $0.name.lowercased().contains(needle) }
    }

    private func loadFolders() async {
        guard let libraryID else { return }
        folders = (try? await model.client.folders(library: libraryID, folder: folder)) ?? folders
    }

    // MARK: Views

    @ViewBuilder private var content: some View {
        if let list {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    header(list)
                    if !list.loaded && list.loading {
                        SkeletonGrid(density: density)
                    } else if shown.isEmpty && list.error == nil {
                        emptyState(list)
                    } else {
                        AssetGrid(
                            items: shown, density: density,
                            groupByDay: !filters.ascending && density != .s,
                            onOpen: { viewer = ViewerStart(id: $0.id) },
                            onNearEnd: { Task { await list.loadMore() } }
                        )
                        if list.hasMore {
                            if search.isEmpty {
                                ProgressView().frame(maxWidth: .infinity).padding()
                            } else {
                                // Few matches leave the grid short, so it may never reach the end.
                                Button("Load more to search") { Task { await list.loadMore() } }
                                    .buttonStyle(.bordered).frame(maxWidth: .infinity).padding()
                            }
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
            .refreshable {
                await list.reload()
                await loadFolders()
                await model.loadStatus()
            }
        } else {
            ProgressView()
        }
    }

    @ViewBuilder private func header(_ list: AssetListModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let lib = libraryID.flatMap(model.library), !lib.available {
                ErrorBanner(message: lib.error ?? "This library is unavailable.")
            }
            if let e = list.error {
                ErrorBanner(message: e) { Task { await list.reload() } }
            }
            HStack {
                Text(subtitle(list)).font(.footnote).foregroundStyle(.secondary)
                Spacer()
            }
            if !folders.isEmpty {
                FolderStrip(folders: folders) { f in
                    if let libraryID { openRoute(.folder(library: libraryID, path: f.path)) }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 4)
    }

    private func subtitle(_ list: AssetListModel) -> String {
        var s: String
        if !search.trimmingCharacters(in: .whitespaces).isEmpty {
            s = "\(shown.count) match\(shown.count == 1 ? "" : "es")" + (list.hasMore ? " in \(list.items.count) loaded" : "")
        } else if let t = list.total {
            s = "\(t.formatted()) item\(t == 1 ? "" : "s")"
        } else {
            s = ""
        }
        if let st = model.status {
            if st.pending > 0 { s += " · indexing \(st.pending)" } else if st.scanning { s += " · scanning" }
        }
        return s
    }

    @ViewBuilder private func emptyState(_ list: AssetListModel) -> some View {
        VStack(spacing: 12) {
            Image(systemName: search.isEmpty ? "photo.on.rectangle" : "magnifyingglass").font(.system(size: 40)).foregroundStyle(.secondary)
            if !search.isEmpty {
                Text("No loaded filenames match “\(search.trimmingCharacters(in: .whitespaces))”.")
            } else if filters.active {
                Text("Nothing matches these filters.")
                Button("Reset filters") { filters = GridFilters() }.buttonStyle(.bordered)
            } else if model.status?.scanning == true || (model.status?.pending ?? 0) > 0 {
                Text("Scanning… new files will appear here.")
            } else {
                Text(scope == .favorites ? "No favorites yet. Tap ♥ in the viewer." : "Nothing here yet.")
            }
        }
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if scope != .favorites {
                Button {
                    filters.favorite.toggle()
                } label: {
                    Image(systemName: filters.favorite ? "heart.fill" : "heart")
                }
                .accessibilityLabel(filters.favorite ? "Show all" : "Show favorites")
            }
            Button { showFilters = true } label: {
                Image(systemName: filters.active ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
            }
            .accessibilityLabel("Filter and view options")
            .accessibilityIdentifier("grid-filters")
            if model.hiddenEnabled {
                Button(action: showUnlock) {
                    Image(systemName: model.unlocked ? "lock.open" : "lock")
                }
                .accessibilityLabel(model.unlocked ? "Hidden items are shown" : "Show hidden items")
            }
        }
    }
}

/// Subfolders of the current folder, with cover and count.
private struct FolderStrip: View {
    let folders: [Folder]
    let onOpen: (Folder) -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(folders) { f in
                    Button { onOpen(f) } label: {
                        HStack(spacing: 8) {
                            Group {
                                if let c = f.cover {
                                    RemoteImage(url: model.client.thumbURL(c))
                                } else {
                                    Image(systemName: "folder").frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.surface2)
                                }
                            }
                            .frame(width: 36, height: 36)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(f.name).font(.subheadline).lineLimit(1)
                                Text("\(f.count)").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .padding(6)
                        .padding(.trailing, 6)
                        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("folder-\(f.name)")
                }
            }
        }
    }
}

private struct SkeletonGrid: View {
    let density: GridDensity

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: density.minWidth), spacing: 2)], spacing: 2) {
            ForEach(0..<24, id: \.self) { _ in
                Rectangle().fill(Color.white.opacity(0.05)).aspectRatio(1, contentMode: .fit)
            }
        }
        .redacted(reason: .placeholder)
    }
}

/// The view options sheet (the web's filter sheet).
struct FilterSheet: View {
    @Binding var filters: GridFilters
    @Binding var density: GridDensity
    let isLibrary: Bool
    let isFavorites: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Picker("Show", selection: $filters.kind) {
                    Text("All").tag(AssetKind?.none)
                    Text("Images").tag(AssetKind?.some(.image))
                    Text("Videos").tag(AssetKind?.some(.video))
                    Text("Audio").tag(AssetKind?.some(.audio))
                    Text("Documents").tag(AssetKind?.some(.markdown))
                }
                if !isFavorites {
                    Toggle("Favorites only", isOn: $filters.favorite)
                }
                Section("Minimum rating") {
                    HStack {
                        StarRating(rating: filters.minRating, size: 26) { filters.minRating = $0 }
                        Spacer()
                        Text(filters.minRating > 0 ? "\(filters.minRating)+" : "Any").foregroundStyle(.secondary)
                    }
                }
                Picker("Caption", selection: $filters.caption) {
                    Text("All").tag(CaptionFilter?.none)
                    ForEach(CaptionFilter.allCases, id: \.self) { Text($0.label).tag(CaptionFilter?.some($0)) }
                }
                Picker("Sort by date", selection: $filters.ascending) {
                    Text("Newest first").tag(false)
                    Text("Oldest first").tag(true)
                }
                if isLibrary {
                    Toggle("Include subfolders", isOn: Binding(get: { !filters.flat }, set: { filters.flat = !$0 }))
                }
                Picker("Thumbnail size", selection: $density) {
                    ForEach(GridDensity.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                if filters.active {
                    Button("Reset filters", role: .destructive) { filters = GridFilters() }
                }
            }
            .navigationTitle("View")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
