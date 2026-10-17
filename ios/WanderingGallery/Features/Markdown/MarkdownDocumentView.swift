import SwiftUI

/// A Markdown document from the gallery, rendered by the web client's renderer in a web
/// view (Resources/Markdown). Its embedded media are gallery assets resolved by the server,
/// so it is fetched again whenever the lock changes. Links to assets and embedded images
/// open through `onOpenAsset`; diagrams open full screen to zoom into.
struct MarkdownDocumentView: View {
    let asset: Asset
    let onOpenAsset: (Asset) -> Void

    @Environment(AppModel.self) private var model
    @State private var doc: APIClient.MarkdownResponse?
    @State private var revision = 0
    @State private var rendered = false
    @State private var error: String?
    @State private var attempt = 0
    @State private var diagram: Diagram?

    private struct LoadKey: Hashable {
        let id: Int
        let v: String
        let epoch: Int
        let attempt: Int
    }

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            if let doc, error == nil {
                MarkdownWebView(doc: doc, revision: revision, baseURL: model.client.baseURL, onEvent: handle)
                    .opacity(rendered ? 1 : 0)
            }
            if let error {
                VStack(spacing: 12) {
                    ErrorBanner(message: "This document could not be displayed: \(error)") { attempt += 1 }
                }
                .padding()
            } else if !rendered {
                ProgressView()
            }
        }
        .task(id: LoadKey(id: asset.id, v: asset.v, epoch: model.visibilityEpoch, attempt: attempt)) { await load() }
        .fullScreenCover(item: $diagram) { DiagramZoomView(svg: $0.svg) }
    }

    private func load() async {
        do {
            let d = try await model.client.markdown(asset.id)
            error = nil
            doc = d
            revision += 1
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func handle(_ event: MarkdownEvent) {
        switch event {
        case .rendered:
            rendered = true
        case .failed(let message):
            error = message
        case .asset(let id):
            if let a = doc?.refs.values.lazy.compactMap({ $0 }).first(where: { $0.id == id }) { onOpenAsset(a) }
        case .diagram(let svg):
            diagram = Diagram(svg: svg)
        }
    }
}

/// A diagram's SVG, shown full screen.
struct Diagram: Identifiable {
    let id = UUID()
    let svg: String
}
