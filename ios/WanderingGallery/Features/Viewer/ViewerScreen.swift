import SwiftUI

/// The full-screen viewer over a grid's list: swipe between items, pinch / double-tap zoom,
/// swipe down to close, tap to hide the controls. Favorite, rating, tags and details, hide,
/// trash, copy path, share, and hand an image to the video flow.
struct ViewerScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let list: AssetListModel
    let startID: Int
    var onOpenTag: (String) -> Void = { _ in }

    @State private var currentID: Int?
    @State private var chrome = true
    @State private var zoomed = false
    @State private var showInfo = false
    @State private var confirmTrash = false
    @State private var error: String?
    @State private var toast: String?
    @State private var dragY: CGFloat = 0
    @State private var sharing = false
    @State private var shareItem: ShareFile?
    /// The screen's safe area (the pager itself runs edge to edge).
    @State private var insets = EdgeInsets()
    /// The screen's height, for sliding the page out when swiped away.
    @State private var height: CGFloat = 1000

    private var asset: Asset? { list.items.first { $0.id == currentID } }
    private var index: Int? { list.items.firstIndex { $0.id == currentID } }

    var body: some View {
        ZStack {
            Color.black.opacity(1 - min(0.6, abs(dragY) / 600)).ignoresSafeArea()
            // The window's safe area, read again when the size changes (rotation). A view that
            // ignores the safe area (as the pager must) reports zero insets itself.
            GeometryReader { g in
                Color.clear
                    .onAppear { insets = Self.windowInsets(); height = g.size.height }
                    .onChange(of: g.size) { insets = Self.windowInsets(); height = g.size.height }
            }
            .ignoresSafeArea()
            pager
                .scaleEffect(1 - min(0.25, dragY / 1600))
                .offset(y: dragY)
                .ignoresSafeArea()
            if chrome, dragY == 0, let asset {
                controls(asset)
                    .transition(.opacity)
            }
            if let toast {
                Text(toast)
                    .font(.callout)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
                    .frame(maxHeight: .infinity, alignment: .top)
                    .padding(.top, 70)
                    .transition(.opacity)
            }
        }
        .statusBarHidden(!chrome)
        .persistentSystemOverlays(chrome ? .automatic : .hidden)
        .animation(.easeInOut(duration: 0.2), value: chrome)
        .animation(.easeOut(duration: 0.15), value: dragY == 0)
        .inspector(isPresented: $showInfo) {
            if let asset {
                InfoPanel(asset: asset, onChange: { list.patch($0) }, onOpenTag: { tag in
                    showInfo = false
                    onOpenTag(tag)
                })
                .inspectorColumnWidth(min: 320, ideal: 380, max: 480)
                .presentationDetents([.medium, .large])
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
            }
        }
        .confirmationDialog("Move to trash?", isPresented: $confirmTrash, titleVisibility: .visible) {
            Button("Move to trash", role: .destructive) { Task { await trash() } }
        } message: {
            Text("\(asset?.name ?? "") can be restored from Trash for \(model.status?.trashRetentionDays ?? 7) days.")
        }
        .errorAlert($error)
        .sheet(item: $shareItem) { item in ShareSheet(items: [item.url]) }
        .onAppear { if currentID == nil { currentID = startID } }
        .onChange(of: currentID) {
            zoomed = false
            // Load the next page before reaching the end.
            if let i = index, i >= list.items.count - 5 { Task { await list.loadMore() } }
        }
        .onChange(of: list.items) {
            // The current item left the list (trashed / hidden elsewhere): close if nothing's left.
            if list.items.isEmpty { dismiss() } else if asset == nil { currentID = list.items.first?.id }
        }
        .focusable()
        .focusEffectDisabled()
        .onKeyPress(keys: [.leftArrow, .rightArrow, .escape, .delete, .deleteForward]) { press in
            switch press.key {
            case .leftArrow: go(-1)
            case .rightArrow: go(1)
            case .escape: dismiss()
            default: if asset != nil, writable { confirmTrash = true }
            }
            return .handled
        }
        .onKeyPress(characters: CharacterSet(charactersIn: "fi012345")) { press in
            guard let asset else { return .ignored }
            switch press.characters {
            case "f": Task { await setFavorite(asset, !asset.favorite) }
            case "i": showInfo.toggle()
            default: if let n = Int(press.characters) { Task { await rate(asset, n) } }
            }
            return .handled
        }
    }

    // MARK: Pages

    private var pager: some View {
        TabView(selection: $currentID) {
            ForEach(list.items) { a in
                page(a)
                    .tag(Optional(a.id))
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .simultaneousGesture(zoomed || asset?.kind == .markdown ? nil : dismissDrag)
    }

    @ViewBuilder private func page(_ a: Asset) -> some View {
        switch a.kind {
        case .image:
            // Fits between the bars with a little space (a tall image stays clear of the title),
            // whether or not the bars are showing, so it doesn't jump on tap. (The page itself
            // is already inside the safe area.)
            ImagePage(asset: a, zoomed: a.id == currentID ? $zoomed : .constant(false), fitInsets: EdgeInsets(
                top: Self.barHeight + Self.imageGap, leading: 0,
                bottom: Self.barHeight + Self.imageGap, trailing: 0), onTap: { chrome.toggle() })
        case .video, .audio:
            // Edge to edge behind the bars (a tall video uses the whole screen); the player's
            // own controls stay clear of the bars.
            PlayerPage(asset: a, active: a.id == currentID, controlsInsets: EdgeInsets(
                top: insets.top + Self.barHeight + Self.controlsGap - Self.playerTopMargin, leading: insets.leading,
                bottom: insets.bottom + Self.barHeight + Self.controlsGap - Self.playerBottomMargin, trailing: insets.trailing))

        case .markdown:
            MarkdownDocumentView(asset: a, active: a.id == currentID) { target in open(target) }
                .padding(.top, chrome ? 56 : 0)
                .padding(.bottom, chrome ? 64 : 0)
        }
    }

    private static func windowInsets() -> EdgeInsets {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }
        let i = window?.safeAreaInsets ?? .zero
        return EdgeInsets(top: i.top, leading: i.left, bottom: i.bottom, trailing: i.right)
    }

    /// Height of the top and bottom control bars.
    private static let barHeight: CGFloat = 44
    /// Space between our bars and an image fitted between them.
    private static let imageGap: CGFloat = 4
    /// Space between our bars and the player's own controls.
    private static let controlsGap: CGFloat = 6
    /// The system player's own margins inside its safe area: above its top buttons and below
    /// its scrubber (measured on iOS 26). Taken off, so its controls hug our bars.
    private static let playerTopMargin: CGFloat = 72
    private static let playerBottomMargin: CGFloat = 54

    private var dismissDrag: some Gesture {
        DragGesture(minimumDistance: 20)
            .onChanged { v in
                if abs(v.translation.height) > abs(v.translation.width) * 1.5, v.translation.height > 0 {
                    dragY = v.translation.height
                }
            }
            .onEnded { v in
                if dragY > 120 || v.predictedEndTranslation.height > 400 && dragY > 0 {
                    close()
                } else {
                    withAnimation(.spring(duration: 0.25)) { dragY = 0 }
                }
            }
    }

    /// Swiped down: slides the page the rest of the way out, then closes
    /// without the cover's own slide-down (which would start again from the top, bars and all).
    private func close() {
        withAnimation(.easeOut(duration: 0.2)) {
            dragY = height
        } completion: {
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) { dismiss() }
        }
    }

    /// An asset linked from a document: the current list if it's there, else on its own.
    private func open(_ target: Asset) {
        if list.items.contains(where: { $0.id == target.id }) {
            currentID = target.id
        } else {
            linked = target
        }
    }

    @State private var linked: Asset?

    // MARK: Controls

    private var writable: Bool { asset.flatMap { model.library($0.library)?.writable } ?? false }

    @ViewBuilder private func controls(_ a: Asset) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                Button { dismiss() } label: { Image(systemName: "chevron.down").frame(width: 40, height: 40) }
                    .accessibilityLabel("Close")
                    .accessibilityIdentifier("viewer-close")
                VStack(alignment: .leading, spacing: 1) {
                    Text(a.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                        .accessibilityIdentifier("viewer-title")
                    Text(subtitle(a)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        .accessibilityIdentifier("viewer-subtitle")
                }
                Spacer()
                if let p = a.filePath {
                    Button {
                        copyToPasteboard(p)
                        flash("Path copied")
                    } label: { Image(systemName: "doc.on.doc").frame(width: 40, height: 40) }
                        .accessibilityLabel("Copy path")
                }
                Menu {
                    Button("Share or save original", systemImage: "square.and.arrow.up") { Task { await share(a) } }
                    if a.kind == .image {
                        Button("Use in video flow", systemImage: "film") {
                            model.videoInput = a
                            model.tab = .generate
                            dismiss()
                        }
                    }
                    Link(destination: model.client.fileURL(a)) { Label("Open original in Safari", systemImage: "safari") }
                } label: {
                    Group {
                        if sharing { ProgressView() } else { Image(systemName: "ellipsis.circle") }
                    }
                    .frame(width: 40, height: 40)
                }
                .accessibilityLabel("More")
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 4)
            .background(LinearGradient(colors: [.black.opacity(0.7), .clear], startPoint: .top, endPoint: .bottom).ignoresSafeArea())

            Spacer()

            HStack(spacing: 6) {
                if a.status == "ready" {
                    Button { Task { await setFavorite(a, !a.favorite) } } label: {
                        Image(systemName: a.favorite ? "heart.fill" : "heart")
                            .foregroundStyle(a.favorite ? Theme.favorite : .white)
                            .frame(width: 40, height: 40)
                    }
                    .accessibilityLabel(a.favorite ? "Remove from favorites" : "Add to favorites")
                    .accessibilityIdentifier("viewer-favorite")
                    StarRating(rating: a.rating, size: 20) { n in Task { await rate(a, n) } }
                }
                Spacer()
                Button { showInfo.toggle() } label: {
                    Image(systemName: showInfo ? "info.circle.fill" : "info.circle").frame(width: 40, height: 40)
                }
                .accessibilityLabel("Details and metadata")
                .accessibilityIdentifier("viewer-info")
                if model.hiddenEnabled {
                    Button { Task { await setHidden(a, !a.hidden) } } label: {
                        Image(systemName: a.hidden ? "eye.slash.fill" : "eye.slash").frame(width: 40, height: 40)
                    }
                    .accessibilityLabel(a.hidden ? "Unhide" : "Hide")
                    .accessibilityIdentifier("viewer-hide")
                }
                Button { confirmTrash = true } label: {
                    Image(systemName: "trash").frame(width: 40, height: 40)
                }
                .disabled(!writable)
                .accessibilityLabel(writable ? "Move to trash" : "Library is read-only")
                .accessibilityIdentifier("viewer-trash")
            }
            .padding(.horizontal, 8)
            .padding(.top, 4)
            .background(LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        }
        .foregroundStyle(.white)
        .buttonStyle(.plain)
        .fullScreenCover(item: $linked) { target in
            SingleAssetViewer(asset: target)
        }
    }

    private func subtitle(_ a: Asset) -> String {
        var parts = [Format.date(ms: a.mtimeMs)]
        if let w = a.width, let h = a.height { parts.append("\(w)×\(h)") }
        if let i = index { parts.append("\(i + 1) of \(list.total ?? list.items.count)") }
        return parts.joined(separator: " · ")
    }

    // MARK: Actions

    private func go(_ delta: Int) {
        guard let i = index else { return }
        let j = i + delta
        if list.items.indices.contains(j) { withAnimation { currentID = list.items[j].id } }
    }

    private func flash(_ text: String) {
        withAnimation { toast = text }
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation { if toast == text { toast = nil } }
        }
    }

    private func setFavorite(_ a: Asset, _ on: Bool) async {
        do {
            list.patch(try await model.client.favorite(a.id, on))
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch { self.error = error.localizedDescription }
    }

    private func rate(_ a: Asset, _ n: Int) async {
        do {
            list.patch(try await model.client.rate(a.id, n))
            UISelectionFeedbackGenerator().selectionChanged()
        } catch { self.error = error.localizedDescription }
    }

    private func setHidden(_ a: Asset, _ hidden: Bool) async {
        if !hidden && !model.unlocked {
            error = "Unlock hidden items (🔒) to unhide."
            return
        }
        do {
            let updated = try await model.client.hide(a.id, hidden)
            if hidden && !model.unlocked {
                // Hidden items leave every list while locked.
                step(awayFrom: a.id)
                list.remove(a.id)
                flash("Hidden")
            } else {
                list.patch(updated)
                flash(hidden ? "Hidden" : "Unhidden")
            }
        } catch { self.error = error.localizedDescription }
    }

    private func trash() async {
        guard let a = asset else { return }
        do {
            _ = try await model.client.trash(a)
            step(awayFrom: a.id)
            list.remove(a.id)
            flash("Moved to trash")
            await model.loadStatus()
        } catch { self.error = error.localizedDescription }
    }

    /// Moves to the next item (or the previous one at the end) before `id` is removed.
    private func step(awayFrom id: Int) {
        guard let i = list.items.firstIndex(where: { $0.id == id }) else { return }
        if list.items.indices.contains(i + 1) { currentID = list.items[i + 1].id } else if i > 0 { currentID = list.items[i - 1].id }
    }

    private func share(_ a: Asset) async {
        sharing = true
        defer { sharing = false }
        do {
            shareItem = ShareFile(url: try await download(a))
        } catch { self.error = "Could not download \(a.name): \(error.localizedDescription)" }
    }

    /// The original file in a temporary folder, under its own name.
    private func download(_ a: Asset) async throws -> URL {
        let (tmp, response) = try await URLSession.shared.download(from: model.client.fileURL(a))
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError(message: "download failed", status: (response as? HTTPURLResponse)?.statusCode ?? 0) }
        let dir = FileManager.default.temporaryDirectory.appending(path: "share-\(a.id)", directoryHint: .isDirectory)
        try? FileManager.default.removeItem(at: dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appending(path: a.name)
        try FileManager.default.moveItem(at: tmp, to: dest)
        return dest
    }
}

struct ShareFile: Identifiable {
    let url: URL
    var id: URL { url }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

/// One asset on its own (opened from a document link or a generate output).
struct SingleAssetViewer: View {
    @Environment(AppModel.self) private var model
    let asset: Asset
    @State private var list: AssetListModel?

    var body: some View {
        // Not a bare Group: an empty one never appears, so the list would never be made.
        ZStack {
            Color.black.ignoresSafeArea()
            if let list { ViewerScreen(list: list, startID: asset.id) }
        }
        .onAppear { if list == nil { list = .single(asset, client: model.client) } }
    }
}

extension AssetListModel {
    static func single(_ a: Asset, client: APIClient) -> AssetListModel {
        let l = AssetListModel(client: client, query: AssetQuery())
        l.setItems([a])
        return l
    }
}

/// The viewer for an asset known only by id (a generate or dashboard output).
struct AssetByIDViewer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let id: Int
    @State private var asset: Asset?
    @State private var error: String?

    var body: some View {
        Group {
            if let asset {
                SingleAssetViewer(asset: asset)
            } else {
                ZStack {
                    Color.black.ignoresSafeArea()
                    if let error { Text(error).foregroundStyle(.secondary).padding() } else { ProgressView() }
                }
                .overlay(alignment: .topLeading) {
                    Button { dismiss() } label: { Image(systemName: "chevron.down").frame(width: 44, height: 44) }
                        .accessibilityLabel("Close")
                        .accessibilityIdentifier("viewer-close")
                }
            }
        }
        .task {
            do { asset = try await model.client.asset(id) } catch { self.error = error.localizedDescription }
        }
    }
}
