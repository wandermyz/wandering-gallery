import SwiftUI

struct SettingsView: View {
    @Environment(ServerStore.self) private var servers
    @Environment(AppModel.self) private var model
    @State private var editing: Server?
    @State private var adding = false
    @State private var cacheCleared = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(servers.servers) { s in
                        ServerRow(server: s, current: s.id == servers.current?.id)
                            .contentShape(Rectangle())
                            .onTapGesture { servers.select(s) }
                            .swipeActions {
                                Button("Delete", role: .destructive) { servers.remove(s) }
                                Button("Edit") { editing = s }.tint(.blue)
                            }
                            .contextMenu {
                                Button("Edit", systemImage: "pencil") { editing = s }
                                Button("Delete", systemImage: "trash", role: .destructive) { servers.remove(s) }
                            }
                    }
                    Button("Add server", systemImage: "plus") { adding = true }
                } header: {
                    Text("Backend")
                } footer: {
                    Text("Tap a server to switch to it. Swipe for edit and delete.")
                }

                Section("Connection") {
                    LabeledContent("Server", value: model.client.baseURL.absoluteString)
                    if let e = model.connectionError {
                        Text(e).foregroundStyle(.orange).font(.callout)
                    } else if let s = model.status {
                        LabeledContent("Libraries", value: "\(model.libraries.count)")
                        LabeledContent("Indexing", value: s.scanning ? "Scanning…" : s.pending > 0 ? "\(s.pending) pending" : "Idle")
                        LabeledContent("Trash", value: "\(s.trash) item\(s.trash == 1 ? "" : "s"), kept \(s.trashRetentionDays) days")
                    }
                    if model.hiddenEnabled {
                        LabeledContent("Hidden items", value: model.unlocked ? "Unlocked" : "Locked")
                    }
                    Button("Reconnect", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                }

                Section("Cache") {
                    Button(cacheCleared ? "Image cache cleared" : "Clear image cache", systemImage: "trash") {
                        URLCache.shared.removeAllCachedResponses()
                        ImageLoader.shared.clearMemory()
                        cacheCleared = true
                    }
                    .disabled(cacheCleared)
                }

                Section {
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")
                }
            }
            .navigationTitle("Settings")
            .sheet(item: $editing) { s in NavigationStack { ServerEditor(server: s) } }
            .sheet(isPresented: $adding) { NavigationStack { ServerEditor(server: nil) } }
        }
    }
}

private struct ServerRow: View {
    let server: Server
    let current: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(server.name)
                Text(server.url).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if current { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
    }
}

/// Adds or edits a backend, with a connection test before saving.
struct ServerEditor: View {
    @Environment(ServerStore.self) private var servers
    @Environment(\.dismiss) private var dismiss
    let server: Server?
    var firstRun = false

    @State private var name = ""
    @State private var url = ""
    @State private var testing = false
    @State private var result: (ok: Bool, message: String)?

    var body: some View {
        Form {
            if firstRun {
                Section {
                    Text("Connect to your Wandering Gallery server, e.g. its Tailscale Serve address `https://my-pc.my-tailnet.ts.net:23334`. Its hostname must be in `server.allowedHosts`.")
                        .font(.callout)
                }
            }
            Section("Server") {
                TextField("Name", text: $name, prompt: Text("Home PC"))
                    .accessibilityIdentifier("server-name")
                TextField("URL", text: $url, prompt: Text("https://my-pc.tailnet.ts.net:23334"))
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("server-url")
            }
            Section {
                Button {
                    Task { await test() }
                } label: {
                    HStack {
                        Text("Test connection")
                        if testing { Spacer(); ProgressView() }
                    }
                }
                .disabled(candidate.baseURL == nil || testing)
                if let result {
                    Label(result.message, systemImage: result.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(result.ok ? .green : .red)
                        .font(.callout)
                }
            }
        }
        .navigationTitle(server == nil ? "Add server" : "Edit server")
        .toolbar {
            if !firstRun {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(firstRun ? "Connect" : "Save") {
                    servers.upsert(candidate)
                    if firstRun || server == nil { servers.select(candidate) }
                    dismiss()
                }
                .disabled(candidate.baseURL == nil)
                .accessibilityIdentifier("server-save")
            }
        }
        .onAppear {
            name = server?.name ?? ""
            url = server?.url ?? ""
        }
    }

    private var candidate: Server {
        var s = server ?? Server(name: "", url: "")
        s.url = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let n = name.trimmingCharacters(in: .whitespaces)
        s.name = n.isEmpty ? (s.baseURL?.host() ?? "Server") : n
        return s
    }

    private func test() async {
        guard let base = candidate.baseURL else { return }
        testing = true
        defer { testing = false }
        do {
            let libs = try await APIClient(baseURL: base).libraries()
            result = (true, "Connected: \(libs.count) librar\(libs.count == 1 ? "y" : "ies")")
        } catch {
            result = (false, error.localizedDescription)
        }
    }
}
