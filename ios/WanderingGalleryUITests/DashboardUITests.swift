import XCTest

/// The Dashboard tab against the dev backend (`npm run dev:ios`, fake ComfyUI and nvidia-smi).
final class DashboardUITests: XCTestCase {
    static let server = ProcessInfo.processInfo.environment["WG_SERVER_URL"] ?? "http://localhost:2399"

    override func setUp() {
        continueAfterFailure = false
    }

    /// Queues `batch` jobs on the fake ComfyUI through the Generate API.
    private static func queueJobs(batch: Int) async throws {
        let base = URL(string: Self.server)!
        let session = URLSession(configuration: .ephemeral)
        let (sdata, _) = try await session.data(from: base.appending(path: "api/session"))
        let csrf = try XCTUnwrap((try JSONSerialization.jsonObject(with: sdata) as? [String: Any])?["csrf"] as? String)
        var req = URLRequest(url: base.appending(path: "api/generate/flows/wai-illustrious-tags/runs"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["prompt": "x", "variations": ["masterpiece, 1girl"], "batch": batch])
        let (_, resp) = try await session.data(for: req)
        XCTAssertLessThan((resp as? HTTPURLResponse)?.statusCode ?? 500, 300, "queueing jobs failed")
    }

    @MainActor
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    // parity: DASH-01, DASH-03
    @MainActor
    func testRunningJobAndCancel() throws {
        let queued = expectation(description: "jobs queued")
        Task.detached {
            do { try await Self.queueJobs(batch: 8) } catch { XCTFail("queueing jobs: \(error)") }
            queued.fulfill()
        }
        wait(for: [queued], timeout: 15)

        let app = XCUIApplication()
        app.launchEnvironment["WG_SERVER_URL"] = Self.server
        app.launch()
        // iPhone: bottom tab bar; iPad: the tab bar at the top.
        let tab = app.tabBars.buttons["Dashboard"].exists ? app.tabBars.buttons["Dashboard"] : app.buttons["Dashboard"]
        XCTAssertTrue(tab.firstMatch.waitForExistence(timeout: 15))
        tab.firstMatch.tap()

        XCTAssertTrue(app.descendants(matching: .any)["dash-gpu"].waitForExistence(timeout: 15))
        let running = app.descendants(matching: .any).matching(identifier: "dash-running-job").firstMatch
        XCTAssertTrue(running.waitForExistence(timeout: 15), "a running job shows")
        shot(app, "dashboard-running")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "dash-pending-job").firstMatch.waitForExistence(timeout: 5), "queued jobs show")

        // Cancel the first queued job: confirm, then it leaves the queue.
        let pendingBefore = app.descendants(matching: .any).matching(identifier: "dash-pending-job").count
        let cancel = app.descendants(matching: .any).matching(identifier: "dash-pending-job").firstMatch.buttons["job-cancel"].firstMatch
        cancel.tap()
        let confirm = app.alerts.buttons["Remove job"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        shot(app, "dashboard-confirm")
        confirm.tap()
        XCTAssertTrue(app.staticTexts["Job removed from the queue"].firstMatch.waitForExistence(timeout: 10))
        shot(app, "dashboard-cancelled")
        let fewer = NSPredicate { _, _ in
            app.descendants(matching: .any).matching(identifier: "dash-pending-job").count < pendingBefore
        }
        wait(for: [XCTNSPredicateExpectation(predicate: fewer, object: nil)], timeout: 10)

        // Stop the running job.
        running.buttons["job-cancel"].firstMatch.tap()
        let stop = app.alerts.buttons["Stop job"].firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        stop.tap()
        XCTAssertTrue(app.staticTexts["Job stopped"].firstMatch.waitForExistence(timeout: 10))

        // Finished and cancelled jobs land in Recent.
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "dash-recent-job").firstMatch.waitForExistence(timeout: 30))
        app.swipeUp()
        shot(app, "dashboard-recent")
    }

    // parity: DASH-06
    @MainActor
    func testCancelAll() throws {
        let queued = expectation(description: "jobs queued")
        Task.detached {
            do { try await Self.queueJobs(batch: 8) } catch { XCTFail("queueing jobs: \(error)") }
            queued.fulfill()
        }
        wait(for: [queued], timeout: 15)

        let app = XCUIApplication()
        app.launchEnvironment["WG_SERVER_URL"] = Self.server
        app.launch()
        let tab = app.tabBars.buttons["Dashboard"].exists ? app.tabBars.buttons["Dashboard"] : app.buttons["Dashboard"]
        XCTAssertTrue(tab.firstMatch.waitForExistence(timeout: 15))
        tab.firstMatch.tap()

        let all = app.buttons["jobs-cancel-all"].firstMatch
        XCTAssertTrue(all.waitForExistence(timeout: 15), "Cancel all shows with several jobs")
        XCTAssertTrue(all.label.hasPrefix("Cancel all "))

        // Keep leaves the queue alone.
        all.tap()
        XCTAssertTrue(app.alerts.buttons["Keep"].firstMatch.waitForExistence(timeout: 5))
        app.alerts.buttons["Keep"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "dash-pending-job").firstMatch.exists)

        all.tap()
        let confirm = app.alerts.buttons["Cancel all"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        shot(app, "dashboard-cancel-all-confirm")
        confirm.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Cancelled '")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["The queue is empty."].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Nothing running."].firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(all.exists)
        shot(app, "dashboard-cancelled-all")
    }

    /// The dev backend's fake vhotseat reports the mode written to `web/.tmp/fake-vhotseat-mode`.
    private static func gpuMode(_ mode: String) throws {
        let web = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../web")
        let tmp = web.appending(path: ".tmp")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        try mode.write(to: tmp.appending(path: "fake-vhotseat-mode"), atomically: true, encoding: .utf8)
    }

    // parity: DASH-05
    @MainActor
    func testGpuFree() throws {
        try Self.gpuMode("none")
        defer { try? Self.gpuMode("comfy") }

        let app = XCUIApplication()
        app.launchEnvironment["WG_SERVER_URL"] = Self.server
        app.launch()
        let tab = app.tabBars.buttons["Dashboard"].exists ? app.tabBars.buttons["Dashboard"] : app.buttons["Dashboard"]
        XCTAssertTrue(tab.firstMatch.waitForExistence(timeout: 15))
        tab.firstMatch.tap()

        let pill = app.descendants(matching: .any)["dash-workload-mode"].firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 15))
        let free = NSPredicate { _, _ in pill.label == "Free" }
        wait(for: [XCTNSPredicateExpectation(predicate: free, object: nil)], timeout: 15)
        XCTAssertTrue(app.staticTexts["Nothing holds the GPU; whichever side asks next loads."].firstMatch.waitForExistence(timeout: 5))
        shot(app, "dashboard-gpu-free")
    }
}
