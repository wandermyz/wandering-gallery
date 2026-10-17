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
struct PlayerPage: View {
    @Environment(AppModel.self) private var model
    let asset: Asset
    let active: Bool
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
            }
            if let player {
                VideoPlayer(player: player)
                    .opacity(asset.kind == .audio ? 0.85 : 1)
                    .frame(maxHeight: asset.kind == .audio ? 140 : .infinity)
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
