import SwiftUI

/// A running slideshow over a grid's list (the web's `Slideshow`): images on a timer, videos
/// played through (a short clip loops until it has had its time), previous / next, pause,
/// and back to the start at the end. Whatever shows it (this device or an external display)
/// reports when a slide is on screen and when a video ends.
@MainActor @Observable
final class SlideshowModel {
    static let intervals = [3, 5, 10, 20, 30]
    private static let intervalKey = "slideshowInterval"

    let list: AssetListModel
    let client: APIClient
    let startID: Int

    private(set) var current: Asset?
    private(set) var playing = true
    private(set) var interval: Int
    var muted = true
    /// Bumped whenever a slide's time starts again (new slide, play, new interval).
    private(set) var lap = 0

    private var ready = false
    private var shownAt = Date()
    private var timer: Task<Void, Never>?
    private var stepping: Task<Void, Never>?
    private var lastIndex = 0
    private var stopped = false

    /// Images and videos this device can play; audio and documents are skipped.
    nonisolated static func eligible(_ a: Asset) -> Bool {
        a.status == "ready" && (a.kind == .image || (a.kind == .video && a.playable != "no"))
    }

    init(list: AssetListModel, client: APIClient, startID: Int) {
        self.list = list
        self.client = client
        self.startID = startID
        let saved = UserDefaults.standard.integer(forKey: Self.intervalKey)
        interval = Self.intervals.contains(saved) ? saved : 5
        let items = list.items
        let at = items.firstIndex { $0.id == startID } ?? 0
        current = items[at...].first(where: Self.eligible) ?? items.first(where: Self.eligible)
        lastIndex = current.flatMap { c in items.firstIndex { $0.id == c.id } } ?? 0
    }

    var index: Int? { current.flatMap { c in list.items.firstIndex { $0.id == c.id } } }

    /// "3 / 40", or just "3" while more pages are left.
    var counter: String {
        guard let i = index else { return "" }
        return list.hasMore ? "\(i + 1)" : "\(i + 1) / \(list.items.count)"
    }

    func stop() {
        stopped = true
        timer?.cancel()
        stepping?.cancel()
    }

    func go(_ dir: Int) {
        stepping?.cancel()
        stepping = Task { await step(dir) }
    }

    func togglePlay() {
        playing.toggle()
        restartClock()
    }

    func setInterval(_ s: Int) {
        interval = s
        UserDefaults.standard.set(s, forKey: Self.intervalKey)
        restartClock()
    }

    /// The slide is on screen (its image loaded, its video ready), or failed to load.
    func slideReady(_ id: Int, failed: Bool = false) {
        guard id == current?.id, !ready else { return }
        ready = true
        if failed {
            // Skip a slide that can't be shown, after a moment.
            timer?.cancel()
            timer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1.2))
                guard let self, !Task.isCancelled, self.playing, self.current?.id == id else { return }
                self.go(1)
            }
        } else {
            schedule()
        }
    }

    /// A video reached its end: true to play it again (a short clip loops until it has had its
    /// time, and while paused), false when the slideshow moved on.
    func videoEnded(_ id: Int) -> Bool {
        guard id == current?.id else { return false }
        if !playing || Date.now.timeIntervalSince(shownAt) < Double(interval) { return true }
        go(1)
        return false
    }

    // MARK: Stepping

    private func restartClock() {
        shownAt = .now
        lap += 1
        schedule()
    }

    private func schedule() {
        timer?.cancel()
        guard playing, ready, !stopped, let c = current, c.kind == .image else { return }
        let id = c.id, s = interval
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(s))
            guard let self, !Task.isCancelled, self.current?.id == id else { return }
            self.go(1)
        }
    }

    private func step(_ dir: Int) async {
        guard let target = await find(dir), !Task.isCancelled, !stopped else { return }
        if target.id == current?.id {
            // The only slide: its time starts again.
            restartClock()
            return
        }
        // Fetch the image first, so it fades in whole.
        if target.kind == .image {
            _ = await ImageLoader.shared.load(client.displayURL(target), maxPixel: 4096)
            guard !Task.isCancelled, !stopped else { return }
        }
        timer?.cancel()
        ready = false
        current = target
        if let i = index { lastIndex = i }
        restartClock()
        // Load the next page before reaching the end.
        if let i = index, list.hasMore, i >= list.items.count - 6 { Task { await list.loadMore() } }
    }

    private func find(_ dir: Int) async -> Asset? {
        var items = list.items
        let at = index
        var i = at.map { $0 + dir } ?? (dir > 0 ? lastIndex : lastIndex - 1)
        while true {
            while i >= 0 && i < items.count {
                if Self.eligible(items[i]) { return items[i] }
                i += dir
            }
            // Past the end: the next page, if there's one.
            guard dir > 0, list.hasMore else { break }
            let before = items.count
            await list.loadMore()
            if Task.isCancelled { return nil }
            items = list.items
            if items.count <= before { break }
        }
        // Wrap around (backwards only once the whole list is loaded).
        if dir < 0 && list.hasMore { return nil }
        return dir > 0 ? items.first(where: Self.eligible) : items.last(where: Self.eligible)
    }
}
