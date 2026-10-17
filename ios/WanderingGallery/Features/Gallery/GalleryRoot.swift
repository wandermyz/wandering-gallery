import SwiftUI

enum GallerySection: Hashable {
    case all, favorites, tags, trash
    case library(String)
}

enum GalleryRoute: Hashable {
    case folder(library: String, path: String)
    case tag(String)
}

/// Gallery tab: a sidebar of views and libraries (the web's ☰ menu) next to the grid on
/// iPad; on iPhone a stack whose root is that list, opened on All media.
struct GalleryRoot: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var section: GallerySection? = .all
    @State private var path: [GalleryRoute] = []
    @State private var compactPath = NavigationPath([GallerySection.all])
    @State private var unlockSheet = false

    var body: some View {
        Group {
            if sizeClass == .compact {
                NavigationStack(path: $compactPath) {
                    GallerySidebar(section: nil, unlockSheet: $unlockSheet)
                        .navigationDestination(for: GallerySection.self) { sectionView($0) }
                        .navigationDestination(for: GalleryRoute.self) { routeView($0) }
                }
                .environment(\.openGalleryRoute) { compactPath.append($0) }
            } else {
                NavigationSplitView {
                    GallerySidebar(section: $section, unlockSheet: $unlockSheet)
                } detail: {
                    NavigationStack(path: $path) {
                        sectionView(section ?? .all)
                            .id(section)
                            .navigationDestination(for: GalleryRoute.self) { routeView($0) }
                    }
                    .environment(\.openGalleryRoute) { path.append($0) }
                }
                .onChange(of: section) { path = [] }
            }
        }
        .environment(\.showUnlock) { unlockSheet = true }
        .sheet(isPresented: $unlockSheet) { UnlockSheet() }
    }

    @ViewBuilder private func sectionView(_ s: GallerySection) -> some View {
        switch s {
        case .all: AssetGridScreen(scope: .all)
        case .favorites: AssetGridScreen(scope: .favorites)
        case .library(let id): AssetGridScreen(scope: .library(id, folder: ""))
        case .tags: TagsScreen()
        case .trash: TrashScreen()
        }
    }

    @ViewBuilder private func routeView(_ r: GalleryRoute) -> some View {
        switch r {
        case .folder(let lib, let p): AssetGridScreen(scope: .library(lib, folder: p))
        case .tag(let name): AssetGridScreen(scope: .tag(name))
        }
    }
}

extension EnvironmentValues {
    /// Pushes a folder or tag view onto the gallery's stack.
    @Entry var openGalleryRoute: (GalleryRoute) -> Void = { _ in }
    /// Opens the hidden-items unlock sheet.
    @Entry var showUnlock: () -> Void = {}
}

private struct GallerySidebar: View {
    @Environment(AppModel.self) private var model
    /// The split view's selection; nil in a stack, where the rows push instead.
    var section: Binding<GallerySection?>?
    @Binding var unlockSheet: Bool
    @State private var rescanned = false

    var body: some View {
        Group {
            if let section {
                List(selection: section) { rows }
            } else {
                List { rows }
            }
        }
        .navigationTitle(model.server.name)
        .toolbar {
            if model.hiddenEnabled {
                ToolbarItem(placement: .primaryAction) {
                    Button { unlockSheet = true } label: {
                        Image(systemName: model.unlocked ? "lock.open" : "lock")
                    }
                    .accessibilityLabel(model.unlocked ? "Hidden items are shown" : "Show hidden items")
                }
            }
        }
        .refreshable { await model.refresh() }
    }

    @ViewBuilder private var rows: some View {
            Section {
                NavigationLink(value: GallerySection.all) { Label("All media", systemImage: "photo.on.rectangle.angled") }
                NavigationLink(value: GallerySection.favorites) { Label("Favorites", systemImage: "heart") }
                NavigationLink(value: GallerySection.tags) { Label("Tags", systemImage: "tag") }
            }
            Section("Libraries") {
                ForEach(model.libraries) { lib in
                    NavigationLink(value: GallerySection.library(lib.id)) {
                        HStack {
                            Label {
                                Text(lib.name)
                            } icon: {
                                Image(systemName: lib.hidden ? "eye.slash" : lib.writable ? "folder" : "lock")
                            }
                            Spacer()
                            if !lib.available {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            } else if lib.scanning {
                                ProgressView().controlSize(.small)
                            } else {
                                Text(lib.count, format: .number).foregroundStyle(.secondary).font(.callout)
                            }
                        }
                    }
                }
            }
            Section {
                NavigationLink(value: GallerySection.trash) {
                    HStack {
                        Label("Trash", systemImage: "trash")
                        Spacer()
                        if let n = model.status?.trash, n > 0 { Text("\(n)").foregroundStyle(.secondary).font(.callout) }
                    }
                }
            }
            Section {
                Button {
                    Task {
                        if case .library(let id) = section?.wrappedValue { try? await model.client.rescan(library: id) } else { try? await model.client.rescan() }
                        rescanned = true
                        try? await Task.sleep(for: .seconds(0.8))
                        await model.loadStatus()
                    }
                } label: {
                    Label(rescanLabel, systemImage: "arrow.triangle.2.circlepath")
                }
                if let s = model.status, s.scanning || s.pending > 0 {
                    Label(s.pending > 0 ? "Indexing \(s.pending)…" : "Scanning…", systemImage: "hourglass").foregroundStyle(.secondary)
                }
                if let e = model.connectionError {
                    Label(e, systemImage: "wifi.exclamationmark").foregroundStyle(.orange).font(.callout)
                }
            }
    }

    private var rescanLabel: String {
        if rescanned { return "Rescanning…" }
        if case .library(let id) = section?.wrappedValue, let lib = model.library(id) { return "Rescan \(lib.name)" }
        return "Rescan all libraries"
    }
}
