import AVKit
import SwiftUI

/// An image page: the cached thumbnail at once, then the full image.
struct ImagePage: View {
    @Environment(AppModel.self) private var model
    let asset: Asset
    @Binding var zoomed: Bool
    let onTap: () -> Void
    @State private var full: UIImage?
    @State private var failed = false

    var body: some View {
        ZoomableImage(image: full ?? ImageLoader.shared.cached(model.client.thumbURL(asset)), zoomed: $zoomed, onSingleTap: onTap)
            .overlay {
                if full == nil && !failed { ProgressView().tint(.white) }
                if failed {
                    Label("Could not load the image", systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
                }
            }
            .accessibilityLabel(asset.name)
            .task(id: asset.v) {
                // Keep the thumbnail around too (for the next time it's opened).
                async let thumb: UIImage? = ImageLoader.shared.load(model.client.thumbURL(asset))
                full = await ImageLoader.shared.load(model.client.displayURL(asset), maxPixel: 4096)
                failed = full == nil && !Task.isCancelled
                _ = await thumb
            }
    }
}

/// Cookies (the hidden-items unlock) for AVFoundation, which doesn't use URLSession's store.
func mediaAsset(_ url: URL) -> AVURLAsset {
    let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
    return AVURLAsset(url: url, options: [AVURLAssetHTTPCookiesKey: cookies])
}

/// Video or audio, with system playback controls. Pauses when it isn't the current page.
/// A video fills the screen behind the viewer's bars; `controlsInsets` keeps the player's own
/// controls (with their full-screen button) clear of them.
struct PlayerPage: View {
    @Environment(AppModel.self) private var model
    let asset: Asset
    let active: Bool
    var controlsInsets = EdgeInsets()
    @State private var player: AVPlayer?

    var body: some View {
        ZStack {
            if asset.kind == .audio {
                // Cover art (or a placeholder) behind the controls.
                VStack(spacing: 16) {
                    RemoteImage(url: model.client.thumbURL(asset), contentMode: .fit)
                        .frame(maxWidth: 320, maxHeight: 320)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    Text(asset.name).font(.headline).multilineTextAlignment(.center)
                }
                .padding(40)
                .padding(.top, controlsInsets.top)
                .padding(.bottom, controlsInsets.bottom)
            }
            if let player {
                InsetPlayerView(player: player, controlsInsets: controlsInsets)
                    .opacity(asset.kind == .audio ? 0.85 : 1)
                    .frame(maxHeight: asset.kind == .audio ? 140 + controlsInsets.bottom : .infinity)
                    .frame(maxHeight: .infinity, alignment: asset.kind == .audio ? .bottom : .center)
            }
            if asset.playable == "no" {
                Label("This file's format can't be played here.", systemImage: "exclamationmark.triangle")
                    .padding().background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .onAppear {
            if player == nil {
                player = AVPlayer(playerItem: AVPlayerItem(asset: mediaAsset(model.client.fileURL(asset))))
            }
            if active { player?.play() }
        }
        .onChange(of: active) {
            if active { player?.play() } else { player?.pause() }
        }
        .onDisappear { player?.pause() }
    }
}

/// AVPlayerViewController filling its frame, with its controls pushed in by `controlsInsets`
/// (on top of whatever safe area it already gets, so they're never counted twice).
struct InsetPlayerView: UIViewControllerRepresentable {
    let player: AVPlayer
    let controlsInsets: EdgeInsets

    func makeUIViewController(context: Context) -> InsetPlayerController {
        let vc = InsetPlayerController()
        vc.player = player
        vc.videoGravity = .resizeAspect
        vc.view.backgroundColor = .clear
        vc.controlsInsets = controlsInsets
        return vc
    }

    func updateUIViewController(_ vc: InsetPlayerController, context: Context) {
        if vc.player !== player { vc.player = player }
        vc.controlsInsets = controlsInsets
    }
}

final class InsetPlayerController: AVPlayerViewController {
    var controlsInsets = EdgeInsets() {
        didSet { if controlsInsets != oldValue { view.setNeedsLayout() } }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let base = view.safeAreaInsets
        let current = additionalSafeAreaInsets
        // The safe area without our addition, then only what's missing on each edge.
        let top = base.top - current.top, bottom = base.bottom - current.bottom
        let left = base.left - current.left, right = base.right - current.right
        let wanted = UIEdgeInsets(
            top: max(0, controlsInsets.top - top), left: max(0, controlsInsets.leading - left),
            bottom: max(0, controlsInsets.bottom - bottom), right: max(0, controlsInsets.trailing - right))
        if wanted != current { additionalSafeAreaInsets = wanted }
    }
}
