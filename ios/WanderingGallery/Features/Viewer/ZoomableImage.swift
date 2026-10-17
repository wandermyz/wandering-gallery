import SwiftUI
import UIKit

/// A pinch / double-tap zoomable image (UIScrollView), reporting whether it is zoomed and
/// single taps (which wait for a double tap to fail). At zoom 1 the image fits inside
/// `fitInsets` (clear of the viewer's bars); zoomed in, it can use the whole view.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage?
    @Binding var zoomed: Bool
    var fitInsets = EdgeInsets()
    var onSingleTap: () -> Void = {}

    func makeUIView(context: Context) -> ZoomScrollView {
        let v = ZoomScrollView()
        v.onZoomChange = { z in
            if zoomed != z { zoomed = z }
        }
        v.onSingleTap = onSingleTap
        v.fitInsets = fitInsets
        return v
    }

    func updateUIView(_ v: ZoomScrollView, context: Context) {
        v.onSingleTap = onSingleTap
        v.fitInsets = fitInsets
        v.setImage(image)
        if !zoomed, v.zoomScale > v.minimumZoomScale { v.setZoomScale(v.minimumZoomScale, animated: true) }
    }
}

final class ZoomScrollView: UIScrollView, UIScrollViewDelegate {
    private let imageView = UIImageView()
    var onZoomChange: (Bool) -> Void = { _ in }
    var onSingleTap: () -> Void = {}
    var fitInsets = EdgeInsets() {
        didSet { if fitInsets != oldValue { layoutImage(reset: true) } }
    }
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
        imageView.accessibilityIdentifier = "viewer-image"
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

    /// The area the image fits in at zoom 1.
    private var fitArea: CGRect {
        bounds.inset(by: UIEdgeInsets(top: fitInsets.top, left: fitInsets.leading, bottom: fitInsets.bottom, right: fitInsets.trailing))
    }

    /// Fits the image to `fitArea` at zoom 1; max zoom shows the image at least at 1:1 pixels.
    private func layoutImage(reset: Bool) {
        guard let img = imageView.image, fitArea.width > 0, fitArea.height > 0 else { return }
        if reset { zoomScale = 1 }
        let fit = min(fitArea.width / img.size.width, fitArea.height / img.size.height)
        imageView.frame = CGRect(x: 0, y: 0, width: img.size.width * fit, height: img.size.height * fit)
        contentSize = imageView.frame.size
        minimumZoomScale = 1
        let pixels = img.size.width * img.scale
        maximumZoomScale = max(4, pixels / (imageView.frame.width * traitCollection.displayScale) * 2)
        center()
        onZoomChange(false)
    }

    /// Centers the image in `fitArea`, moving toward the view's edges as it grows past it
    /// (the image never leaves a gap at an edge it could fill).
    private func center() {
        let area = fitArea
        func lead(_ size: CGFloat, _ inset: CGFloat, _ areaLen: CGFloat, _ boundsLen: CGFloat) -> CGFloat {
            min(max(0, inset + (areaLen - size) / 2), max(0, boundsLen - size))
        }
        let top = lead(contentSize.height, fitInsets.top, area.height, bounds.height)
        let left = lead(contentSize.width, fitInsets.leading, area.width, bounds.width)
        contentInset = UIEdgeInsets(
            top: top, left: left,
            bottom: max(0, bounds.height - top - contentSize.height), right: max(0, bounds.width - left - contentSize.width))
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
