import SwiftUI

/// A running slideshow over a grid's list (the web's `Slideshow`): images on a timer, videos
/// played through (a short clip loops until it has had its time), previous / next, pause,
/// and back to the start at the end. Whatever shows it (this device or an external display)
/// reports when a slide is on screen and when a video ends.
@MainActor @Observable
final class SlideshowModel {
    static let intervals = [3, 5, 10, 20, 30]
    private static let intervalKey = "slideshowInterval"
    private static let shuffleKey = "slideshowShuffle"

    /// The grid's list.
    let base: AssetListModel
    let client: APIClient
    let startID: Int
    /// Started on an item (from the viewer): shuffled, it still comes first.
    let pinned: Bool
    /// Where the slides come from: the grid's list, or the view shuffled.
    private(set) var list: AssetListModel
    private(set) var shuffle: Bool
    /// Fetching the shuffled order before the first slide.
    private(set) var loading = false

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

    init(list: AssetListModel, client: APIClient, startID: Int, pinned: Bool) {
        base = list
        self.list = list
        self.client = client
        self.startID = startID
        self.pinned = pinned
        let saved = UserDefaults.standard.integer(forKey: Self.intervalKey)
        interval = Self.intervals.contains(saved) ? saved : 5
        shuffle = UserDefaults.standard.bool(forKey: Self.shuffleKey)
        if shuffle && !pinned {
            // Shuffled from the grid, the first slide is a random one, once it's fetched.
            loading = true
            return
        }
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

    /// Fetches the shuffled order when the slideshow starts shuffled.
    func begin() async {
        guard shuffle else { return }
        await useShuffled()
        loading = false
        if current == nil, let first = list.items.first(where: Self.eligible) ?? base.items.first(where: Self.eligible) {
            current = first
            restartClock()
        }
    }

    func toggleShuffle() {
        shuffle.toggle()
        UserDefaults.standard.set(shuffle, forKey: Self.shuffleKey)
        stepping?.cancel()
        stepping = nil
        queued = 0
        if shuffle {
            Task { await useShuffled() }
        } else {
            list = base
            // A slide that isn't in the grid's loaded list continues from the top.
            lastIndex = 0
        }
    }

    /// The view in a random order (a new one each time), the current slide first. A fixed
    /// list (the filename filter's matches) is shuffled here; a query by the server, all of it.
    private func useShuffled() async {
        let shuffled: AssetListModel
        if base.fixed {
            shuffled = AssetListModel(client: client, query: base.query)
            shuffled.setItems(base.items.shuffled())
        } else {
            var q = base.query
            q.shuffleSeed = Int.random(in: 0..<Int(Int32.max))
            shuffled = AssetListModel(client: client, query: q)
            await shuffled.reload()
            guard !Task.isCancelled, shuffle else { return }
            // Couldn't fetch it: the grid's order rather than nothing.
            if shuffled.items.isEmpty { return }
        }
        if let current { shuffled.prepend(current) }
        list = shuffled
    }

    func stop() {
        stopped = true
        timer?.cancel()
        stepping?.cancel()
        queued = 0
    }

    /// Steps asked for while one is still loading its image: each tap counts.
    private var queued = 0

    func go(_ dir: Int) {
        queued += dir
        guard stepping == nil else { return }
        stepping = Task {
            while queued != 0, !Task.isCancelled {
                let d = queued > 0 ? 1 : -1
                queued -= d
                await step(d)
            }
            if !Task.isCancelled { stepping = nil }
        }
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
