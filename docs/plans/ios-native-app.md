# Native iOS app

Rewrite every feature of the web client as a native SwiftUI app, `ios/` in this repo,
talking to the **existing** Node backend (`web/src/server`) over its JSON API. No backend
behaviour changes beyond small, additive ones listed below.

## Scope: feature parity checklist

| Area | Web feature | Native |
| --- | --- | --- |
| Shell | Sections Gallery / Generate / Dashboard, ☰ drawer | `TabView` (Gallery, Generate, Dashboard) + sidebar list per section |
| Gallery | All media, Favorites, per-library, folders, Trash | `NavigationStack` with library/folder list |
| Gallery | Virtualized grid grouped by day, thumb size | `LazyVGrid` with day sections, pinch / setting for column count |
| Gallery | Filters: type, favorites, min rating, sort, subfolders, caption status | Filter sheet, state persisted in `@SceneStorage` |
| Gallery | Live updates (`/api/events` SSE) | `URLSession.bytes` SSE reader, auto-reconnect |
| Gallery | Rescan | Menu action |
| Viewer | Swipe paging, pinch / double-tap zoom, swipe-down close, tap hides chrome | `TabView(.page)` + `UIScrollView`-backed zoom view |
| Viewer | Video (AVPlayer), audio | `VideoPlayer` / `AVPlayer` with HTTP range from `/file` |
| Viewer | Markdown documents w/ embedded media and Mermaid (+ zoom) | `WKWebView` rendering `/markdown` HTML with mermaid.js bundled locally; tap embedded media → native viewer |
| Viewer | Favorite, 0–5 rating, trash (confirm), copy path, hide/unhide | Toolbar buttons + haptics |
| Info | ComfyUI metadata (prompts, seed, sampler, models, LoRAs), copy prompt, raw JSON | Info sheet, `ShareLink`/copy, raw JSON in a monospaced text view |
| Info | Tags: autocomplete, create, remove, tap → tag view | Token field with suggestions |
| Info | Training captions: edit, approve, needs-regen, accept/discard candidate, 409 conflict | Caption editor section; conflict alert with reload |
| Tags | Tag list w/ covers + counts, rename/merge, delete, hide | List screen with swipe actions |
| Hidden | Unlock with passphrase, countdown, lock early, eye badges | Lock button + sheet; cookie kept in `HTTPCookieStorage` |
| Trash | List, restore, purge, purge all | Trash screen |
| Generate | Flow list, ComfyUI online banner (10 s re-check) | Flow list |
| Generate | Tags flow: description → N tag variations, edit / regen / remove, hand-typed, LoRA flows, run, run progress, results | Form screen + runs list with progress |
| Generate | Video flow (MiniMax H3 i2v): pick input image (from gallery / copied path), upload, run | Same, plus a "Use in video flow" action from the viewer |
| Generate | Runs history, cancel run | Runs list |
| Dashboard | Queue (running, queued, recent), GPU cards, gpu-workload holder, cancel job, 3 s refresh | Polling while visible |
| Settings | (web uses same origin) | Server URL, connection test, thumb cache clear |

## Architecture

- SwiftUI, iOS 17+ (`@Observable`), Swift 6, no third-party packages. Bundle id
  `com.wandermyz.wandering-gallery`, team as in other projects. Project generated
  from a checked-in `project.yml`? `xcodegen` isn't installed, so: a hand-made
  `.xcodeproj` with file-system-synchronized groups (Xcode 16+), so new files need no
  pbxproj edits.
- Layers:
  - `API/` — `APIClient` (async/await, `Codable` models mirroring `src/client/*/api.ts`),
    `EventStream` (SSE), `ImagePipeline` (thumb fetch + `NSCache` + disk cache keyed by
    the server's thumb URL, which already changes on content change).
  - `Features/Gallery`, `Features/Viewer`, `Features/Info`, `Features/Tags`,
    `Features/Trash`, `Features/Generate`, `Features/Dashboard`, `Features/Settings`.
  - `Common/` — rating stars, chips, error banners, relative time.
- Networking: base URL from Settings (default the Tailscale Serve URL, e.g.
  `https://<machine>.<tailnet>.ts.net:23334`). The server checks `Host` against
  `allowedHosts`; the app uses the same hostname so nothing changes. ATS: HTTPS via
  Tailscale is fine; allow `NSAllowsLocalNetworking` for the simulator against `localhost`.

## Backend changes (small, additive, tested in `web/test`)

1. Nothing required for parity. All features already go through `/api/*`.
2. Possibly: a `GET /api/markdown/:id?embed=native` variant or a CSS hook so the
   WKWebView can intercept media taps — decide while building; prefer doing it client-side
   with injected JS.
3. If the unlock cookie has `SameSite`/`Secure` flags that break on `http://localhost`
   in the simulator, handle it in the test config only.

## Test backend with mock ComfyUI and populated data

The repo already has fakes used by Playwright: `e2e/fake-comfy.mjs` (ComfyUI HTTP),
`e2e/fake-comfy-cli.mjs` (comfy-cli envelope), `fake-danbooru-tagger.mjs`,
`fake-gpu-workload.mjs`, `fake-nvidia-smi.mjs`. Plan:

- `web/scripts/ios-dev-backend.mjs` (or `npm run dev:ios`): builds a richer library under
  `web/.tmp/ios-dev/` and starts the server on `0.0.0.0:2399` plus `fake-comfy` on 2397.
  Data:
  - ~300 generated PNGs over the last ~30 days (varied sizes/colours, ComfyUI metadata
    from the existing fixtures with seeds/prompts varied), a few JPEG folders, nested
    subfolders.
  - Videos (with Wan metadata) and audio via ffmpeg, Markdown stories with embedded
    media and Mermaid.
  - Caption sidecars in every status, a read-only library, a `showInAll: false`
    library, a hidden library, hidden items, a passphrase (`ios dev passphrase`).
  - Pre-seeded favorites, ratings, tags (incl. a hidden tag) and a few trashed items, via
    the API after the first scan.
  - Generate config with LoRA flows, a prompts dir, and the fake ComfyUI writing outputs
    into the `comfy` library so generated images appear live.
- Extend the fake ComfyUI only if the native client needs something the browser tests
  didn't (e.g. a slower, multi-step job so progress is visible; GPU numbers that move).

## Verification

- Unit tests (`XCTest`/Swift Testing): JSON decoding against real responses captured
  from the dev backend, SSE parser, filter → query-string mapping, day grouping.
- UI tests (XCUITest) against the dev backend in the simulator: browse → open → swipe →
  rate/favorite/tag → trash/restore; unlock hidden; generate tags flow end-to-end with
  the fake ComfyUI; dashboard cancel.
- Screenshots of each screen from the simulator, reviewed against the web app.
- Existing `npm test` / Playwright stay green.
- Publish via ios-dist for on-device testing once it works in the simulator.

## Milestones (one PR each)

1. Project skeleton, Settings, `APIClient` + models, dev backend script with seeded data.
2. Gallery grid, libraries/folders, filters, SSE live updates, rescan.
3. Viewer: images (zoom/paging), video, audio; favorite / rating / trash / copy path.
4. Info panel: metadata, tags, captions; Tags screen; Trash screen.
5. Hidden items: unlock/lock, badges, hide/unhide.
6. Markdown viewer with Mermaid + zoom.
7. Generate: flows, tags flow, LoRA flows, runs + progress + cancel.
8. Generate: video flow (input from gallery).
9. Dashboard.
10. Polish (iPad layout, haptics, accessibility, empty/error states), README, ios-dist publish.

## Open questions

- iOS 17 minimum OK? (Others use 16; 17 gives `@Observable` and better scroll APIs.)
- `ios/` in this repo (proposed) vs a separate repo?
- Keep the web app as is (yes, assumed) — the native app is an additional client.
- iPad: full support or iPhone-first with a reasonable iPad layout (proposed)?
