import Charts
import SwiftUI

// MARK: - GPU

struct GpuCard: View {
    let gpu: Dashboard.Gpu

    var body: some View {
        DashCard(title: "GPU") {
            if let s = gpu.now {
                Text(s.name.replacing(#/^NVIDIA /#, with: ""))
                    .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        } content: {
            VStack(alignment: .leading, spacing: 12) {
                if let e = gpu.error { DashErrorLine(text: e) }
                if let s = gpu.now {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], spacing: 8) {
                        StatTile(label: "Load", value: "\(Int(s.util))%")
                        StatTile(label: "VRAM", value: DashText.gib(s.memUsedMib), unit: "/ \(DashText.gib(s.memTotalMib)) GB")
                        if let t = s.tempC { StatTile(label: "Temp", value: "\(Int(t))°", unit: "C") }
                        if let p = s.powerW {
                            StatTile(label: "Power", value: "\(Int(p.rounded()))", unit: s.powerLimitW.map { "/ \(Int($0.rounded())) W" } ?? "W")
                        }
                    }
                    Sparkline(samples: gpu.history)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dash-gpu")
    }
}

private struct StatTile: View {
    let label: String
    let value: String
    var unit: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value).font(.title2.weight(.semibold).monospacedDigit())
                if let unit { Text(unit).font(.footnote).foregroundStyle(.secondary) }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

/// GPU load over the last minutes, with a touch readout.
private struct Sparkline: View {
    let samples: [GpuSample]
    @State private var selected: Date?

    var body: some View {
        if samples.count < 2 {
            Text("Load history appears after a few readings.").font(.caption).foregroundStyle(.secondary)
        } else {
            let first = samples[0].atMs, last = samples[samples.count - 1].atMs
            let span = max(1, last - first)
            let minutes = Int((span / 60_000).rounded())
            let h = selected.flatMap(nearest)
            VStack(alignment: .leading, spacing: 4) {
                Group {
                    if let h {
                        Text("**\(Int(h.util))%** load · \(date(h.atMs).formatted(date: .omitted, time: .standard))")
                    } else {
                        Text("Load, last \(minutes > 0 ? "\(minutes) min" : "\(Int((span / 1000).rounded())) s")")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)

                Chart {
                    ForEach(samples, id: \.atMs) { s in
                        AreaMark(x: .value("Time", date(s.atMs)), y: .value("Load", s.util))
                            .foregroundStyle(Theme.accent.opacity(0.14))
                            .interpolationMethod(.linear)
                        LineMark(x: .value("Time", date(s.atMs)), y: .value("Load", s.util))
                            .foregroundStyle(Theme.accent)
                            .lineStyle(StrokeStyle(lineWidth: 2, lineJoin: .round))
                    }
                    if let h {
                        RuleMark(x: .value("Time", date(h.atMs)))
                            .foregroundStyle(.secondary)
                            .lineStyle(StrokeStyle(lineWidth: 1))
                    }
                }
                .chartYScale(domain: 0...100)
                .chartXScale(domain: date(first)...date(last))
                .chartXAxis(.hidden)
                .chartYAxis {
                    AxisMarks(values: [50]) { _ in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [3, 4]))
                    }
                }
                .chartXSelection(value: $selected)
                .frame(height: 72)
                .accessibilityElement()
                .accessibilityLabel("GPU load over the last \(max(minutes, 1)) minutes, now \(Int(samples[samples.count - 1].util))%")
                .accessibilityIdentifier("dash-sparkline")
            }
        }
    }

    private func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    private func nearest(_ d: Date) -> GpuSample? {
        let at = d.timeIntervalSince1970 * 1000
        return samples.min { abs($0.atMs - at) < abs($1.atMs - at) }
    }
}

// MARK: - GPU workload

struct WorkloadCard: View {
    let workload: Dashboard.WorkloadState

    private static let modes: [String: (label: String, style: DashPillStyle, hint: String)] = [
        "comfy": ("ComfyUI", .running, "ComfyUI may load models; the LLM is unloaded."),
        "strata": ("Strata", .ok, "The local LLM is loaded; ComfyUI holds no models."),
        "conflict": ("Conflict", .error, "Both hold the GPU. The next switch sorts it out."),
        "none": ("Free", .plain, "Nothing holds the GPU; whichever side asks next loads."),
    ]

    var body: some View {
        let w = workload.status
        let mode = w.map { Self.modes[$0.mode] ?? ($0.mode, .plain, "") }
        DashCard(title: "GPU workload") {
            if let w, let mode {
                DashPill(text: mode.label, style: mode.style, icon: w.mode == "conflict" ? "exclamationmark.triangle.fill" : nil)
                    .accessibilityIdentifier("dash-workload-mode")
            }
        } content: {
            VStack(alignment: .leading, spacing: 10) {
                if let e = workload.error { DashErrorLine(text: e) }
                if let w {
                    if let hint = mode?.hint, !hint.isEmpty {
                        Text(hint).font(.caption).foregroundStyle(.secondary)
                    }
                    VramSplit(gpu: w.gpu)
                    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 6) {
                        row("Strata", Text(strataState(w)))
                        row("ComfyUI", Text(comfyState(w)))
                        if let ev = w.last_event {
                            row("Last", Text(eventText(ev)) + Text(eventTime(ev)).foregroundStyle(.secondary))
                        }
                    }
                    .font(.subheadline)
                    .padding(.top, 4)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("dash-workload")
    }

    private func row(_ label: String, _ value: Text) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            value.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func strataState(_ w: Workload) -> String {
        if !w.strata.service { return "Service stopped" }
        if !w.strata.reachable { return "Service up, not answering" }
        return w.strata.loaded ? "Model loaded" : "Model unloaded"
    }

    private func comfyState(_ w: Workload) -> String {
        if !w.comfy.service { return "Service stopped" }
        if !w.comfy.reachable { return "Service up, not answering" }
        return "\(w.comfy.holds_models ? "Models loaded" : "No models loaded") · \(w.comfy.running) running, \(w.comfy.pending) queued"
    }

    private func eventText(_ ev: JSONValue) -> String {
        let event = ev["event"]?.string ?? "?"
        switch event {
        case "switch":
            let failed = ev["ok"] == .bool(false)
            return "Switched to \(ev["to"]?.description ?? "?")\(failed ? " (failed)" : "")"
        case "strata-load":
            let allowed = ev["allowed"] == .bool(true)
            let reason = ev["reason"].flatMap { $0 == .null ? nil : $0.description }.map { ": \($0)" } ?? ""
            return "LLM load \(allowed ? "allowed" : "refused")\(reason)"
        default:
            return event
        }
    }

    private func eventTime(_ ev: JSONValue) -> String {
        guard let t = ev["time"]?.string, let d = Self.parseDate(t) else { return "" }
        return " · " + d.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    private static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s)
    }
}

/// Who holds the VRAM: one stacked bar, labelled below (identity is never color alone).
private struct VramSplit: View {
    let gpu: Workload.Gpu

    private static let strata = Color(red: 0x39 / 255, green: 0x87 / 255, blue: 0xe5 / 255)
    private static let comfy = Color(red: 0xd9 / 255, green: 0x59 / 255, blue: 0x26 / 255)
    private static let other = Color(red: 0x19 / 255, green: 0x9e / 255, blue: 0x70 / 255)

    var body: some View {
        if let total = gpu.total_mib, total > 0, gpu.error == nil {
            let parts: [(label: String, mib: Double, color: Color)] = [
                ("Strata", gpu.strata_mib, Self.strata),
                ("ComfyUI", gpu.comfy_mib, Self.comfy),
                ("Other", gpu.other_mib, Self.other),
            ]
            let free = gpu.free_mib ?? max(0, total - parts.reduce(0) { $0 + $1.mib })
            VStack(alignment: .leading, spacing: 8) {
                GeometryReader { geo in
                    let shown = parts.filter { $0.mib > 0 }
                    let gaps = CGFloat(max(0, shown.count - 1)) * 2
                    HStack(spacing: 2) {
                        ForEach(shown, id: \.label) { p in
                            Rectangle().fill(p.color)
                                .frame(width: max(3, (geo.size.width - gaps) * p.mib / total))
                        }
                        Spacer(minLength: 0)
                    }
                }
                .frame(height: 12)
                .background(Theme.surface2)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .accessibilityElement()
                .accessibilityLabel("VRAM: \(parts.map { "\($0.label) \(DashText.gib($0.mib)) GB" }.joined(separator: ", ")), free \(DashText.gib(free)) of \(DashText.gib(total)) GB")

                FlowLegend {
                    ForEach(parts, id: \.label) { p in legend(p.label, p.color, DashText.gib(p.mib)) }
                    HStack(spacing: 0) {
                        legend("Free", nil, DashText.gib(free))
                        Text(" / \(DashText.gib(total)) GB").foregroundStyle(.secondary)
                    }
                }
                .font(.footnote)
            }
        } else {
            DashErrorLine(text: gpu.error ?? "No VRAM reading")
        }
    }

    private func legend(_ label: String, _ color: Color?, _ value: String) -> some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 3)
                .fill(color ?? Theme.surface2)
                .overlay { if color == nil { RoundedRectangle(cornerRadius: 3).strokeBorder(.white.opacity(0.15)) } }
                .frame(width: 10, height: 10)
            (Text(label).foregroundStyle(.secondary) + Text(" ") + Text(value).fontWeight(.semibold))
        }
    }
}

/// Lays out its children left to right, wrapping onto new lines.
private struct FlowLegend: Layout {
    var spacing: CGFloat = 14
    var lineSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: rows.width, height: rows.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(subviews, width: bounds.width)
        for (i, p) in rows.points.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: .unspecified)
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> (points: [CGPoint], width: CGFloat, height: CGFloat) {
        var points: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxW: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width {
                x = 0
                y += rowH + lineSpacing
                rowH = 0
            }
            points.append(CGPoint(x: x, y: y))
            x += s.width + spacing
            rowH = max(rowH, s.height)
            maxW = max(maxW, x - spacing)
        }
        return (points, maxW, y + rowH)
    }
}
