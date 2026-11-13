import SwiftUI

/// The slideshow on this device, full screen over the grid or the viewer it was started from.
/// With an external display connected the slides play there and this screen is the remote.
struct SlideshowScreen: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: SlideshowModel
    @State private var presenter = SlideshowPresenter.shared
    @State private var controls = true
    @State private var hideTask: Task<Void, Never>?
    /// Called with the slide that was showing when it ends.
    let onExit: (Int) -> Void

    init(list: AssetListModel, client: APIClient, startID: Int, onExit: @escaping (Int) -> Void) {
        _model = State(initialValue: SlideshowModel(list: list, client: client, startID: startID))
        self.onExit = onExit
    }

    private var remote: Bool { presenter.onExternalDisplay && presenter.active === model }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if model.current == nil {
                VStack(spacing: 12) {
                    Text("Nothing to show: the slideshow plays images and videos.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    Button("Close") { exit() }.buttonStyle(.bordered)
                }
                .padding(24)
            } else if remote {
                remoteView
            } else {
                SlideshowStage(model: model)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { controls ? hideControls() : poke() }
                    .gesture(swipe)
                if controls { overlay.transition(.opacity) }
            }
        }
        .statusBarHidden(!controls && !remote)
        .persistentSystemOverlays(controls || remote ? .automatic : .hidden)
        .animation(.easeInOut(duration: 0.25), value: controls)
        .preferredColorScheme(.dark)
        .onAppear {
            presenter.start(model)
            poke()
        }
        .onDisappear {
            model.stop()
            presenter.stop(model)
            hideTask?.cancel()
        }
        .onChange(of: model.playing) { poke() }
        .focusable()
        .focusEffectDisabled()
        .onKeyPress(keys: [.leftArrow, .rightArrow, .escape, .space]) { press in
            switch press.key {
            case .leftArrow: model.go(-1)
            case .rightArrow: model.go(1)
            case .space: model.togglePlay()
            default: exit()
            }
            return .handled
        }
    }

    private func exit() {
        onExit(model.current?.id ?? model.startID)
        dismiss()
    }

    // MARK: Controls (fade away while playing)

    private func poke() {
        controls = true
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled, model.playing { controls = false }
        }
    }

    private func hideControls() {
        hideTask?.cancel()
        controls = false
    }

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 30)
            .onEnded { v in
                let dx = v.translation.width, dy = v.translation.height
                if abs(dx) > 50, abs(dx) > abs(dy) * 1.5 {
                    model.go(dx < 0 ? 1 : -1)
                    poke()
                } else if dy > 120, abs(dy) > abs(dx) * 1.5 {
                    exit()
                }
            }
    }

    private var overlay: some View {
        VStack(spacing: 0) {
            topBar
                .padding(.bottom, 24)
                .background(LinearGradient(colors: [.black.opacity(0.7), .clear], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
            Spacer()
            transport
                .padding(.top, 28)
                .padding(.bottom, 8)
                .frame(maxWidth: .infinity)
                .background(LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        }
        .foregroundStyle(.white)
    }

    private var topBar: some View {
        HStack(spacing: 4) {
            Button { exit() } label: { Image(systemName: "xmark").frame(width: 40, height: 40) }
                .accessibilityLabel("Exit slideshow")
                .accessibilityIdentifier("slideshow-exit")
            if let a = model.current {
                VStack(alignment: .leading, spacing: 1) {
                    Text(a.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                        .accessibilityIdentifier("slideshow-title")
                    Text(a.date.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            Text(model.counter).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                .accessibilityIdentifier("slideshow-counter")
        }
        .padding(.horizontal, 8)
        .buttonStyle(.plain)
    }

    private var transport: some View {
        HStack(spacing: 14) {
            Button { model.go(-1); poke() } label: {
                Image(systemName: "backward.fill").frame(width: 44, height: 44)
            }
            .accessibilityLabel("Previous")
            .accessibilityIdentifier("slideshow-previous")
            Button { model.togglePlay() } label: {
                Image(systemName: model.playing ? "pause.fill" : "play.fill")
                    .font(.title2)
                    .frame(width: 56, height: 56)
                    .background(.white.opacity(0.14), in: Circle())
            }
            .accessibilityLabel(model.playing ? "Pause" : "Play")
            .accessibilityIdentifier("slideshow-play")
            Button { model.go(1); poke() } label: {
                Image(systemName: "forward.fill").frame(width: 44, height: 44)
            }
            .accessibilityLabel("Next")
            .accessibilityIdentifier("slideshow-next")
            Menu {
                Picker("Seconds per slide", selection: Binding(get: { model.interval }, set: { model.setInterval($0) })) {
                    ForEach(SlideshowModel.intervals, id: \.self) { Text("\($0) seconds").tag($0) }
                }
            } label: {
                Text("\(model.interval)s")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .frame(minWidth: 44, minHeight: 32)
                    .background(.white.opacity(0.14), in: Capsule())
            }
            .accessibilityLabel("Seconds per slide: \(model.interval)")
            .accessibilityIdentifier("slideshow-interval")
            if model.current?.kind == .video {
                Button { model.muted.toggle() } label: {
                    Image(systemName: model.muted ? "speaker.slash.fill" : "speaker.wave.2.fill").frame(width: 44, height: 44)
                }
                .accessibilityLabel(model.muted ? "Unmute" : "Mute")
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: Remote (the slides are on an external display)

    private var remoteView: some View {
        VStack(spacing: 0) {
            topBar
            Spacer()
            VStack(spacing: 14) {
                if let a = model.current {
                    RemoteImage(url: model.client.thumbURL(a), contentMode: .fit)
                        .frame(maxWidth: 320, maxHeight: 320)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .id(a.id)
                        .transition(.opacity)
                }
                Label("Playing on the external display", systemImage: "tv")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("slideshow-on-external")
            }
            .animation(.easeInOut(duration: 0.3), value: model.current?.id)
            .padding(.horizontal, 24)
            Spacer()
            transport.padding(.bottom, 12)
        }
        .foregroundStyle(.white)
        .contentShape(Rectangle())
        .gesture(swipe)
    }
}
