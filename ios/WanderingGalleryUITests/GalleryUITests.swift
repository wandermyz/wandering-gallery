import XCTest

/// Drives the gallery against the dev backend (`cd web && npm run dev:ios`).
final class GalleryUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["WG_SERVER_URL"] = ProcessInfo.processInfo.environment["WG_SERVER_URL"] ?? "http://localhost:2399"
        app.launch()
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// A seeded image with ComfyUI metadata, found through the filename filter.
    private func openSeededImage() {
        let search = app.searchFields["Filter by filename"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        search.tap()
        search.typeText("ComfyUI_00002_")
        let cell = app.descendants(matching: .any)["cell-ComfyUI_00002_.png"]
        XCTAssertTrue(cell.waitForExistence(timeout: 15))
        cell.tap()
        XCTAssertTrue(app.buttons["viewer-info"].waitForExistence(timeout: 5))
    }

    private func openFirstImage() {
        let cell = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'cell-' AND identifier ENDSWITH '.png'")).firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 15))
        cell.tap()
        XCTAssertTrue(app.buttons["viewer-info"].waitForExistence(timeout: 5))
    }

    // parity: VIEW-05, INFO-01, TAG-01, GAL-02
    func testViewerFavoriteRateTagAndDetails() {
        openSeededImage()
        shot("viewer")
        let fav = app.buttons["viewer-favorite"]
        let before = fav.label
        fav.tap()
        XCTAssertTrue(NSPredicate(format: "label != %@", before).evaluate(with: fav) || fav.waitForLabel(not: before))
        fav.tap()
        app.buttons["4 stars"].tap()

        app.buttons["viewer-info"].tap()
        let input = app.textFields["tag-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        shot("details")
        input.tap()
        let tag = "ui-test-\(Int.random(in: 1000...9999))"
        input.typeText(tag)
        app.buttons["tag-create"].tap()
        XCTAssertTrue(app.buttons[tag].waitForExistence(timeout: 5))
        app.buttons["Remove tag \(tag)"].tap()
        XCTAssertTrue(app.buttons["Remove tag \(tag)"].waitForNonExistence(timeout: 5))
        // The generation metadata is further down the panel.
        app.staticTexts["Tags"].firstMatch.swipeUp()
        XCTAssertTrue(app.staticTexts["Positive"].waitForExistence(timeout: 5) || app.staticTexts["POSITIVE"].exists)
    }

    private func openVideo(_ name: String) -> XCUIElement {
        let search = app.searchFields["Filter by filename"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        search.tap()
        search.typeText(String(name.prefix(while: { $0 != "." })))
        let cell = app.descendants(matching: .any)["cell-\(name)"]
        XCTAssertTrue(cell.waitForExistence(timeout: 15))
        cell.tap()
        let video = app.otherElements["Video"]
        XCTAssertTrue(video.waitForExistence(timeout: 10))
        return video
    }

    /// Taps the video to show the system player's controls, which sit between the viewer's bars.
    private func assertControlsClearOfBars(_ video: XCUIElement) {
        let top = app.buttons["viewer-close"].frame.maxY, bottom = app.buttons["viewer-favorite"].frame.minY
        video.tap()
        let scrubber = app.sliders.firstMatch
        XCTAssertTrue(scrubber.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(scrubber.frame.minY, top)
        XCTAssertLessThan(scrubber.frame.maxY, bottom)
        let names = ["AirPlay", "Mute", "Unmute", "Play", "Pause", "Skip"]
        let controls = app.buttons.allElementsBoundByIndex.filter { b in b.exists && names.contains { b.label.contains($0) } }
        XCTAssertFalse(controls.isEmpty)
        for b in controls {
            XCTAssertTrue(b.frame.minY > top && b.frame.maxY < bottom, "\(b.label) at \(b.frame) overlaps a bar")
        }
    }

    // parity: VIEW-03
    func testVideoControlsClearOfBars() {
        let video = openVideo("wan_00001_.mp4")
        assertControlsClearOfBars(video)
        shot("video")
    }

    // parity: VIEW-03
    func testTallVideoFillsScreenAndGoesFullScreen() {
        let video = openVideo("tall_00001_.mp4")
        assertControlsClearOfBars(video)
        shot("tall-video")
        // The player's own full-screen button. Its controls fade after a few seconds, so show
        // them again if a tap only brought them back.
        let fullScreen = app.buttons["Fullscreen Button"]
        let done = app.buttons["Close Button"]  // the system full-screen player's own
        let viewerClose = app.buttons["viewer-close"]
        // Full screen covers the viewer. (The player's own window isn't always in the
        // accessibility tree, so its close button can't be relied on.)
        let inFullScreen = { done.exists || !viewerClose.isHittable }
        for _ in 0..<3 where !inFullScreen() {
            if !fullScreen.exists { video.tap() }
            if fullScreen.waitForExistence(timeout: 3) { fullScreen.tap() }
            sleep(2)
        }
        XCTAssertTrue(inFullScreen())
        shot("full-screen")
        if done.exists { done.tap() } else { app.swipeDown(velocity: .fast) }
        XCTAssertTrue(viewerClose.waitForExistence(timeout: 5))
        XCTAssertTrue(NSPredicate(format: "hittable == true").evaluate(with: viewerClose) || viewerClose.waitForHittable())
    }

    // parity: VIEW-09
    func testTallImageClearOfBars() {
        openFirstImage()  // the seed's images are 9:16, taller than the space between the bars
        // The pager keeps the neighbours' pages around: the one on screen.
        let images = app.images.matching(identifier: "viewer-image")
        XCTAssertTrue(images.firstMatch.waitForExistence(timeout: 10))
        let width = app.windows.firstMatch.frame.width
        guard let image = images.allElementsBoundByIndex.first(where: { $0.frame.minX >= 0 && $0.frame.minX < width }) else {
            return XCTFail("no image on screen")
        }
        let date = app.staticTexts["viewer-subtitle"].frame, fav = app.buttons["viewer-favorite"].frame
        shot("tall-image")
        XCTAssertGreaterThan(image.frame.minY, date.maxY, "image at \(image.frame) under the date line at \(date)")
        XCTAssertLessThan(image.frame.maxY, fav.minY)
    }

    // parity: VIEW-02
    func testSwipeDownCloses() {
        openFirstImage()
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
            .press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)), withVelocity: 120, thenHoldForDuration: 0.5)
        XCTAssertTrue(app.buttons["viewer-info"].waitForNonExistence(timeout: 5))
        let cell = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'cell-'")).firstMatch
        XCTAssertTrue(cell.waitForHittable())
    }

    // parity: VIEW-01
    func testSwipeBetweenItems() {
        openFirstImage()
        let first = app.staticTexts["viewer-title"].label
        app.swipeLeft()
        let second = app.staticTexts["viewer-title"]
        XCTAssertTrue(second.waitForLabel(not: first))
        app.buttons["viewer-close"].tap()
        XCTAssertTrue(app.buttons["grid-filters"].waitForExistence(timeout: 5))
    }

    // parity: TRASH-01
    func testTrashAndRestore() {
        openFirstImage()
        let name = app.staticTexts["viewer-title"].label
        app.buttons["viewer-trash"].tap()
        // The dialog's button, not the viewer's trash button (same label).
        app.buttons.matching(NSPredicate(format: "label == 'Move to trash' AND identifier != 'viewer-trash'")).firstMatch.tap()
        app.buttons["viewer-close"].tap()
        // Sidebar → Trash.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.staticTexts["Trash"].tap()
        let row = app.descendants(matching: .any)["trash-\(name)"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        shot("trash")
        app.buttons["Actions for \(name)"].tap()
        app.buttons["Restore"].tap()
        XCTAssertTrue(row.waitForNonExistence(timeout: 10))
    }

    // parity: HID-01
    func testUnlockShowsHiddenLibrary() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        // Still unlocked from an earlier run (the unlock outlives the app): lock first.
        if app.buttons["Hidden items are shown"].firstMatch.waitForExistence(timeout: 3) {
            app.buttons["Hidden items are shown"].firstMatch.tap()
            app.buttons["lock-now"].tap()
        }
        XCTAssertFalse(app.staticTexts["Vault"].waitForExistence(timeout: 3))
        app.buttons["Show hidden items"].firstMatch.tap()
        let field = app.secureTextFields["passphrase"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("ios dev passphrase\n")
        XCTAssertTrue(app.staticTexts["Vault"].waitForExistence(timeout: 10))
        shot("unlocked")
        app.buttons["Hidden items are shown"].firstMatch.tap()
        app.buttons["lock-now"].tap()
        XCTAssertTrue(app.staticTexts["Vault"].waitForNonExistence(timeout: 10))
    }

    // parity: VIEW-10
    func testChangedFileKeepsZoomUntilReload() throws {
        // A copy of a seeded image in the dev backend's library, made unique so it isn't
        // taken for a move of the original.
        let lib = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../web/.tmp/ios-dev/comfy-out")
        let file = lib.appending(path: "changing-ui.png")
        var data = try Data(contentsOf: lib.appending(path: "ComfyUI_00002_.png"))
        data.append(Data(UUID().uuidString.utf8))
        try data.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }

        let search = app.searchFields["Filter by filename"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        search.tap()
        search.typeText("changing-ui")
        let cell = app.descendants(matching: .any)["cell-changing-ui.png"]
        XCTAssertTrue(cell.waitForExistence(timeout: 20))
        cell.tap()
        let image = app.images["viewer-image"]
        XCTAssertTrue(image.waitForExistence(timeout: 5))
        let fitted = image.frame.width
        image.doubleTap()
        XCTAssertTrue(image.waitForWider(than: fitted * 1.5))

        // The file changes on disk: the image stays zoomed, with a Reload button.
        data.append(Data("more".utf8))
        try data.write(to: file)
        let reload = app.buttons["viewer-file-changed"]
        XCTAssertTrue(reload.waitForExistence(timeout: 20))
        XCTAssertGreaterThan(image.frame.width, fitted * 1.5)
        shot("file-changed")
        reload.tap()
        XCTAssertTrue(reload.waitForNonExistence(timeout: 5))
    }

    // parity: GAL-09
    func testMultiSelectHidesAndTrashes() throws {
        // Three copies of a seeded image in a folder of their own, first in the folder strip (the dev backend is shared), settled enough to be trashed.
        let run = Int.random(in: 1000...9999)
        let lib = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "../../web/.tmp/ios-dev/comfy-out/0-batch-ui-\(run)")
        try FileManager.default.createDirectory(at: lib, withIntermediateDirectories: true)
        let names = (1...3).map { "batch-ui-\(run)-\($0).png" }
        let source = try Data(contentsOf: lib.appending(path: "../ComfyUI_00002_.png"))
        for n in names {
            let file = lib.appending(path: n)
            try (source + Data(n.utf8)).write(to: file)
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -30)], ofItemAtPath: file.path)
        }
        defer { try? FileManager.default.removeItem(at: lib) }
        let cell = { (n: String) in self.app.descendants(matching: .any)["cell-\(n)"] }
        let cells = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "cell-batch-ui-\(run)-"))

        // Locked, so hidden items leave the grid.
        if app.buttons["Hidden items are shown"].firstMatch.waitForExistence(timeout: 3) {
            app.buttons["Hidden items are shown"].firstMatch.tap()
            app.buttons["lock-now"].tap()
        }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.staticTexts["ComfyUI Outputs"].tap()
        let folder = app.buttons["folder-0-batch-ui-\(run)"]
        XCTAssertTrue(folder.waitForExistence(timeout: 20))
        folder.tap()
        XCTAssertTrue(cell(names[2]).waitForExistence(timeout: 20))
        XCTAssertTrue(cells.element(boundBy: 2).waitForExistence(timeout: 10))

        // A long press starts selecting; taps then toggle instead of opening the viewer.
        cell(names[0]).press(forDuration: 0.8)
        XCTAssertTrue(app.navigationBars["1 item selected"].waitForExistence(timeout: 5))
        cell(names[1]).tap()
        XCTAssertTrue(app.navigationBars["2 items selected"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["viewer-info"].exists)
        shot("selecting")
        app.buttons["select-hide"].tap()
        XCTAssertTrue(cell(names[0]).waitForNonExistence(timeout: 10))
        XCTAssertFalse(cell(names[1]).exists)
        XCTAssertTrue(cell(names[2]).exists)

        // Unlocked, they come back and can be unhidden together.
        app.buttons["Show hidden items"].firstMatch.tap()
        let field = app.secureTextFields["passphrase"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("ios dev passphrase\n")
        XCTAssertTrue(cell(names[0]).waitForExistence(timeout: 15))
        app.buttons["grid-select"].tap()
        cell(names[0]).tap()
        cell(names[1]).tap()
        XCTAssertEqual(app.buttons["select-hide"].label, "Unhide")
        app.buttons["select-hide"].tap()
        XCTAssertTrue(app.buttons["select-hide"].waitForNonExistence(timeout: 10))
        app.buttons["Hidden items are shown"].firstMatch.tap()
        app.buttons["lock-now"].tap()
        XCTAssertTrue(cell(names[0]).waitForExistence(timeout: 15))

        // Select all, move to trash after confirming, then Undo.
        app.buttons["grid-select"].tap()
        app.buttons["select-all"].tap()
        XCTAssertTrue(app.navigationBars["3 items selected"].waitForExistence(timeout: 5))
        app.buttons["select-trash"].tap()
        app.buttons.matching(NSPredicate(format: "label == 'Move to trash' AND identifier != 'select-trash'")).firstMatch.tap()
        XCTAssertTrue(cell(names[0]).waitForNonExistence(timeout: 10))
        XCTAssertEqual(cells.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: lib.appending(path: names[0]).path))
        app.buttons["toast-undo"].tap()
        XCTAssertTrue(cell(names[0]).waitForExistence(timeout: 15))
        XCTAssertTrue(cells.element(boundBy: 2).waitForExistence(timeout: 10))
        XCTAssertTrue(FileManager.default.fileExists(atPath: lib.appending(path: names[0]).path))
    }

    // parity: TAG-01, GAL-01
    func testTagsAndFolders() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.staticTexts["Tags"].tap()
        let tag = app.descendants(matching: .any)["tag-portfolio"]
        XCTAssertTrue(tag.waitForExistence(timeout: 10))
        shot("tags")
        tag.tap()
        XCTAssertTrue(app.staticTexts["# portfolio"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.staticTexts["ComfyUI Outputs"].tap()
        let folder = app.buttons["folder-stories"]
        XCTAssertTrue(folder.waitForExistence(timeout: 10))
        folder.tap()
        XCTAssertTrue(app.descendants(matching: .any)["cell-the-harbor.md"].waitForExistence(timeout: 10))
        shot("folder")
    }
}

extension XCUIElement {
    func waitForHittable(timeout: TimeInterval = 5) -> Bool {
        let exp = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: self)
        return XCTWaiter.wait(for: [exp], timeout: timeout) == .completed
    }

    func waitForWider(than width: CGFloat, timeout: TimeInterval = 5) -> Bool {
        let exp = XCTNSPredicateExpectation(predicate: NSPredicate { el, _ in (el as! XCUIElement).frame.width > width }, object: self)
        return XCTWaiter.wait(for: [exp], timeout: timeout) == .completed
    }

    func waitForLabel(not label: String, timeout: TimeInterval = 5) -> Bool {
        let exp = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", label), object: self)
        return XCTWaiter.wait(for: [exp], timeout: timeout) == .completed
    }
}
