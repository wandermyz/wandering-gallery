import SwiftUI
import WebKit

/// A diagram from a document, full screen: pinch to zoom (it stays sharp, being vector),
/// drag to pan, double-tap to zoom in and out.
struct DiagramZoomView: View {
    let svg: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Theme.background.ignoresSafeArea()
            DiagramWebView(svg: svg)
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .tint(.primary)
            .padding(.trailing, 16)
            .padding(.top, 8)
            .accessibilityLabel("Close diagram")
        }
    }
}

/// The SVG fitted to the view, in a web view that zooms (up to 10x, WebKit's limit).
private struct DiagramWebView: UIViewRepresentable {
    let svg: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.dataDetectorTypes = []
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(Theme.background)
        web.scrollView.backgroundColor = UIColor(Theme.background)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bouncesZoom = true
        web.allowsLinkPreview = false
        web.loadHTMLString(Self.page(svg), baseURL: nil)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    private static func page(_ svg: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=10">
        <style>
        html, body { margin: 0; height: 100%; background: #050707; color: #f5f8f8; -webkit-user-select: none; -webkit-touch-callout: none;
          font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; }
        body { display: flex; align-items: center; justify-content: center; overflow: hidden; }
        svg { display: block; flex: none; }
        </style></head><body>\(svg)
        <script>
        const s = document.querySelector('svg');
        const vb = s.viewBox.baseVal, r = s.getBoundingClientRect();
        const w = vb && vb.width ? vb.width : r.width || 300, h = vb && vb.height ? vb.height : r.height || 150;
        // Its own size, not the document's; the style also holds the diagram's colors and fonts.
        s.style.removeProperty('max-width');
        s.style.removeProperty('height');
        // Fits the layout viewport (unchanged by zooming), so rotating refits.
        const fit = () => {
          const e = document.documentElement, k = Math.min(e.clientWidth * 0.94 / w, e.clientHeight * 0.94 / h);
          s.setAttribute('width', w * k);
          s.setAttribute('height', h * k);
        };
        fit();
        addEventListener('resize', fit);
        </script></body></html>
        """
    }
}
