import SwiftUI

/// Image + prompt → video. The image comes from the picker, the gallery viewer's
/// "Use in video flow", or a path pasted from the viewer's "Copy path".
struct VideoFlowView<Banners: View>: View {
    @Environment(AppModel.self) private var model
    @Bindable var state: VideoFlowState
    let banners: Banners
    @State private var choosing = false
    @State private var viewing: OutputItem?

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                Section {
                    banners
                    HStack {
                        TextField("Absolute path, e.g. from Copy path", text: $state.path)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .submitLabel(.done)
                            .onSubmit { Task { await state.pick(state.path) } }
                            .accessibilityIdentifier("video-path")
                        Button("Paste", systemImage: "doc.on.clipboard") {
                            if let s = UIPasteboard.general.string { Task { await state.pick(s) } }
                            else { state.pathError = "The clipboard has no text." }
                        }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("video-paste")
                    }
                    Button("Choose from gallery", systemImage: "photo.on.rectangle") { choosing = true }
                        .accessibilityIdentifier("video-choose")
                    if let e = state.pathError {
                        Text(e).font(.callout).foregroundStyle(.red).accessibilityIdentifier("video-path-error")
                    }
                    preview
                } header: {
                    Text("Input image · first frame")
                }
                .id("top")

                Section {
                    TextField("What happens in the video, e.g.\n[0s-2s] The cat looks up and blinks slowly.\n[2s-5s] It says \"Hello!\" in a cute voice.\nAudio: soft room ambience, light piano.",
                              text: $state.prompt, axis: .vertical)
                        .lineLimit(5...14)
                        .accessibilityIdentifier("video-prompt")
                    Picker("Length", selection: $state.seconds) {
                        ForEach(state.lengths, id: \.self) { Text("\($0) s").tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("video-seconds")
                } header: {
                    Text("Prompt · shots, motion, dialogue and sound")
                }

                Section {
                    CountStepper(label: "Videos", value: $state.batch, range: 1...VideoFlowState.maxBatch, id: "generate-batch")
                    Button {
                        dismissKeyboard()
                        Task { await state.start() }
                    } label: {
                        HStack {
                            if state.starting { ProgressView() } else { Image(systemName: "play.fill") }
                            Text(state.batch > 1 ? "Generate \(state.batch) videos" : "Generate video")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!state.canRun)
                    .accessibilityIdentifier("generate-start")
                }

                RunsSections(runs: state.runs, onReuse: { run in
                    state.reuse(run)
                    withAnimation { proxy.scrollTo("top", anchor: .top) }
                }, onOpen: { viewing = $0 })
            }
            .scrollDismissesKeyboard(.interactively)
            // Show a new run's progress.
            .onChange(of: state.runs.runs.first?.id) { _, id in
                if let id { withAnimation { proxy.scrollTo(id, anchor: .top) } }
            }
        }
        .toast(state.runs.toaster)
        .fullScreenCover(item: $viewing) { AssetByIDViewer(id: $0.asset.id) }
        .sheet(isPresented: $choosing) {
            ImagePickerSheet { state.use($0) }
        }
    }

    @ViewBuilder private var preview: some View {
        if state.loading {
            HStack { Spacer(); ProgressView(); Spacer() }.frame(height: 120)
        } else if let a = state.image {
            VStack(alignment: .leading, spacing: 6) {
                Color.clear
                    .aspectRatio(a.aspect ?? 1, contentMode: .fit)
                    .frame(maxHeight: 320)
                    .overlay { RemoteImage(url: model.client.thumbURL(a), contentMode: .fit) }
                    .frame(maxWidth: .infinity)
                Text(a.name + (a.width.flatMap { w in a.height.map { " · \(w)×\($0)" } } ?? ""))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("video-preview")
        }
    }
}

/// Recent gallery images to animate.
struct ImagePickerSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onPick: (Asset) -> Void
    @State private var items: [Asset] = []
    @State private var next: String?
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                if let error {
                    ErrorBanner(message: error) { Task { await load(reset: true) } }.padding()
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 2)], spacing: 2) {
                    ForEach(items) { a in
                        Button {
                            onPick(a)
                            dismiss()
                        } label: {
                            Color.clear
                                .aspectRatio(1, contentMode: .fit)
                                .overlay { RemoteImage(url: model.client.thumbURL(a)) }
                                .clipped()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(a.name)
                        .accessibilityIdentifier("picker-image")
                        .onAppear {
                            if a.id == items.last?.id { Task { await load(reset: false) } }
                        }
                    }
                }
                if loading { ProgressView().padding() }
            }
            .navigationTitle("Choose an image")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task { await load(reset: true) }
        }
    }

    private func load(reset: Bool) async {
        guard !loading, reset || next != nil else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await model.client.assets(AssetQuery(kind: .image), cursor: reset ? nil : next, limit: 90)
            items = reset ? page.items : items + page.items
            next = page.next
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
    }
}
