import SwiftUI

/// A paginated asset list for one query (the web's `useAssets`): first page, more pages as
/// the grid nears the end, and live updates merged in at the head.
@Observable
final class AssetListModel {
    let client: APIClient
    let query: AssetQuery
    private(set) var items: [Asset] = []
    private(set) var next: String?
    private(set) var total: Int?
    private(set) var loading = false
    private(set) var loaded = false
    var error: String?
    private var generation = 0
    private var loadingMore = false

    init(client: APIClient, query: AssetQuery) {
        self.client = client
        self.query = query
    }

    var hasMore: Bool { next != nil }

    func reload() async {
        generation += 1
        let g = generation
        loading = true
        error = nil
        defer { if g == generation { loading = false } }
        do {
            let page = try await client.assets(query, limit: 120)
            guard g == generation else { return }
            items = page.items
            next = page.next
            total = page.total
            loaded = true
        } catch is CancellationError {
        } catch {
            if g == generation { self.error = error.localizedDescription }
        }
    }

    func loadMore() async {
        guard let cursor = next, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let g = generation
        do {
            let page = try await client.assets(query, cursor: cursor, limit: 240)
            guard g == generation else { return }
            let seen = Set(items.map(\.id))
            items += page.items.filter { !seen.contains($0.id) }
            next = page.next
        } catch is CancellationError {
        } catch {
            if g == generation { self.error = error.localizedDescription }
        }
    }

    /// Merges newly arrived assets at the top without disturbing what is loaded.
    func refreshHead(removed: [Int]) async {
        let g = generation
        guard let page = try? await client.assets(query, limit: 120), g == generation else { return }
        total = page.total
        items = Self.merge(current: items, page: page.items, removed: Set(removed), ascending: query.ascending)
    }

    /// The web's refreshHead merge: drop removed items, refresh loaded ones, put newer ones
    /// first, and slot in items that newly match inside the loaded window.
    nonisolated static func merge(current: [Asset], page: [Asset], removed: Set<Int>, ascending: Bool) -> [Asset] {
        let fresh = Dictionary(page.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let kept = current.filter { !removed.contains($0.id) }.map { fresh[$0.id] ?? $0 }
        guard let head = kept.first, let last = kept.last else { return page }
        let keptIDs = Set(kept.map(\.id))
        let newer = ascending ? [] : page.filter {
            !keptIDs.contains($0.id) && ($0.mtimeMs > head.mtimeMs || ($0.mtimeMs == head.mtimeMs && $0.id > head.id))
        }
        let newerIDs = Set(newer.map(\.id))
        let inside = page.filter {
            !keptIDs.contains($0.id) && !newerIDs.contains($0.id) && (ascending ? $0.mtimeMs <= last.mtimeMs : $0.mtimeMs >= last.mtimeMs)
        }
        var merged = newer + kept + inside
        if !inside.isEmpty {
            merged.sort { a, b in
                if a.mtimeMs != b.mtimeMs { return ascending ? a.mtimeMs < b.mtimeMs : a.mtimeMs > b.mtimeMs }
                return ascending ? a.id < b.id : a.id > b.id
            }
        }
        return merged
    }

    /// A fixed list (no query behind it).
    func setItems(_ items: [Asset]) {
        self.items = items
        total = items.count
        loaded = true
    }

    func patch(_ a: Asset) {
        if let i = items.firstIndex(where: { $0.id == a.id }) { items[i] = a }
    }

    func remove(_ id: Int) {
        items.removeAll { $0.id == id }
        if let t = total { total = max(0, t - 1) }
    }
}
