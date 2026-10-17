import SwiftUI

/// Shows hidden items on this device for a while (passphrase), with a countdown and an
/// early lock.
struct UnlockSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var passphrase = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                if let until = model.unlockedUntil, until > .now {
                    Section {
                        Text("Hidden items are shown on this device. They lock again in").foregroundStyle(.secondary)
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            let left = max(0, Int(until.timeIntervalSince(ctx.date).rounded(.up)))
                            Text(String(format: "%d:%02d", left / 60, left % 60))
                                .font(.system(size: 44, weight: .semibold, design: .rounded)).monospacedDigit()
                                .frame(maxWidth: .infinity)
                                .onChange(of: left) { if left == 0 { model.unlockExpired() } }
                        }
                    }
                    Section {
                        Button("Lock now", systemImage: "lock") {
                            Task {
                                busy = true
                                await model.lock()
                                busy = false
                                dismiss()
                            }
                        }
                        .disabled(busy)
                        .accessibilityIdentifier("lock-now")
                    }
                } else {
                    Section {
                        Text("Enter the passphrase to show hidden items on this device for \(model.session?.unlockMinutes ?? 15) minutes.")
                            .foregroundStyle(.secondary)
                        SecureField("Passphrase", text: $passphrase)
                            .textContentType(.password)
                            .focused($focused)
                            .submitLabel(.go)
                            .onSubmit { Task { await unlock() } }
                            .accessibilityIdentifier("passphrase")
                        if let error { Text(error).foregroundStyle(.red).font(.callout) }
                    }
                    Section {
                        Button {
                            Task { await unlock() }
                        } label: {
                            HStack {
                                Text("Unlock")
                                if busy { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(busy || passphrase.isEmpty)
                        .accessibilityIdentifier("unlock")
                    }
                }
            }
            .navigationTitle("Hidden items")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { if !model.unlocked { focused = true } }
        }
        .presentationDetents([.medium])
    }

    private func unlock() async {
        guard !passphrase.isEmpty, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await model.unlock(passphrase)
            passphrase = ""
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
