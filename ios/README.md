# Wandering Gallery for iOS and iPadOS

A native SwiftUI client for the same backend as the web app (`web/`). It talks to the
server's JSON API (`/api/*`) and covers every section of the web app:

- **Gallery**: All media, Favorites, Tags, each library with its folders, and Trash.
  There's a day-grouped thumbnail grid with filters (type, favorites, minimum rating,
  caption status, sort order, subfolders, thumbnail size), filename search, live updates,
  and rescan.
- **Viewer**: swipe between items, pinch and double-tap zoom, swipe down to close, and
  video and audio playback. Markdown documents render with embedded media and Mermaid
  diagrams (tap a diagram to zoom). From the viewer you can favorite, rate, hide or unhide,
  move to trash (asks first), copy the path, share or save the original, and send an image
  to the video flow. On iPad with a keyboard: ← →, F, 0–5, I, Delete and Esc.
- **Details**: tags (pick or create), training captions (edit, approve, regenerate,
  accept or discard a candidate, with conflict checks), ComfyUI metadata, and raw
  prompt and workflow JSON.
- **Hidden items**: unlock with the passphrase, see the countdown, lock early.
- **Generate**: the prompt-to-tags flows (LoRA flows included) and the MiniMax H3 image to
  video flow, with run progress, cancel and reuse.
- **Dashboard**: the ComfyUI queue (cancel jobs), GPU readings and the GPU workload holder,
  refreshed every 3 s while it's open.
- **Settings**: any number of backends. Pick one and the whole app reconnects to it. Each
  backend has a connection test.

The app runs on iPhone and iPad (split view with a sidebar on iPad), on iOS 17 and later.

## Connecting to a server

Add the server in **Settings → Add server**. Use the URL you open in the browser, for example
the Tailscale Serve address `https://my-pc.my-tailnet.ts.net:23334`. The server checks the
`Host` header, so its hostname must be in `server.allowedHosts`.

The app only connects over HTTPS (an address without a scheme gets `https://`). Plain
`http://` is refused, except for `localhost` / `127.0.0.1`, which the simulator uses against
a local dev server.

## Developing

```bash
cd web && npm ci && npm run build
npm run dev:ios              # seeded backend + stand-in ComfyUI on :2399 (--reset to rebuild the data)
```

`npm run dev:ios` runs `web/scripts/ios-dev-backend.ts`. On the first run it generates a
library under `web/.tmp/ios-dev`:

- about 300 ComfyUI images over 30 days, plus videos, audio and Markdown stories
- caption sidecars in every status
- a read-only library and a hidden library
- favorites, ratings, tags (including a hidden tag), hidden items and some trashed items

It then starts the real server on `127.0.0.1:2399`, using the browser tests' stand-ins for ComfyUI, comfy-cli,
danbooru-tagger, vhotseat and nvidia-smi. Generated images show up in the gallery as
they finish. The passphrase for hidden items is `ios dev passphrase`.

The simulator connects to `http://localhost:2399`. For a real iPhone or iPad, put it behind
Tailscale Serve once (the setting persists) and use the HTTPS address:

```bash
tailscale serve --bg --https=23399 http://127.0.0.1:2399
# then https://<machine>.<tailnet>.ts.net:23399 in the app
```

Open `ios/WanderingGallery.xcodeproj` and run. The app also takes the server from the
`WG_SERVER_URL` environment variable (the UI tests use it):

```bash
cd ios
xcodebuild test -project WanderingGallery.xcodeproj -scheme WanderingGallery \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -parallel-testing-enabled NO
```

The unit tests decode API responses captured from the dev backend
(`WanderingGalleryTests/Fixtures`). The UI tests drive the gallery, viewer, tags, trash,
unlock, both generate flows and the dashboard against the dev backend, so start it first.

The project uses folder-synchronized groups, so new files under `WanderingGallery/` are
picked up without editing the project.

### Markdown renderer

Documents are rendered by the web client's own code (`web/src/client/gallery/markdown.ts`,
with Pele drawing the Mermaid diagrams) in a `WKWebView`. The code is bundled into
`WanderingGallery/Resources/Markdown/markdown.js`, which is checked in so Xcode builds
don't need Node. After changing the web's Markdown code or styles, rebuild the bundle:

```bash
cd web && npm run build:ios-markdown
```
