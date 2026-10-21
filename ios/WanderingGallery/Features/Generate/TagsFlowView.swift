import SwiftUI

/// Description → N tag variations → images.
struct TagsFlowView<Banners: View>: View {
    @Bindable var state: TagsFlowState
    let banners: Banners
    @State private var confirmRegenerate = false
    @State private var viewing: OutputItem?

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                Section {
                    banners
                    TextField("Describe the image (中文 / English)", text: $state.prompt, axis: .vertical)
                        .lineLimit(3...10)
                        .accessibilityIdentifier("generate-description")
                    CountStepper(label: "Tag variations", value: Binding(get: { state.variations.count }, set: { state.setCount($0) }),
                                 range: 1...TagsFlowState.maxVariations, id: "generate-variation-count")
                        .disabled(state.busyTags)
                    Button {
                        if !state.fillEmpty() { confirmRegenerate = true }
                    } label: {
                        HStack {
                            Image(systemName: "sparkles")
                            Text(state.tagLabel)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).foregroundStyle(Theme.onAccent)
                    .disabled(!state.canTag || state.busyTags)
                    .accessibilityIdentifier("generate-tags-button")
                } header: {
                    Text("Description · 中文 / English")
                }
                .id("top")

                ForEach(state.variations.indices, id: \.self) { i in
                    variation(i)
                }

                Section {
                    Button("Add variation", systemImage: "plus") { state.setCount(state.variations.count + 1) }
                        .disabled(state.busyTags || state.variations.count >= TagsFlowState.maxVariations)
                        .accessibilityIdentifier("generate-add-variation")
                    CountStepper(label: "Images per variation", value: $state.batch, range: 1...TagsFlowState.maxBatch, id: "generate-batch")
                    Button {
                        dismissKeyboard()
                        Task { await state.start() }
                    } label: {
                        HStack {
                            if state.starting { ProgressView() } else { Image(systemName: "play.fill") }
                            Text("Generate \(state.total) image\(state.total == 1 ? "" : "s")")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).foregroundStyle(Theme.onAccent)
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
        .confirmationDialog("Regenerate all tags?", isPresented: $confirmRegenerate, titleVisibility: .visible) {
            Button("Regenerate", role: .destructive) { state.regenerateAll() }
                .accessibilityIdentifier("generate-regenerate-confirm")
        } message: {
            Text("Every variation, including your edits, is replaced.")
        }
    }

    private func variation(_ i: Int) -> some View {
        let text = Binding(get: { state.variations.indices.contains(i) ? state.variations[i] : "" },
                           set: { if state.variations.indices.contains(i) { state.variations[i] = $0 } })
        return Section {
            if state.generating.contains(i) {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Generating tags…").foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("generate-variation-busy-\(i)")
            } else {
                TextField("Danbooru tags, comma separated: generate them or type them here", text: text, axis: .vertical)
                    .lineLimit(2...10)
                    .font(.callout)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("generate-variation-\(i)")
            }
        } header: {
            HStack {
                Text("Variation \(i + 1)") + Text(i == 0 ? " · as described" : "").foregroundStyle(.secondary)
                Spacer()
                Button("Regenerate variation \(i + 1)", systemImage: "arrow.clockwise") { state.generateTags(i) }
                    .disabled(!state.canTag || state.generating.contains(i))
                    .accessibilityIdentifier("generate-variation-regenerate-\(i)")
                Button("Remove variation \(i + 1)", systemImage: "xmark") { withAnimation { state.remove(i) } }
                    .disabled(state.busyTags || (state.variations.count == 1 && state.blank(state.variations[i])))
                    .accessibilityIdentifier("generate-variation-remove-\(i)")
            }
            .labelStyle(.iconOnly)
            .imageScale(.large)
            .buttonStyle(.borderless)
        }
    }
}
