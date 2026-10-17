import Foundation
import Testing
@testable import WanderingGallery

private func fixture<T: Decodable>(_ name: String, as: T.Type) throws -> T {
    let bundle = Bundle(for: BundleToken.self)
    let url = try #require(bundle.url(forResource: name, withExtension: "json"))
    return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
}

private final class BundleToken {}

/// Responses captured from the dev backend decode into the models.
@Suite struct DecodingTests {
    @Test func libraries() throws {
        let r = try fixture("libraries", as: APIClient.LibrariesResponse.self)
        #expect(r.libraries.contains { $0.id == "comfyui" && $0.writable })
    }

    @Test func assets() throws {
        let page = try fixture("assets", as: AssetPage.self)
        #expect(!page.items.isEmpty)
        #expect(page.next != nil)
        #expect(page.items.allSatisfy { !$0.v.isEmpty })
    }

    @Test func metadata() throws {
        let m = try fixture("metadata", as: MetadataResponse.self)
        let s = try #require(m.summary)
        #expect(s.source == "comfyui")
        #expect(s.samplers.first?.steps != nil)
        #expect(s.params["width"]?.description == "832")
    }

    @Test func everythingElse() throws {
        _ = try fixture("folders", as: APIClient.FoldersResponse.self)
        _ = try fixture("tags", as: APIClient.TagsResponse.self)
        let trash = try fixture("trash", as: APIClient.TrashResponse.self)
        #expect(trash.items.allSatisfy { $0.expiresAtMs != nil })
        let flows = try fixture("flows", as: APIClient.FlowsResponse.self).flows
        #expect(flows.first { $0.kind == "video" }?.seconds?.isEmpty == false)
        _ = try fixture("comfy-status", as: ComfyStatus.self)
        let dash = try fixture("dashboard", as: Dashboard.self)
        #expect(dash.gpu.now?.memTotalMib == 16303)
        #expect(dash.workload?.status?.last_event?["event"]?.string == "switch")
        _ = try fixture("session", as: Session.self)
        _ = try fixture("status", as: ServerStatus.self)
        let cap = try fixture("caption", as: CaptionResponse.self)
        #expect(cap.txt != nil)
        let md = try fixture("markdown", as: APIClient.MarkdownResponse.self)
        #expect(md.text.contains("mermaid"))
        #expect(!md.refs.isEmpty)
    }

    @Test func scalarDescription() {
        #expect(Scalar.number(28).description == "28")
        #expect(Scalar.number(5.5).description == "5.5")
        #expect(Scalar.bool(true).description == "true")
    }
}

@Suite struct SSEParserTests {
    @Test func namedEventEndsAtItsData() {
        var p = SSEParser()
        #expect(p.feed("retry: 5000").isEmpty)
        #expect(p.feed(": ping").isEmpty)
        #expect(p.feed("event: change").isEmpty)
        let evs = p.feed(#"data: {"libraries":["a"],"removed":[]}"#)
        #expect(evs == [SSEParser.Event(event: "change", data: #"{"libraries":["a"],"removed":[]}"#)])
    }

    @Test func unnamedEventEndsAtBlankLine() {
        var p = SSEParser()
        #expect(p.feed("data: one").isEmpty)
        #expect(p.feed("data: two").isEmpty)
        #expect(p.feed("") == [SSEParser.Event(event: "message", data: "one\ntwo")])
    }
}

@Suite struct ListMergeTests {
    private func asset(_ id: Int, _ t: Double) -> Asset {
        let json = """
        {"id":\(id),"library":"l","path":"a\(id).png","filePath":null,"folder":"","name":"a\(id).png","kind":"image","mime":"image/png",
        "size":1,"mtimeMs":\(t),"width":1,"height":1,"duration":null,"videoCodec":null,"audioCodec":null,"playable":"yes","animated":false,
        "hasMeta":false,"indexState":"done","indexError":null,"favorite":false,"rating":0,"hidden":false,"libraryHidden":false,"status":"ready",
        "trashedAtMs":null,"caption":null,"captionCandidate":false,"captionRev":0,"tags":[],"v":"x","needsPreview":false}
        """
        return try! JSONDecoder().decode(Asset.self, from: Data(json.utf8))
    }

    @Test func newItemsGoFirstAndRemovedOnesGo() {
        let current = [asset(3, 300), asset(2, 200), asset(1, 100)]
        let page = [asset(4, 400), asset(3, 300), asset(1, 100)]
        let merged = AssetListModel.merge(current: current, page: page, removed: [2], ascending: false)
        #expect(merged.map(\.id) == [4, 3, 1])
    }

    @Test func restoredItemSlotsIntoLoadedWindow() {
        let current = [asset(5, 500), asset(3, 300), asset(1, 100)]
        let page = [asset(5, 500), asset(4, 400), asset(3, 300), asset(1, 100)]
        let merged = AssetListModel.merge(current: current, page: page, removed: [], ascending: false)
        #expect(merged.map(\.id) == [5, 4, 3, 1])
    }
}

@Suite struct QueryTests {
    @Test func onlySetFiltersAreSent() {
        var q = AssetQuery()
        #expect(q.items(cursor: nil, limit: 120).map(\.name) == ["limit"])
        q.library = "lib"
        q.recursive = false
        q.favorite = true
        q.minRating = 3
        q.kind = .video
        q.caption = .needs_regen
        q.ascending = true
        let items = Dictionary(uniqueKeysWithValues: q.items(cursor: "c", limit: 10).map { ($0.name, $0.value ?? "") })
        #expect(items == ["library": "lib", "recursive": "0", "favorite": "1", "minRating": "3", "kind": "video",
                          "caption": "needs_regen", "order": "asc", "cursor": "c", "limit": "10"])
    }

    @Test func urlsKeepABasePath() {
        let c = APIClient(baseURL: URL(string: "https://host.ts.net:23334/gallery/")!)
        #expect(c.url("/api/tags").absoluteString == "https://host.ts.net:23334/gallery/api/tags")
    }

    @Test func serverURLDefaultsToHTTPS() {
        #expect(Server(name: "x", url: "host.ts.net:23334").baseURL?.absoluteString == "https://host.ts.net:23334")
        #expect(Server(name: "x", url: "ftp://nope").baseURL == nil)
    }

    @Test func plainHTTPOnlyForLoopback() {
        #expect(Server(name: "x", url: "http://host.ts.net:2399").baseURL == nil)
        #expect(Server(name: "x", url: "http://host.ts.net:2399").urlProblem?.contains("https://") == true)
        #expect(Server(name: "x", url: "http://192.168.1.5:2399").baseURL == nil)
        #expect(Server(name: "x", url: "http://localhost:2399").baseURL != nil)
        #expect(Server(name: "x", url: "http://127.0.0.1:2399").baseURL != nil)
        #expect(Server(name: "x", url: "https://host.ts.net:23399").urlProblem == nil)
        #expect(Server(name: "x", url: "  ").urlProblem != nil)
    }
}

@Suite struct DayGroupingTests {
    @Test func titles() {
        let cal = Calendar.current
        let now = Date()
        #expect(DayGrouping.title(now, now: now) == "Today")
        #expect(DayGrouping.title(cal.date(byAdding: .day, value: -1, to: now)!, now: now) == "Yesterday")
    }

    @Test func consecutiveDaysGroup() {
        let now = Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: Date())!
        let dates = [now, now.addingTimeInterval(-60), now.addingTimeInterval(-86_400 * 3)]
        let sections = DayGrouping.sections(dates, date: { $0 })
        #expect(sections.map(\.items.count) == [2, 1])
    }
}
