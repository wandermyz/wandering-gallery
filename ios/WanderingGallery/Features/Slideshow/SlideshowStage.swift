import AVFoundation
import SwiftUI

/// The slides themselves, crossfading from one to the next: on the device's screen, or alone
/// on an external display. Reports to the model when a slide is up and when a video ends.
struct SlideshowStage: View {
    let model: SlideshowModel

    var body: some View {
        ZStack {
            Color.black
            if let a = model.current {
                SlideView(asset: a, model: model)
                    .id(a.id)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.7), value: model.current?.id)
    }
}

private struct SlideView: View {
    let asset: Asset
    let model: SlideshowModel
    @State private var image: UIImage?

    var body: some View {
        Group {
            if asset.kind == .video {
                SlideVideo(asset: asset, model: model)
            } else if let img = image ?? ImageLoader.shared.cached(model.client.displayURL(asset)) {
                Image(uiImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onAppear { model.slideReady(asset.id) }
            } else {
                // Not fetched ahead (the first slide): the thumbnail meanwhile.
                ZStack {
                    if let thumb = ImageLoader.shared.cached(model.client.thumbURL(asset)) {
                        Image(uiImage: thumb).resizable().aspectRatio(contentMode: .fit)
                    }
                    ProgressView().tint(.white)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .task(id: asset.v) {
                    image = await ImageLoader.shared.load(model.client.displayURL(asset), maxPixel: 4096)
                    if image == nil, !Task.isCancelled { model.slideReady(asset.id, failed: true) }
                }
            }
        }
        .accessibilityElement()
        .accessibilityLabel(asset.name)
        .accessibilityIdentifier("slideshow-slide")
    }
}

/// A video slide: plays from the start without controls (muted unless unmuted), looping or
/// moving on as the model says when it ends.
private struct SlideVideo: View {
    let asset: Asset
    let model: SlideshowModel
    @State private var player: AVPlayer?
    @State private var thumb: UIImage?

    var body: some View {
        ZStack {
            if let thumb = thumb ?? ImageLoader.shared.cached(model.client.thumbURL(asset)) {
                Image(uiImage: thumb).resizable().aspectRatio(contentMode: .fit)
            }
            if let player { PlayerLayerView(player: player) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: asset.id) {
            let item = AVPlayerItem(asset: mediaAsset(model.client.fileURL(asset)))
            let p = AVPlayer(playerItem: item)
            // The slide is drawn where it's shown (an external display included), not sent
            // over AirPlay as a video of its own.
            p.allowsExternalPlayback = false
            p.isMuted = model.muted
            p.actionAtItemEnd = .pause
            player = p
            p.play()
            async let ends: Void = watchEnd(item, p)
            // Up once it starts playing (or failed).
            for await status in item.publisher(for: \.status).values {
                if status == .readyToPlay { model.slideReady(asset.id); break }
                if status == .failed { model.slideReady(asset.id, failed: true); break }
            }
            await ends
        }
        .task(id: asset.id) {
            if thumb == nil { thumb = await ImageLoader.shared.load(model.client.thumbURL(asset)) }
        }
        .onChange(of: model.muted) { player?.isMuted = model.muted }
        .onDisappear { player?.pause() }
    }

    private func watchEnd(_ item: AVPlayerItem, _ p: AVPlayer) async {
        for await _ in NotificationCenter.default.notifications(named: AVPlayerItem.didPlayToEndTimeNotification, object: item) {
            if model.videoEnded(asset.id) {
                await p.seek(to: .zero)
                p.play()
            } else {
                break
            }
        }
    }
}

/// An `AVPlayerLayer` filling its frame, aspect-fit, without any controls.
struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerLayerUIView {
        let v = PlayerLayerUIView()
        v.playerLayer.player = player
        v.playerLayer.videoGravity = .resizeAspect
        v.backgroundColor = .clear
        return v
    }

    func updateUIView(_ v: PlayerLayerUIView, context: Context) {
        if v.playerLayer.player !== player { v.playerLayer.player = player }
    }
}

final class PlayerLayerUIView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
