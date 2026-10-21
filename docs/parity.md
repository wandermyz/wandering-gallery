# Web ↔ iOS feature parity

Every user-facing behavior of the app, with its status in the web app (`web/`) and the iOS app
(`ios/`). `npm test` (in `web/`) checks this file against the tests (`web/test/parity.test.ts`);
`npm run parity` prints what's pending.

**Statuses** (Web and iOS columns):

| Status | Meaning | Check |
| --- | --- | --- |
| `✅` | Built, and covered by an automated test | A test on that side must carry the ID |
| `untested` | Built, but no automated test yet | No test may carry the ID |
| `pending` | Not built yet: say why in Notes (e.g. "web done on Linux 2026-10-20, iOS not testable there") | No test may carry the ID |
| `n/a` | Doesn't apply to that side | No test may carry the ID |

**Tagging tests:** put a comment on the line above the test, `// parity: GAL-07` (several:
`// parity: GAL-07, TAG-01`):

- Web: `test(...)` in `web/e2e/*.spec.ts`
- iOS: `func test…()` in `ios/WanderingGalleryUITests/*.swift` or `ios/WanderingGalleryTests/*.swift`

A new behavior gets the next free ID in its group, in the same change that adds it. An ID is
never reused.

## Shell

| ID | Behavior | Web | iOS | Notes |
| --- | --- | --- | --- | --- |
| SHELL-01 | Old URLs (`/`, `/?lib=…`, `/trash`) land on the same gallery view | ✅ | n/a | iOS has no URLs |
| SHELL-02 | Switch between Gallery, Generate and Dashboard, keeping the gallery view | ✅ | untested | |
| SHELL-03 | Nothing scrolls sideways on narrow and wide screens | ✅ | n/a | |
| SHELL-04 | Pick the backend server; HTTPS only (plain HTTP just for localhost) | n/a | ✅ | The web app is served by its backend |
| SHELL-05 | Miku color palette: teal-black surfaces, mint accent, dark text on mint buttons | untested | untested | Values in `web/src/client/styles.css` (`:root`) and iOS `Theme` (`Common/UI.swift`) |

## Gallery

| ID | Behavior | Web | iOS | Notes |
| --- | --- | --- | --- | --- |
| GAL-01 | Grid with day headers, badges (video, audio, document, favorite, rating, hidden, caption) and folders | ✅ | ✅ | |
| GAL-02 | Filename filter narrows the current view | ✅ | ✅ | |
| GAL-03 | Scrolling loads older pages down to the oldest item | ✅ | untested | |
| GAL-04 | New files appear without reloading (live updates) | ✅ | untested | |
| GAL-05 | Read-only libraries can't delete | ✅ | untested | |
| GAL-06 | Browsing and organising never change the original files | ✅ | n/a | Server behavior |
| GAL-07 | Filter sheet: type, favorites, minimum rating, caption status, order, subfolders, thumbnail size | untested | untested | |
| GAL-08 | Rescan a library or all libraries | untested | untested | |
| GAL-09 | Multi-select (long press or Select): hide/unhide or move to trash in one go, with Undo | ✅ | ✅ | |

## Viewer

| ID | Behavior | Web | iOS | Notes |
| --- | --- | --- | --- | --- |
| VIEW-01 | Swipe or arrow between items; pinch and double-tap zoom | ✅ | ✅ | |
| VIEW-02 | Close the viewer (back button, edge swipe, swipe down) and stay in the gallery | ✅ | ✅ | |
| VIEW-03 | Videos play and can be scrubbed; controls clear of the viewer's bars; full screen | ✅ | ✅ | |
| VIEW-04 | Audio plays; audio has its own type filter | ✅ | untested | |
| VIEW-05 | Favorite and 0–5 rating persist and show in the grid | ✅ | ✅ | |
| VIEW-06 | Share or save the original | ✅ | untested | |
| VIEW-07 | Copy the file's path | untested | untested | |
| VIEW-08 | Keyboard shortcuts (←/→, F, 0–5, I, T, Delete, Esc) | untested | untested | iOS: with a hardware keyboard |
| VIEW-09 | An image fits between the viewer's bars, clear of the title and date | ✅ | ✅ | |
| VIEW-10 | A file that changes on disk while open keeps showing as it was (scroll, zoom, playback) until Reload | ✅ | ✅ | |

## Details

| ID | Behavior | Web | iOS | Notes |
| --- | --- | --- | --- | --- |
| INFO-01 | ComfyUI metadata: prompts, sampler parameters, models, LoRAs, raw JSON | ✅ | ✅ | |
| INFO-02 | Training captions: edit, approve, regenerate, accept or discard a candidate, conflicts | ✅ | untested | |
| TAG-01 | Tags: add (new or existing), remove, browse a tag | ✅ | ✅ | |
| TAG-02 | Tags view: rename (merge), delete, hide a tag | untested | untested | |

## Hidden items, trash, documents

| ID | Behavior | Web | iOS | Notes |
| --- | --- | --- | --- | --- |
| HID-01 | Hidden items and libraries leave every list until unlocked with the passphrase; lock again | ✅ | ✅ | |
| TRASH-01 | Move to trash and restore, with favorite and rating intact | ✅ | ✅ | |
| TRASH-02 | Delete permanently, delete all | untested | untested | |
| MD-01 | Markdown documents render with embedded images, videos and Mermaid diagrams | ✅ | untested | Diagrams drawn by Pele, in the app's colors |
| MD-02 | Mermaid diagrams open in a zoomable full-screen view | untested | untested | |
| MD-03 | Videos in a document autoplay with sound when scrolled into view | n/a | untested | iOS only; checked in a browser against the bundled renderer |

## Generate

| ID | Behavior | Web | iOS | Notes |
| --- | --- | --- | --- | --- |
| GEN-01 | Describe, generate tag variations, edit them and generate a batch | ✅ | ✅ | |
| GEN-02 | Tags typed by hand generate images without a description | ✅ | untested | |
| GEN-03 | A run still in progress shows again after a reload | ✅ | untested | |
| GEN-04 | Cancel a running batch | ✅ | untested | |
| GEN-05 | An error when ComfyUI isn't running | ✅ | untested | |
| GEN-06 | LoRA flows: the same form with the LoRA's trigger tags in front | ✅ | untested | |
| GEN-07 | Video flow: an image from the gallery (copied path or picker) to a video | ✅ | ✅ | |
| GEN-08 | Video flow explains a path that isn't a gallery image | ✅ | untested | |

## Dashboard

| ID | Behavior | Web | iOS | Notes |
| --- | --- | --- | --- | --- |
| DASH-01 | ComfyUI queue, GPU readings and GPU workload; follows a run to the gallery | ✅ | ✅ | |
| DASH-02 | Says when ComfyUI is down and recovers on its own | ✅ | untested | |
| DASH-03 | Cancel queued and running jobs | ✅ | ✅ | |
| DASH-04 | Rejects a job id that isn't one | ✅ | n/a | Server behavior |
| DASH-05 | Says the GPU is free (vhotseat mode `none`) when nothing holds it | ✅ | ✅ | |
