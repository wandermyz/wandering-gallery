import SwiftUI

enum Theme {
    // The Miku palette, the same as the web's styles.css.
    static let accent = hex(0x39d8c7)
    static let accentText = hex(0x8eede2)
    /// Text on an accent-filled control (white is unreadable on mint).
    static let onAccent = hex(0x032421)
    static let star = hex(0xf2b84b)
    static let favorite = hex(0xff6685)
    static let danger = hex(0xff646f)
    static let success = hex(0x62d89c)
    static let background = hex(0x050707)
    static let surface = hex(0x0d1111)
    static let surface2 = hex(0x151a1a)

    static func hex(_ v: Int) -> Color {
        Color(red: Double(v >> 16 & 0xff) / 255, green: Double(v >> 8 & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }

    static func caption(_ s: CaptionStatus) -> Color {
        switch s {
        case .generated: .blue
        case .edited: .orange
        case .approved: .green
        case .needs_regen: .red
        case .unknown: .gray
        }
    }
}

enum Format {
    static func bytes(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }

    static func duration(_ seconds: Double) -> String {
        let s = Int(seconds.rounded())
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    static func date(ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    static func relative(ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(.relative(presentation: .named))
    }

    static func elapsed(from: Double, to: Double) -> String {
        duration(max(0, (to - from) / 1000))
    }
}

/// Day headers like the web grid: "Today", "Yesterday", weekday this week, else the date.
enum DayGrouping {
    static func key(_ date: Date, calendar: Calendar = .current) -> Date { calendar.startOfDay(for: date) }

    static func title(_ day: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        if calendar.isDate(day, inSameDayAs: now) { return "Today" }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: y) { return "Yesterday" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: day), to: calendar.startOfDay(for: now)).day ?? 0
        if days >= 0, days < 7 { return day.formatted(.dateTime.weekday(.wide)) }
        if calendar.component(.year, from: day) == calendar.component(.year, from: now) {
            return day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
        return day.formatted(.dateTime.month(.abbreviated).day().year())
    }

    /// Consecutive runs of items on the same day, in list order.
    static func sections<T>(_ items: [T], date: (T) -> Date, calendar: Calendar = .current) -> [(day: Date, items: [T])] {
        var out: [(day: Date, items: [T])] = []
        for item in items {
            let d = key(date(item), calendar: calendar)
            if let last = out.last, last.day == d { out[out.count - 1].items.append(item) } else { out.append((d, [item])) }
        }
        return out
    }
}

/// An error line with a retry button.
struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
            if let retry { Button("Retry", action: retry).buttonStyle(.bordered) }
        }
        .padding(12)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// 0–5 stars; tapping the current rating clears it (like the web viewer).
struct StarRating: View {
    let rating: Int
    var size: CGFloat = 22
    var onRate: ((Int) -> Void)?

    var body: some View {
        HStack(spacing: 4) {
            ForEach(1...5, id: \.self) { i in
                Image(systemName: i <= rating ? "star.fill" : "star")
                    .font(.system(size: size))
                    .foregroundStyle(i <= rating ? Theme.star : .secondary)
                    .contentShape(Rectangle())
                    .onTapGesture { onRate?(i == rating ? 0 : i) }
                    .accessibilityLabel("\(i) star\(i == 1 ? "" : "s")")
                    .accessibilityAddTraits(i <= rating ? [.isButton, .isSelected] : .isButton)
            }
        }
    }
}

/// Copies to the pasteboard and shows a brief confirmation.
@MainActor
func copyToPasteboard(_ text: String) {
    UIPasteboard.general.string = text
    UINotificationFeedbackGenerator().notificationOccurred(.success)
}

extension View {
    /// Shows an alert for an error message bound to optional state.
    func errorAlert(_ message: Binding<String?>) -> some View {
        alert("Something went wrong", isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}
