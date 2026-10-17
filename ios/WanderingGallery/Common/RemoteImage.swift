import ImageIO
import SwiftUI
import UIKit

/// Loads and caches images from the server. Thumbnail URLs carry the asset's version, so a
/// cached entry never goes stale; the disk side is URLCache (the server sends long
/// `Cache-Control` lifetimes for visible assets, `no-store` for hidden ones).
final class ImageLoader {
    static let shared = ImageLoader()

    private let memory = NSCache<NSURL, UIImage>()
    private var inflight: [URL: Task<UIImage?, Never>] = [:]

    init() {
        memory.totalCostLimit = 200 * 1024 * 1024
    }

    func cached(_ url: URL) -> UIImage? { memory.object(forKey: url as NSURL) }

    /// `maxPixel` downsamples while decoding (full-size images in the viewer).
    func load(_ url: URL, maxPixel: CGFloat? = nil) async -> UIImage? {
        if let img = cached(url) { return img }
        if let t = inflight[url] { return await t.value }
        let t = Task<UIImage?, Never> {
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return await Task.detached(priority: .userInitiated) { Self.decode(data, maxPixel: maxPixel) }.value
        }
        inflight[url] = t
        let img = await t.value
        inflight[url] = nil
        if let img {
            memory.setObject(img, forKey: url as NSURL, cost: Int(img.size.width * img.size.height * img.scale * img.scale * 4))
        }
        return img
    }

    func clearMemory() { memory.removeAllObjects() }

    nonisolated static func decode(_ data: Data, maxPixel: CGFloat?) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        // Animated GIF/WebP: let UIKit build the animation.
        if CGImageSourceGetCount(src) > 1 { return animated(src) ?? UIImage(data: data) }
        var opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        if let maxPixel { opts[kCGImageSourceThumbnailMaxPixelSize] = maxPixel } else {
            let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
            let w = props?[kCGImagePropertyPixelWidth] as? CGFloat ?? 4096
            let h = props?[kCGImagePropertyPixelHeight] as? CGFloat ?? 4096
            opts[kCGImageSourceThumbnailMaxPixelSize] = max(w, h)
        }
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return UIImage(data: data) }
        return UIImage(cgImage: cg)
    }

    nonisolated private static func animated(_ src: CGImageSource) -> UIImage? {
        let n = min(CGImageSourceGetCount(src), 300)
        var frames: [UIImage] = []
        var total = 0.0
        for i in 0..<n {
            guard let cg = CGImageSourceCreateImageAtIndex(src, i, nil) else { continue }
            let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any]
            let gif = props?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let webp = props?[kCGImagePropertyWebPDictionary] as? [CFString: Any]
            let delay = (gif?[kCGImagePropertyGIFUnclampedDelayTime] ?? webp?[kCGImagePropertyWebPUnclampedDelayTime]) as? Double ?? 0.1
            total += max(delay, 0.02)
            frames.append(UIImage(cgImage: cg))
        }
        return frames.isEmpty ? nil : UIImage.animatedImage(with: frames, duration: total)
    }
}

/// An image from the server, filling its frame (cropped), with a placeholder until loaded.
struct RemoteImage: View {
    let url: URL
    var contentMode: ContentMode = .fill
    var maxPixel: CGFloat? = nil

    @State private var loaded: (url: URL, image: UIImage)?
    @State private var failed = false

    var body: some View {
        ZStack {
            if let image = ImageLoader.shared.cached(url) ?? (loaded?.url == url ? loaded?.image : nil) {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                Rectangle().fill(Color.white.opacity(0.06))
                if failed {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.secondary)
                }
            }
        }
        .task(id: url) {
            if ImageLoader.shared.cached(url) != nil { return }
            failed = false
            if let img = await ImageLoader.shared.load(url, maxPixel: maxPixel) {
                loaded = (url, img)
            } else {
                failed = !Task.isCancelled
            }
        }
    }
}
