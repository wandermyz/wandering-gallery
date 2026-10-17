import SwiftUI
import UIKit

/// A pinch / double-tap zoomable image (UIScrollView), reporting whether it is zoomed and
/// single taps (which wait for a double tap to fail).
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage?
    @Binding var zoomed: Bool
    var onSingleTap: () -> Void = {}

    func makeUIView(context: Context) -> ZoomScrollView {
        let v = ZoomScrollView()
        v.onZoomChange = { z in
            if zoomed != z { zoomed = z }
        }
        v.onSingleTap = onSingleTap
        return v
    }

    func updateUIView(_ v: ZoomScrollView, context: Context) {
        v.onSingleTap = onSingleTap
        v.setImage(image)
        if !zoomed, v.zoomScale > v.minimumZoomScale { v.setZoomScale(v.minimumZoomScale, animated: true) }
    }
}

final class ZoomScrollView: UIScrollView, UIScrollViewDelegate {
    private let imageView = UIImageView()
    var onZoomChange: (Bool) -> Void = { _ in }
    var onSingleTap: () -> Void = {}
    private var lastBoundsSize = CGSize.zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        decelerationRate = .fast
        contentInsetAdjustmentBehavior = .never
        bouncesZoom = true
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        addSubview(imageView)

        let double = UITapGestureRecognizer(target: self, action: #selector(doubleTap(_:)))
        double.numberOfTapsRequired = 2
        addGestureRecognizer(double)
        let single = UITapGestureRecognizer(target: self, action: #selector(singleTap))
        single.require(toFail: double)
        addGestureRecognizer(single)
    }

    required init?(coder: NSCoder) { fatalError() }

    func setImage(_ image: UIImage?) {
        guard imageView.image !== image else { return }
        let keepZoom = imageView.image != nil && image != nil && imageView.image!.size.width / imageView.image!.size.height == image!.size.width / image!.size.height
        imageView.image = image
        if keepZoom {
            // Thumbnail → full image of the same shape: keep the frame, only sharper.
            return
        }
        layoutImage(reset: true)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != lastBoundsSize {
            lastBoundsSize = bounds.size
            layoutImage(reset: true)
        }
        center()
    }

    /// Fits the image to the bounds at zoom 1; max zoom shows the image at least at 1:1 pixels.
    private func layoutImage(reset: Bool) {
        guard let img = imageView.image, bounds.width > 0, bounds.height > 0 else { return }
        if reset { zoomScale = 1 }
        let fit = min(bounds.width / img.size.width, bounds.height / img.size.height)
        imageView.frame = CGRect(x: 0, y: 0, width: img.size.width * fit, height: img.size.height * fit)
        contentSize = imageView.frame.size
        minimumZoomScale = 1
        let pixels = img.size.width * img.scale
        maximumZoomScale = max(4, pixels / (imageView.frame.width * traitCollection.displayScale) * 2)
        center()
        onZoomChange(false)
    }

    private func center() {
        let w = max(0, (bounds.width - contentSize.width) / 2)
        let h = max(0, (bounds.height - contentSize.height) / 2)
        contentInset = UIEdgeInsets(top: h, left: w, bottom: h, right: w)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        center()
        onZoomChange(zoomScale > minimumZoomScale + 0.01)
    }

    @objc private func doubleTap(_ g: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale + 0.01 {
            setZoomScale(minimumZoomScale, animated: true)
        } else {
            let p = g.location(in: imageView)
            let scale = min(maximumZoomScale, 2.5)
            let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
            zoom(to: CGRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }

    @objc private func singleTap() { onSingleTap() }
}
