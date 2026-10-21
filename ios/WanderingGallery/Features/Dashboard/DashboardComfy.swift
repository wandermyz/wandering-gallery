import SwiftUI

/// ComfyUI's running, queued and recent jobs.
struct ComfyCard: View {
    let comfy: Dashboard.ComfyState
    let cancelling: Set<String>
    let onCancel: (DashJob) -> Void
    let cancellingAll: Bool
    let onCancelAll: () -> Void
    let onOpen: (DashJob, OutputAsset) -> Void

    var body: some View {
        DashCard(title: "ComfyUI") {
            if comfy.online {
                DashPill(text: comfy.running.isEmpty ? "Idle" : "Running", style: comfy.running.isEmpty ? .ok : .running)
                let open = comfy.running.count + comfy.pending.count
                if open > 1 {
                    Button(cancellingAll ? "Cancelling…" : "Cancel all \(open)", role: .destructive, action: onCancelAll)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(cancellingAll)
                        .fixedSize()
                        .accessibilityIdentifier("jobs-cancel-all")
                }
            } else {
                DashPill(text: "Offline", style: .error)
            }
        } content: {
            if !comfy.online {
                DashErrorLine(text: comfy.error ?? "ComfyUI is not answering.")
            } else {
                // Elapsed times and ages tick between refreshes.
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let now = ctx.date.timeIntervalSince1970 * 1000
                    VStack(alignment: .leading, spacing: 0) {
                        VStack(spacing: 8) {
                            ForEach(comfy.running) { job in
                                RunningJobView(job: job, now: now) { cancelButton(job) }
                            }
                        }
                        if comfy.running.isEmpty { none("Nothing running.") }

                        subhead("Queued", count: comfy.pending.count)
                        if comfy.pending.isEmpty {
                            none("The queue is empty.")
                        } else {
                            ForEach(Array(comfy.pending.enumerated()), id: \.element.id) { i, job in
                                if i > 0 { Divider() }
                                HStack(spacing: 10) {
                                    Text("\(i + 1)")
                                        .font(.footnote.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                        .frame(width: 22)
                                    JobNameView(job: job)
                                    if let c = job.createdAtMs {
                                        Text("\(DashText.ago(now - c)) ago")
                                            .font(.caption.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                            .fixedSize()
                                    }
                                    cancelButton(job)
                                }
                                .frame(minHeight: 44)
                                .padding(.vertical, 4)
                                .accessibilityElement(children: .contain)
                                .accessibilityIdentifier("dash-pending-job")
                            }
                        }

                        subhead("Recent")
                        if comfy.recent.isEmpty {
                            none("No finished jobs since ComfyUI started.")
                        } else {
                            ForEach(Array(comfy.recent.enumerated()), id: \.element.id) { i, job in
                                if i > 0 { Divider() }
                                RecentJobView(job: job, now: now, onOpen: onOpen)
                            }
                        }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dash-comfy")
    }

    private func cancelButton(_ job: DashJob) -> some View {
        let busy = cancelling.contains(job.id)
        return Button(busy ? "Cancelling…" : "Cancel") { onCancel(job) }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(busy)
            .fixedSize()
            .accessibilityLabel("Cancel \(DashText.jobName(job))")
            .accessibilityIdentifier("job-cancel")
    }

    private func subhead(_ text: String, count: Int? = nil) -> some View {
        HStack(spacing: 6) {
            Text(text.uppercased()).fontWeight(.semibold)
            if let count { Text("\(count)").fontWeight(.regular) }
        }
        .font(.caption)
        .tracking(0.5)
        .foregroundStyle(.secondary)
        .padding(.top, 16)
        .padding(.bottom, 6)
        .accessibilityAddTraits(.isHeader)
    }

    private func none(_ text: String) -> some View {
        Text(text).font(.subheadline).foregroundStyle(.secondary)
    }
}

/// The job's title with its model and who queued it.
private struct JobNameView: View {
    let job: DashJob

    var body: some View {
        let by = job.flow != nil ? "gallery" : job.clientId.map(DashText.clientLabel)
        let meta = [job.model, by].compactMap { $0 }.filter { !$0.isEmpty }
        VStack(alignment: .leading, spacing: 1) {
            Text(DashText.jobName(job)).font(.subheadline).lineLimit(1).truncationMode(.middle)
            if !meta.isEmpty {
                Text(meta.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct RunningJobView<Cancel: View>: View {
    let job: DashJob
    let now: Double
    @ViewBuilder var cancel: Cancel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                JobNameView(job: job)
                if let s = job.startedAtMs {
                    Text(Format.elapsed(from: s, to: now))
                        .font(.title3.weight(.semibold).monospacedDigit())
                        .accessibilityLabel("Running for \(Format.elapsed(from: s, to: now))")
                }
                cancel
            }
            if let p = job.progress {
                ProgressView(value: min(max(p, 0), 1))
                    .tint(Theme.accent)
                    .accessibilityLabel("Sampler progress")
                Text("\(Int((p * 100).rounded()))% of the sampler steps")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                BusyMeter()
                Text("ComfyUI only reports step progress to the app that queued a job.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dash-running-job")
    }
}

/// An indeterminate bar (the web's `.meter-busy`).
private struct BusyMeter: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase = false

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.accent.opacity(0.18))
                if reduceMotion {
                    Capsule().fill(Theme.accent.opacity(0.5))
                } else {
                    Capsule().fill(Theme.accent)
                        .frame(width: geo.size.width * 0.3)
                        .offset(x: phase ? geo.size.width * 0.7 : 0)
                }
            }
        }
        .frame(height: 6)
        .clipShape(Capsule())
        .accessibilityHidden(true)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) { phase = true }
        }
    }
}

private struct RecentJobView: View {
    @Environment(AppModel.self) private var model
    let job: DashJob
    let now: Double
    let onOpen: (DashJob, OutputAsset) -> Void

    var body: some View {
        HStack(spacing: 10) {
            thumb
            VStack(alignment: .leading, spacing: 1) {
                Text(job.output?.filename ?? (job.status == "completed" ? "No output" : DashText.status(job.status)))
                    .font(.subheadline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let e = job.error {
                    Text(e).font(.caption).foregroundStyle(Theme.favorite).lineLimit(2)
                } else {
                    Text(DashText.status(job.status) + took).font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let e = job.endedAtMs {
                Text("\(DashText.ago(now - e)) ago")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .frame(minHeight: 44)
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dash-recent-job")
    }

    private var took: String {
        guard let s = job.startedAtMs, let e = job.endedAtMs else { return "" }
        return " · " + Format.elapsed(from: s, to: e)
    }

    @ViewBuilder
    private var thumb: some View {
        let shape = RoundedRectangle(cornerRadius: 8)
        if let a = job.output?.asset {
            Button { onOpen(job, a) } label: {
                RemoteImage(url: model.client.thumbURL(a))
                    .frame(width: 44, height: 44)
                    .clipShape(shape)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(job.output?.filename ?? "Output")
            .accessibilityIdentifier("job-thumb")
        } else {
            Image(systemName: job.status == "completed" ? "photo" : "exclamationmark.triangle")
                .foregroundStyle(job.status == "failed" ? Theme.favorite : .secondary)
                .frame(width: 44, height: 44)
                .background(Theme.surface2, in: shape)
        }
    }
}
