import SwiftUI
import UIKit

/// Puts a running slideshow on an external display (AirPlay, HDMI / USB-C) when one is
/// connected: the slideshow fills that screen and this device shows the controls. With no
/// slideshow running the external display mirrors the device, as usual.
///
/// On iPad with Stage Manager the external display is a regular window of the app instead;
/// there the slideshow runs in whichever window it was started from.
@MainActor @Observable
final class SlideshowPresenter {
    static let shared = SlideshowPresenter()

    /// The slideshow the device is running (one at a time).
    private(set) var active: SlideshowModel?
    /// The external display's scene, while one is connected.
    private(set) var externalScene: UIWindowScene?
    private var window: UIWindow?

    /// The slideshow is showing on an external display right now.
    var onExternalDisplay: Bool { window != nil }

    func start(_ model: SlideshowModel) {
        active = model
        // Nobody touches the device during a slideshow: keep it awake.
        UIApplication.shared.isIdleTimerDisabled = true
        update()
    }

    func stop(_ model: SlideshowModel) {
        guard active === model else { return }
        active = nil
        UIApplication.shared.isIdleTimerDisabled = false
        update()
    }

    func connect(_ scene: UIWindowScene) {
        externalScene = scene
        update()
    }

    func disconnect(_ scene: UIScene) {
        guard externalScene === scene else { return }
        window?.isHidden = true
        window = nil
        externalScene = nil
    }

    private func update() {
        guard let scene = externalScene, let model = active else {
            // No window of ours: the system mirrors the device's screen again.
            window?.isHidden = true
            window = nil
            return
        }
        if let w = window, (w.rootViewController as? ExternalSlideshowController)?.model === model { return }
        window?.isHidden = true
        let w = UIWindow(windowScene: scene)
        w.rootViewController = ExternalSlideshowController(model: model)
        w.backgroundColor = .black
        w.isHidden = false
        window = w
    }
}

/// The external display's slideshow: just the slides, edge to edge (a TV's overscan is
/// handled by the system), no controls.
final class ExternalSlideshowController: UIHostingController<ExternalSlideshowView> {
    let model: SlideshowModel

    init(model: SlideshowModel) {
        self.model = model
        super.init(rootView: ExternalSlideshowView(model: model))
        view.backgroundColor = .black
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }
}

struct ExternalSlideshowView: View {
    let model: SlideshowModel

    var body: some View {
        SlideshowStage(model: model)
            .ignoresSafeArea()
            .preferredColorScheme(.dark)
            .accessibilityIdentifier("slideshow-external")
    }
}

/// Scene delegate for an external display that mirrors the device unless we put a window on it
/// (`UIWindowScene.Session.Role.windowExternalDisplayNonInteractive`).
final class ExternalDisplaySceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        SlideshowPresenter.shared.connect(scene)
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        SlideshowPresenter.shared.disconnect(scene)
    }
}

/// Hands external displays to `ExternalDisplaySceneDelegate`; every other scene stays SwiftUI's.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        if session.role == .windowExternalDisplayNonInteractive {
            config.delegateClass = ExternalDisplaySceneDelegate.self
        }
        return config
    }
}
