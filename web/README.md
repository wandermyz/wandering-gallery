# wandering-gallery

A lightweight, mobile-first gallery for AI-generated images and videos, built
for browsing and organizing [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
output on your own machine.

- **Photo-app feel**: dark theme, virtualized thumbnail grid grouped by day,
  full-screen viewer with swipe, pinch-zoom, double-tap zoom, and keyboard
  navigation. Works in iPhone Safari (portrait and landscape) and desktop browsers.
- **ComfyUI-aware**: reads the embedded `prompt` (API graph) and `workflow`
  from PNG, WebP, AVIF, MP4/MOV/WebM, and shows prompts, seed, sampler,
  scheduler, steps, CFG, models, and LoRAs. You can copy prompts and open the
  raw JSON.
- **Favorites, 0–5 star ratings and tags**, with filters. These are stored only
  in SQLite and never written into your files.
- **Safe delete**: deleted files move to a trash folder and can be restored
  for 7 days, with their rating and metadata intact.
- **Live**: newly generated files show up within seconds without a reload.
  Files that are still being written are ignored until they're complete.
- **Light on resources**: one Node.js process, background indexing at low
  priority, and thumbnails cached on disk.

## How it works

```
 Browser ──HTTPS──▶ Tailscale Serve ──▶ 127.0.0.1:2334  wandering-gallery (Node.js)
                                                ├── watches + scans library folders (read-only)
                                                ├── SQLite: index, ratings, favorites, metadata
                                                ├── thumbnail cache (sharp / ffmpeg)
                                                └── trash folder (moves only on explicit delete)
```

- **Server**: Fastify + TypeScript, `node:sqlite`, `sharp` for image
  thumbnails, `ffmpeg`/`ffprobe` for video, `chokidar` for file watching.
- **Frontend**: Preact + Vite, about 21 KB gzipped, with no UI framework.

The filesystem is the source of truth. Assets are identified by path, and also
by a content fingerprint (size plus a hash of the first and last 64 KB). The
fingerprint means a renamed or moved file keeps its rating. A *different* file
saved under an old name gets a fresh entry and doesn't inherit the old rating.

## Requirements

- Linux with systemd (user services), Node.js **≥ 22.13** (uses the built-in
  `node:sqlite`).
- `ffmpeg` and `ffprobe` on the PATH or configured in the config file (only
  needed for video thumbnails and video metadata).
- For the Generate section: a running ComfyUI and
  [comfy-cli](https://github.com/Comfy-Org/comfy-cli) on the PATH.

## Install

```bash
git clone https://github.com/wandermyz/wandering-gallery.git
cd wandering-gallery      # the repo root, not web/
./scripts/install.sh      # first run creates ~/.config/wandering-gallery/config.yaml
$EDITOR ~/.config/wandering-gallery/config.yaml
./scripts/install.sh      # builds, installs and starts the service
```

The installer:

1. runs `npm ci` and `npm run build`
2. writes `~/.config/systemd/user/wandering-gallery.service`
3. enables and (re)starts it

It doesn't need root. To start the service at boot, before anyone logs in,
enable lingering once:

```bash
sudo loginctl enable-linger "$USER"
```

## Configuration

`~/.config/wandering-gallery/config.yaml` (see
[`config.example.yaml`](config.example.yaml) for every option):

```yaml
server:
  host: 127.0.0.1
  port: 2334
  allowedHosts:
    - my-pc.my-tailnet.ts.net    # the hostname you open in the browser

libraries:
  - id: comfyui
    name: ComfyUI Outputs
    path: ~/ComfyUI/output
    recursive: true
    writable: true               # allow "move to trash"
  - id: refs
    name: References
    path: /data/refs
    recursive: true
    writable: false              # browse/rate only
    showInAll: false             # only shown when the library is opened directly

trash:
  retentionDays: 7

```

| Location | Contents |
| --- | --- |
| `~/.config/wandering-gallery/config.yaml` | configuration |
| `~/.local/share/wandering-gallery/gallery.db` | SQLite: index, favorites, ratings, metadata |
| `~/.local/share/wandering-gallery/trash/` | deleted files (until restored or expired) |
| `~/.cache/wandering-gallery/thumbs/` | thumbnails and previews (safe to delete) |

Restart the service after editing the config.

## Operating the service

```bash
systemctl --user status wandering-gallery      # status
systemctl --user restart wandering-gallery     # restart (e.g. after config changes)
systemctl --user stop wandering-gallery        # stop
systemctl --user start wandering-gallery       # start
journalctl --user -u wandering-gallery -f      # follow logs
journalctl --user -u wandering-gallery -n 200  # recent logs
```

**Upgrade:**

```bash
cd ~/Projects/wandering-gallery && git pull && ./scripts/install.sh
```

The database schema is migrated automatically on startup.

**Uninstall:** `systemctl --user disable --now wandering-gallery`, then remove
the unit file and the data/cache directories listed above. Your media folders
are never touched.

## Private access with Tailscale

The app listens only on `127.0.0.1`. To reach it from your phone, put it
behind [Tailscale Serve](https://tailscale.com/kb/1312/serve) (HTTPS, tailnet
only). Use a dedicated HTTPS port so you don't disturb other services:

```bash
tailscale serve status                                   # check what is already in use
tailscale serve --bg --https=23334 http://127.0.0.1:2334
```

Then open `https://<machine>.<tailnet>.ts.net:23334` and add that hostname to
`server.allowedHosts`. Don't use `tailscale funnel`, which would expose the
gallery to the internet. To remove the route:
`tailscale serve --https=23334 off`.

On iPhone, use **Share → Add to Home Screen** for a full-screen, app-like
experience.

## Using it

| | Phone | Desktop |
| --- | --- | --- |
| Open item | tap | click |
| Next / previous | swipe left / right | ← / → |
| Zoom | pinch, double-tap | scroll wheel, `+` / `-` |
| Close viewer | swipe down, back button | `Esc` |
| Favorite | ♥ button | `F` |
| Rate | tap a star (tap again to clear) | `0`–`5` |
| Add a tag | ⓘ → *Tags* | `T` |
| Details / metadata | ⓘ button | `I` |
| Hide / unhide | eye button (when hiding is set up) | — |
| Move to trash | 🗑 button (asks first) | `Delete` (asks first) |
| Hide controls | single tap | — |

The app has sections: *Gallery*, and placeholders for *Generate* (ComfyUI
workflows) and *Train* (LoRA training). On desktop they're in a rail on the left. On
phones they're at the top of the ☰ drawer. The gallery lives under `/gallery`. Old
links (`/`, `/?lib=…`, `/trash`) are redirected there.

The ☰ menu switches between *All media*, *Favorites*, each library, and
*Trash*, and can trigger a rescan. The filter button sets the media type,
favorites only, minimum rating, sort order, whether subfolders are included,
and thumbnail size. The view state lives in the URL, so the browser's back
button and bookmarks work.

### Tags

The details panel (ⓘ, or `T` to jump straight to the input) has a *Tags*
section. Type to filter the existing tags and pick one, or create a new one
with *Create “…”* or Enter. Tags are case-insensitive: "Sunset" and "sunset" are
the same tag, and it keeps the spelling it was created with. Tap a tag's ×
to remove it, or its name to see everything with that tag.

*Tags* in the ☰ menu lists every tag with a cover image and a count. Open one to
browse its images across all libraries, including those with
`showInAll: false`; the usual filters still apply. You can also rename a tag
there (renaming it to an existing tag merges the two) or delete it. Tags live
only in SQLite. They stay with a file when it's renamed, moved or trashed and
restored, and go away when it's permanently deleted.

### Hidden items

Individual images and videos can be hidden with the eye button in the viewer.
Hidden items are left out of every list (grid, counts, trash), never used as
a folder cover, and the server answers `404` for them (details, metadata,
thumbnail, file) unless the browser is unlocked.

To set it up, hash a passphrase and add it to the config:

```bash
cd web && npm run hash-passphrase     # prompts twice, prints the hash
```

```yaml
hidden:
  passphraseHash: scrypt:32768:8:1:...   # from npm run hash-passphrase
  unlockMinutes: 15                      # optional, default 15
```

The 🔒 button in the top bar then asks for the passphrase. Unlocking shows hidden
items, with a small eye badge, mixed into the normal grid in that browser for
15 minutes. It's a fixed time from unlocking, and the button shows the
countdown and can lock again early. The unlock is an `HttpOnly` cookie signed
with a key that only lives in memory, so restarting the server locks every
browser. Hiding works while locked, but unhiding needs an unlock. The flag lives
in SQLite, so files stay where they are, and it follows a file that's moved
or renamed. After five wrong passphrases in a row, each further attempt
waits, and the wait doubles each time.

Thumbnails of visible items are cached by the browser for a long time. A hidden
item's thumbnail URL is different, and its media is only cacheable until the
unlock that loaded it expires. So after relocking, the browser has nothing
left to show it from. This protects against someone browsing the gallery, not
against someone with access to the files on disk.

### Training captions

Images can carry caption sidecars, as written by
[wandering-lora](https://github.com/wandermyz/wandering-lora): `<stem>.txt` holds
the training caption and `<stem>.caption.json` its status (`generated`,
`edited`, `approved`, `needs_regen`), description, classification, model output,
and an optional candidate caption. When an image has sidecars, the details panel
shows a *Caption* section where you can edit, approve, mark for regeneration,
or accept or discard a candidate. In a writable library, edits go straight to
the sidecar files. Writes are atomic, keep unknown JSON keys, and are refused
with a conflict if either file changed since you opened it. Grid thumbnails get
a small status dot, and the filter sheet can filter by caption status. The
files are the source of truth. SQLite only caches them for filtering, and
re-reads them whenever their size, mtime, or inode changes. Sidecars are never
listed as media, and they move to the trash and back together with their
image.

### Generating images

*Generate → WAI-Illustrious · prompt to tags* turns a description (Chinese or
English) into Danbooru tags with Qwen inside ComfyUI, then renders them with
WAI-Illustrious:

1. Type the description and choose how many **tag variations** you want, then
   *Generate tags*. Variation 1 follows the description; the others ask for a
   distinct-looking character (random suggested traits, sampling on).
2. Edit any variation's tags, regenerate or remove single ones.
3. Choose **images per variation** and *Generate*. Every variation × image is a
   ComfyUI job with its own random seed. Progress and finished images show under
   *Runs*; tapping one opens it in the gallery viewer, and *Reuse* puts a run's
   description and tags back into the form.

Nothing is kept: a reload starts with an empty form and only shows runs that are
still being worked on. Finished images are in the gallery.

Each PNG carries the UI workflow, the source description and the tags, so it can
be dragged back into ComfyUI.

ComfyUI is driven through `comfy-cli` (`run`, `jobs status/watch/cancel`,
`system-stats`); only the image jobs are posted to ComfyUI's `/prompt` directly,
because `comfy-cli run` can't attach that PNG metadata. If ComfyUI isn't running,
the page says so; the app never starts it.

The workflow graphs are in `comfyui/workflows/` with every prompt blanked. The
prompt texts are local only, in
`~/.config/wandering-gallery/prompts/wai-illustrious-tags.yaml`:

```yaml
systemPrompt: |-          # tagger system prompt (Qwen)
  ...
variationInstruction: |-  # appended for variations 2..N
  ...
traits:                   # one random entry per list is suggested to variations 2..N
  - [<hair color>, <hair color>, ...]
  - [<eye color>, <eye color>, ...]
qualityTags: ...          # put in front of the tags
negativePrompt: ...
```

The file is read on every request, so edits apply without a restart. Settings
(all optional) go under `generate:` in the config:

```yaml
generate:
  comfyui: http://127.0.0.1:8188   # ComfyUI server
  comfyCli: comfy-cli              # comfy-cli executable
  outputLibrary: comfyui           # library holding ComfyUI's output folder
  promptsDir: ~/.config/wandering-gallery/prompts
```

## Supported formats

| | Formats | Notes |
| --- | --- | --- |
| Images | PNG, JPEG, WebP, GIF (incl. animated), AVIF | Very large images and AVIF get a 2048px preview in the viewer; the original is one tap away. |
| Videos | MP4/M4V, WebM, MOV | Played natively, never transcoded. H.264/VP9/AV1 play everywhere; HEVC only where the browser supports it. Unsupported codecs show an explanation and a download button. |

**Generation metadata**

- ComfyUI PNG `tEXt`/`iTXt`/`zTXt` chunks: `prompt` (API graph) and
  `workflow` (editor graph).
- ComfyUI WebP/AVIF EXIF (`prompt:{…}`, `workflow:{…}` tags).
- ComfyUI `SaveVideo` and VideoHelperSuite MP4/WebM tags.
- A1111/Forge `parameters` text (PNG) and EXIF UserComment (JPEG/WebP).

Interpretation is best-effort and doesn't assume a fixed graph shape. It walks
the API graph from each sampler (`KSampler`, `KSamplerAdvanced`,
`SamplerCustom(Advanced)` and similar custom nodes) back through conditioning,
ControlNet, and primitive nodes to find the prompts and settings. Loader nodes
give the checkpoint, UNet, VAE, CLIP, ControlNet, and LoRA names (including
rgthree and stacker-style LoRA nodes). If a graph can't be interpreted, the
raw `prompt`/`workflow` JSON is still stored and shown.

## Safety model

- **Read-only by default.** Original files are opened for reading only.
  Indexing, thumbnails, favorites, and ratings never write to them. The only
  time a file moves is an explicit, confirmed delete. It's moved (`rename`)
  into the trash folder and moved back on restore.
- **Strict path confinement.** API requests refer to assets by numeric ID,
  never by path. Every file access is resolved with `realpath` and checked to
  be inside its library. Symlinks that point outside a library are ignored,
  and symlinked directories aren't followed.
- **Writable flag.** Deleting from a library with `writable: false`, or editing
  a caption there, is rejected by the server, not just hidden in the UI.
  Caption sidecars (`.txt`, `.caption.json`) are the only files the gallery
  ever writes inside a library.
- **Files being generated.** ComfyUI writes images directly to their final
  name, and video muxers write the index last. A file is only indexed or
  deletable once its size and mtime have been stable for `stableSeconds` *and*
  its structure is complete (PNG `IEND`, JPEG EOI, complete MP4/MOV boxes, and
  so on). A delete is also refused if the file changed since the UI last saw
  it.
- **Request protection.** The app binds to localhost. A Host header allowlist
  blocks DNS rebinding. State-changing requests need a per-process CSRF token
  in a custom header, and a same-origin `Origin`.
- **No shell.** `ffmpeg`/`ffprobe` are spawned with argument arrays and
  absolute paths, with timeouts and output caps. Metadata is displayed as
  text, never as HTML.
- **Being a good neighbour to ComfyUI.** The service runs at `Nice=15` with
  idle-class I/O and a 2 GB memory cap. Thumbnailing is single-threaded with
  at most two jobs at once, and indexing backs off when the system load is
  high. File watching is event-based (inotify) with debouncing, plus an hourly
  safety-net rescan.

## Development

Everything below runs inside `web/`.

```bash
cd web
npm install
npm run dev:server -- --config ./dev-config.yaml   # API on the configured port (default 2334)
npm run dev:web                                    # Vite on :5173, proxies /api to 2334
npm run typecheck
npm test                                           # unit + integration tests (vitest)
npm run build && npm run test:e2e                  # browser tests (Playwright; desktop + iPhone viewports)
node scripts/smoke.mjs https://host:port           # quick check against a running instance
node scripts/screenshots.mjs shoot <url> <dir>     # fixed screenshot set (desktop + iPhone)
node scripts/screenshots.mjs diff <dirA> <dirB>    # pixel-compare two screenshot sets
```

The browser tests use the system Chrome (`channel: chrome`) and emulate the
iPhone viewport, touch input, and DPR in Chromium. Set `PW_IPHONE_WEBKIT=1`
to run those projects in Playwright's WebKit instead (needs
`npx playwright install-deps webkit`).

Test fixtures in [`test/fixtures/comfyui`](test/fixtures/comfyui) cover
SDXL, ControlNet + chained LoRAs, Flux (`SamplerCustomAdvanced` with linked
primitives and rgthree LoRAs), Wan 2.2 video, an editor-only workflow with a
bypassed node, and a graph made only of unknown custom nodes. Media files for
the tests are generated on the fly, with metadata embedded the same way
ComfyUI does it.

## Limitations and ideas

- There's no metadata search UI yet. Prompt and model text is already indexed
  in SQLite (`metadata.search_text`), ready for one.
- There are no batch operations (by design for now).
- The editor-workflow fallback (no API prompt) knows the widget layout of core
  nodes only. Custom-node parameters are shown in the raw JSON.
- HEVC/ProRes videos play only in browsers that support them (Safari usually
  does). Nothing is transcoded.
- Thumbnails come from the first frame (or 1 s in) for videos, and from the
  first frame for animated images.
- Single user, no accounts. Access control is your tailnet.

## License

MIT
