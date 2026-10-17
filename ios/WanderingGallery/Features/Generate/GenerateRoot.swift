import SwiftUI

/// The Generate tab: the flows in a sidebar (a list on iPhone), one form per flow.
struct GenerateRoot: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var store: GenerateStore?
    @State private var selection: String?
    @State private var column = NavigationSplitViewColumn.sidebar

    var body: some View {
        Group {
            if let store {
                content(store)
            } else {
                ProgressView()
            }
        }
        .onAppear {
            if store == nil { store = GenerateStore(client: model.client) }
        }
    }

    private func content(_ store: GenerateStore) -> some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            FlowList(store: store, selection: $selection)
        } detail: {
            NavigationStack {
                if let id = selection, let flow = store.flows?.first(where: { $0.id == id }) {
                    FlowPage(store: store, flow: flow)
                        .id(flow.id)
                } else {
                    ContentUnavailableView("Choose a workflow", systemImage: "sparkles")
                }
            }
        }
        .task { await store.load() }
        // Re-check while ComfyUI is down, so the banner clears once it is started.
        .task(id: store.comfy?.online) {
            guard store.comfy?.online == false else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                if Task.isCancelled { break }
                await store.loadStatus()
            }
        }
        .onChange(of: store.flows) {
            // The web opens the first flow; on iPhone the list comes first.
            if selection == nil, sizeClass == .regular { selection = store.flows?.first?.id }
            takeVideoInput(store)
        }
        .onChange(of: model.videoInput, initial: true) { takeVideoInput(store) }
    }

    /// An image handed over from the gallery viewer: preselect it in the video flow.
    private func takeVideoInput(_ store: GenerateStore) {
        guard let asset = model.videoInput,
              let flow = store.flows?.first(where: { $0.kind == "video" }),
              let state = store.video[flow.id] else { return }
        model.videoInput = nil
        state.use(asset)
        selection = flow.id
        column = .detail
    }
}

/// The flows, with their setup state and ComfyUI's.
private struct FlowList: View {
    let store: GenerateStore
    @Binding var selection: String?

    var body: some View {
        List(selection: $selection) {
            if let error = store.error {
                ErrorBanner(message: error) { Task { await store.load() } }
                    .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
            }
            Section {
                ForEach(store.flows ?? []) { f in
                    NavigationLink(value: f.id) {
                        HStack {
                            Label(f.title, systemImage: f.kind == "video" ? "play.rectangle" : "sparkles")
                            Spacer()
                            if !f.ready {
                                Text("setup")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.orange)
                            }
                        }
                    }
                    .accessibilityIdentifier("generate-flow-\(f.id)")
                }
            } footer: {
                if let s = store.comfySummary {
                    Label(s, systemImage: store.comfy?.online == true ? "checkmark.circle" : "exclamationmark.triangle")
                        .accessibilityIdentifier("generate-comfy-status")
                }
            }
        }
        .overlay {
            if store.flows == nil, store.error == nil { ProgressView() }
        }
        .refreshable { await store.load() }
        .navigationTitle("Generate")
    }
}

/// One flow: setup and ComfyUI banners above its form.
private struct FlowPage: View {
    let store: GenerateStore
    let flow: FlowInfo

    var body: some View {
        Group {
            if flow.kind == "video", let s = store.video[flow.id] {
                VideoFlowView(state: s, banners: banners)
            } else if let s = store.tags[flow.id] {
                TagsFlowView(state: s, banners: banners)
            }
        }
        .navigationTitle(flow.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder private var banners: some View {
        if let c = store.comfy, !c.online {
            banner(c.error ?? "ComfyUI is not reachable at \(c.url).", button: "Check again") { await store.loadStatus() }
                .accessibilityIdentifier("generate-comfy-offline")
        }
        if !flow.ready {
            banner(flow.problem ?? "This workflow is not set up.", button: "Check again") { await store.load() }
                .accessibilityIdentifier("generate-flow-problem")
        }
    }

    private func banner(_ text: String, button: String, action: @escaping () async -> Void) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            Text(text).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            Button(button) { Task { await action() } }.buttonStyle(.bordered).controlSize(.small)
        }
        .listRowBackground(Color.red.opacity(0.12))
    }
}
