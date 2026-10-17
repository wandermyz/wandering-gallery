import SwiftUI
import WebKit

/// What the document page reports (web/src/ios/markdown-bundle.ts).
enum MarkdownEvent {
    /// A document was shown.
    case rendered
    case failed(String)
    /// A link to an asset, or an embedded image, was tapped.
    case asset(Int)
    /// A Mermaid diagram was tapped.
    case diagram(String)
}

/// The page that renders documents: markdown.html, with markdown.js injected. It is loaded
/// with the server as its base URL, so the gallery's relative media URLs resolve, and gets
/// the app's cookies (the hidden-items unlock) before each render. Other links open in Safari.
struct MarkdownWebView: UIViewRepresentable {
    let doc: APIClient.MarkdownResponse
    /// Bumped for each fetch: a new revision is rendered again.
    let revision: Int
    let baseURL: URL
    let onEvent: (MarkdownEvent) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(baseURL: baseURL) }

    func makeUIView(context: Context) -> WKWebView {
        let c = context.coordinator
        let config = WKWebViewConfiguration()
        // Its own cookie jar, filled from the app's before each render.
        config.websiteDataStore = .nonPersistent()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.dataDetectorTypes = []
        config.userContentController.add(WeakMessageHandler(c), name: "wg")
        if let script = MarkdownResources.script {
            config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(Theme.background)
        web.scrollView.backgroundColor = UIColor(Theme.background)
        web.scrollView.alwaysBounceHorizontal = false
        web.allowsLinkPreview = false
        web.navigationDelegate = c
        web.uiDelegate = c
        c.web = web
        c.loadPage()
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.onEvent = onEvent
        context.coordinator.show(doc, revision: revision)
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "wg")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let baseURL: URL
        weak var web: WKWebView?
        var onEvent: (MarkdownEvent) -> Void = { _ in }
        private var pageReady = false
        private var rendering = false
        private var revision: Int?
        private var pending: APIClient.MarkdownResponse?
        private var last: APIClient.MarkdownResponse?

        init(baseURL: URL) { self.baseURL = baseURL }

        func loadPage() {
            pageReady = false
            guard let template = MarkdownResources.template, MarkdownResources.script != nil else {
                onEvent(.failed("The document renderer is missing from the app."))
                return
            }
            web?.loadHTMLString(template, baseURL: baseURL)
        }

        func show(_ doc: APIClient.MarkdownResponse, revision: Int) {
            guard revision != self.revision else { return }
            self.revision = revision
            pending = doc
            renderIfReady()
        }

        /// Renders the latest document once the page is loaded, one render at a time.
        private func renderIfReady() {
            guard pageReady, !rendering, let doc = pending, let web else { return }
            pending = nil
            last = doc
            rendering = true
            Task {
                await syncCookies(web)
                do {
                    let json = String(decoding: try JSONEncoder().encode(Payload(text: doc.text, refs: doc.refs)), as: UTF8.self)
                    _ = try await web.callAsyncJavaScript("await wgRender(JSON.parse(json))", arguments: ["json": json], contentWorld: .page)
                    onEvent(.rendered)
                } catch {
                    onEvent(.failed(error.localizedDescription))
                }
                rendering = false
                renderIfReady()
            }
        }

        /// Replaces the page's cookies with the app's for the server (URLSession's jar).
        private func syncCookies(_ web: WKWebView) async {
            let store = web.configuration.websiteDataStore.httpCookieStore
            for c in await store.allCookies() { await store.deleteCookie(c) }
            for c in HTTPCookieStorage.shared.cookies(for: baseURL) ?? [] { await store.setCookie(c) }
        }

        private func openExternally(_ url: URL) {
            guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
            UIApplication.shared.open(url)
        }

        // MARK: WKScriptMessageHandler

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "asset":
                if let id = (body["id"] as? NSNumber)?.intValue { onEvent(.asset(id)) }
            case "link":
                if let href = body["href"] as? String, let url = URL(string: href) { openExternally(url) }
            case "diagram":
                if let svg = body["svg"] as? String { onEvent(.diagram(svg)) }
            default:
                break
            }
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard !pageReady else { return }
            pageReady = true
            renderIfReady()
        }

        /// Only the page itself and in-page anchors load here; links open in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard pageReady, let url = action.request.url else { return decisionHandler(.allow) }
            if sameDocument(url, webView) { return decisionHandler(.allow) }
            if action.navigationType == .linkActivated { openExternally(url) }
            decisionHandler(.cancel)
        }

        private func sameDocument(_ url: URL, _ web: WKWebView) -> Bool {
            guard let current = web.url else { return false }
            var a = URLComponents(url: url, resolvingAgainstBaseURL: false)
            var b = URLComponents(url: current, resolvingAgainstBaseURL: false)
            a?.fragment = nil
            b?.fragment = nil
            return a != nil && a == b
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // Start over with the last document.
            if pending == nil { pending = last }
            loadPage()
        }

        // MARK: WKUIDelegate

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url { openExternally(url) }
            return nil
        }
    }

    private struct Payload: Encodable {
        let text: String
        let refs: [String: Asset?]
    }
}

/// Keeps the coordinator from being retained by the web view's content controller.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// The renderer's files (copied flat into the app bundle, or in a Markdown folder).
enum MarkdownResources {
    static let template = load("markdown", "html")
    static let script = load("markdown", "js")

    private static func load(_ name: String, _ ext: String) -> String? {
        let url = Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "Markdown")
            ?? Bundle.main.url(forResource: name, withExtension: ext)
        return url.flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    }
}
