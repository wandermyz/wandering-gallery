import XCTest

/// The Generate tab against the dev backend (`npm run dev:ios`, fake ComfyUI and tagger).
final class GenerateUITests: XCTestCase {
    static let server = ProcessInfo.processInfo.environment["WG_SERVER_URL"] ?? "http://localhost:2399"

    override func setUp() {
        continueAfterFailure = false
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    /// Polls `cond` (XCUI queries are evaluated afresh each time).
    @MainActor private func wait(_ timeout: TimeInterval, _ what: String, until cond: () -> Bool) {
        let end = Date().addingTimeInterval(timeout)
        while !cond() {
            if Date() > end { return XCTFail("timed out: \(what)") }
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
    }

    /// Launches on the Generate tab with `flow` open.
    @MainActor private func open(_ flow: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["WG_SERVER_URL"] = Self.server
        app.launch()
        let tab = app.tabBars.buttons["Generate"].exists ? app.tabBars.buttons["Generate"] : app.buttons["Generate"]
        XCTAssertTrue(tab.firstMatch.waitForExistence(timeout: 15))
        tab.firstMatch.tap()
        let row = any(app, "generate-flow-\(flow)")
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertTrue(any(app, "generate-comfy-status").waitForExistence(timeout: 10), "ComfyUI status shows")
        shot(app, "generate-flows")
        row.tap()
        return app
    }

    /// Waits for a run to finish and checks it shows its outputs.
    @MainActor private func waitForDone(_ app: XCUIApplication, outputs: Int) {
        let status = app.staticTexts["run-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 15), "the run shows")
        XCTAssertTrue(app.buttons["run-cancel"].exists, "a running run can be cancelled")
        shot(app, "generate-running")
        wait(90, "run done") { status.label == "Done" }
        wait(30, "outputs indexed") { app.buttons.matching(identifier: "job-thumb").count == outputs }
        shot(app, "generate-done")
    }

    @MainActor
    func testTagsFlow() {
        let app = open("wai-illustrious-tags")

        let description = app.textViews["generate-description"].exists ? app.textViews["generate-description"] : app.textFields["generate-description"]
        XCTAssertTrue(description.waitForExistence(timeout: 10))
        description.tap()
        description.typeText("a cat on a roof")

        // Two variations, then generate their tags.
        app.steppers["generate-variation-count"].buttons.element(boundBy: 1).tap()
        let v1 = any(app, "generate-variation-1")
        XCTAssertTrue(v1.waitForExistence(timeout: 5), "a second variation was added")
        app.buttons["generate-tags-button"].tap()
        let v0 = any(app, "generate-variation-0")
        wait(30, "tags generated") {
            (v0.value as? String ?? "").contains("base tags for a cat on a roof") && (v1.value as? String ?? "").contains("varied tags for")
        }
        shot(app, "generate-tags")

        // All have tags now: the button asks before regenerating them all.
        let tagsButton = app.buttons["generate-tags-button"]
        XCTAssertEqual(tagsButton.label, "Regenerate all")
        v0.tap()
        v0.typeText(", extra")
        tagsButton.tap()
        let confirm = app.buttons.matching(identifier: "generate-regenerate-confirm").firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        shot(app, "generate-confirm")
        confirm.tap()
        wait(30, "tags regenerated") {
            !(v0.value as? String ?? "").contains("extra") && (v1.value as? String ?? "").contains("varied tags for") && tagsButton.isEnabled
        }

        // Remove the second variation, one image each.
        app.buttons["generate-variation-remove-1"].tap()
        XCTAssertFalse(any(app, "generate-variation-1").waitForExistence(timeout: 2))
        let batch = app.steppers["generate-batch"]
        batch.buttons.element(boundBy: 0).tap()
        batch.buttons.element(boundBy: 0).tap()
        let start = app.buttons["generate-start"]
        XCTAssertEqual(start.label, "Generate 1 image")
        start.tap()
        waitForDone(app, outputs: 1)

        // Tap the output: the full-screen viewer.
        app.buttons.matching(identifier: "job-thumb").firstMatch.tap()
        XCTAssertTrue(app.buttons["viewer-close"].waitForExistence(timeout: 5))
        shot(app, "generate-viewer")
        app.buttons["viewer-close"].tap()

        // Reuse puts the run back into the form.
        app.buttons["run-reuse"].firstMatch.tap()
        XCTAssertTrue(app.buttons["generate-tags-button"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testVideoFlow() {
        let app = open("minimax-h3-i2v")

        let choose = app.buttons["video-choose"]
        XCTAssertTrue(choose.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["generate-start"].isEnabled, "needs an image and a prompt")
        choose.tap()
        let image = app.buttons.matching(identifier: "picker-image").firstMatch
        XCTAssertTrue(image.waitForExistence(timeout: 15))
        shot(app, "generate-picker")
        image.tap()
        XCTAssertTrue(any(app, "video-preview").waitForExistence(timeout: 10), "the chosen image shows")

        let prompt = app.textViews["video-prompt"].exists ? app.textViews["video-prompt"] : app.textFields["video-prompt"]
        prompt.tap()
        prompt.typeText("The cat looks up and blinks.")
        app.buttons["8 s"].tap()
        shot(app, "generate-video-form")
        app.buttons["generate-start"].tap()
        waitForDone(app, outputs: 1)
    }
}
