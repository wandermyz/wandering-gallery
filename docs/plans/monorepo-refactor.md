# Plan: from gallery to pipeline monorepo

Status: approved · 2026-10-10

## Goal

Turn this repo from "a gallery" into the home of the whole image/video generation
pipeline. The gallery becomes one section of a larger web app. Image generation
(one page per ComfyUI workflow) and LoRA training get their own sections later.
Non-web components (for example the LoRA tooling) live in their own top-level
folders.

This plan covers only the first step:

1. **Repo reorganization**: move the web app into a subfolder.
2. **App shell**: add a top-level section navigation. The gallery becomes one
   section, and its libraries/favorites/trash become second-level navigation.
   Responsive on desktop and phone.
3. **No regressions** to the gallery, which is in daily use (systemd service
   behind Tailscale, iPhone home-screen app).

Building the generation and training features is out of scope. We only reserve
their place: routes, nav entries, and placeholder pages.

## Current state (relevant facts)

- One npm package at the repo root: Fastify server (`src/server`), Preact client
  (`src/web`), vitest (`test/`), Playwright (`e2e/`, 13 tests × 3 projects:
  desktop, iPhone portrait, iPhone landscape).
- Build output is `dist/server` + `dist/web`. `main.ts` finds the web root at
  `../web` relative to itself, so it doesn't depend on the repo layout.
- The installed systemd unit hard-codes the build output path:
  `WorkingDirectory=…/wandering-gallery`, `ExecStart=… …/dist/server/main.js`.
  It is written by `scripts/install.sh` from `deploy/wandering-gallery.service`.
- Config, DB, trash and thumbnails live in `~/.config`, `~/.local/share` and
  `~/.cache`, outside the repo. Moving code doesn't touch user data.
- The client is a single `App` in `main.tsx` (874 lines). It holds the URL
  router (`/` and `/trash` plus query params), the top bar, the libraries sheet,
  the filter sheet, the grid and the viewer.
- The grid is virtualized against **window scroll**. The viewer is a fixed
  full-screen overlay that uses `history.state.viewer` for back-button closing.
  Any layout change must keep window scrolling, or the grid needs rework.
- The server already falls back to `index.html` for any non-`/api`, non-`/assets`
  GET, so new client routes need no server change.

## 1. New folder structure

```
wandering-gallery/                  (repo; rename is an open question, see end)
├── README.md                       umbrella: what's here, how the parts fit, install
├── LICENSE
├── docs/
│   └── plans/                      this file and later plans
├── scripts/
│   └── install.sh                  stays at the root (same upgrade command as today);
│                                   builds web/ and installs the unit(s)
├── deploy/
│   └── wandering-gallery.service   repo-level: later also trainer/ComfyUI units
├── web/                            ← everything that is the Node web app today
│   ├── README.md                   gallery/web docs (most of today's README)
│   ├── package.json, package-lock.json
│   ├── tsconfig*.json, vite.config.ts, vitest.config.ts, playwright.config.ts
│   ├── config.example.yaml
│   ├── scripts/smoke.mjs
│   ├── src/
│   │   ├── server/                 unchanged in this refactor
│   │   └── client/                 renamed from src/web (avoids web/src/web)
│   ├── test/                       vitest + fixtures, unchanged
│   └── e2e/                        Playwright
├── lora/                           wandering-lora, copied in (no history), Python/uv
└── comfyui/                        (later) workflow templates (API JSON) used by
                                    the Generate pages, custom-node notes
```

Decisions:

- **One subfolder, `web/`, for the whole Node app (server and client).** They
  ship together as one process and share a build. Splitting them into packages
  would add workspace plumbing with no benefit yet.
- **No root `package.json` / npm workspaces for now.** Each top-level component
  keeps its own toolchain (npm in `web/`, uv in `lora/`). We can add a workspace
  later if a second JS package appears.
- **`src/web` → `src/client`.** This is a mechanical rename in its own commit.
  The build output stays at `dist/web`, so `main.ts` and the unit are unaffected
  by it.
- **Install entry point stays at `scripts/install.sh`**, so the documented
  upgrade (`git pull && ./scripts/install.sh`) keeps working through the move.
  The script `cd`s into `web/` for `npm ci` / `npm run build` and writes the unit
  with `@APP_DIR@ = <repo>/web`.
- **Gallery API stays at `/api/*` unchanged.** New features get namespaced
  routes (`/api/generate/*`, `/api/train/*`). The server code isn't reorganized
  in this step. When generation arrives, it becomes `src/server/generate/…`
  next to the gallery modules.
- `.gitignore` patterns are unanchored (`dist/`, `.tmp/`, `test-results/` …),
  so they keep matching inside `web/`. Nothing to change there.

## 2. Web UI: app shell and layout

### Sections and routes

| Section | Path | Second level |
| --- | --- | --- |
| Gallery | `/gallery` | All media, Favorites, each library, Trash (`/gallery/trash`), Rescan |
| Generate | `/generate`, `/generate/<workflow-id>` | one entry per ComfyUI workflow (placeholder now) |
| Train | `/train`, `/train/<dataset>` | datasets, runs (placeholder now) |

- Each section owns everything below its path segment, plus its query string.
  The gallery keeps its current query parameters exactly (`lib`, `folder`,
  `fav`, `rating`, `kind`, `cap`, `order`, `flat`, `a`).
- **Legacy URLs keep working.** On load, `/` and `/?…` are rewritten
  (`replaceState`) to `/gallery?…`, and `/trash` to `/gallery/trash`. Existing
  bookmarks, the home-screen app (`start_url: "/"`), and deep links to an open
  asset (`?a=123`) still land in the same place.
- Router: a small in-house router (~50 lines, same style as today's
  `useRoute`). It picks the section from the first path segment and passes the
  rest to the section. No new dependency.
- Sections other than the gallery are **lazy-loaded** with `import()`, so the
  gallery bundle (24 KB gzipped today) doesn't grow as features are added.

### Desktop (≥ 900 px wide)

```
┌──────┬──────────────────────────────────────────────────────────────┐
│  ▦   │ ☰  Test Library                                  ♥   ⚙       │  ← existing top bar,
│Gallery│    1,234 items · indexing 3                                  │    now offset by the rail
│      ├──────────────────────────────────────────────────────────────┤
│  ✦   │  portraits  video  …                                         │
│Generate│ ── Today ──────────────────────────────────────────────────  │
│      │  ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢                                             │
│  ◎   │  ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢           (window-scrolled grid, unchanged)  │
│ Train │                                                             │
│      │                                                              │
└──────┴──────────────────────────────────────────────────────────────┘
 72 px fixed nav rail (icon + label), active section highlighted
```

- A fixed **left nav rail** for sections. The page content gets a matching
  `padding-left`, so the document still scrolls on the window and the grid's
  virtualization code is untouched (`ResizeObserver` already handles the
  narrower width).
- The gallery's second level stays where it is: the ☰ button opens the
  existing "Libraries" sheet. A follow-up (not in this step) can dock that list
  as a persistent sidebar at ≥ 1280 px.
- The viewer stays a full-screen overlay covering the rail, as it does today.
- Fixed elements that center on the viewport (toasts, the "New items ↑" pill)
  are re-centered on the content area.

### Phone (< 900 px, portrait and landscape)

```
 ┌──────────────────────────┐        ┌──────────────────────────┐
 │ ☰  All media       ♥  ⚙  │        │ ▦ Gallery  ✦ Generate  ◎ Train │ ← section switcher
 │    1,234 items           │  ☰ →   │ ──────────────────────── │
 │ ── Today ─────────────── │        │ ▦  All media      1,234  │
 │ ▢ ▢ ▢                    │        │ ♥  Favorites             │
 │ ▢ ▢ ▢                    │        │ LIBRARIES                │
 │ ▢ ▢ ▢                    │        │ 📁 ComfyUI Outputs   980 │
 │                          │        │ …                        │
 └──────────────────────────┘        │ 🗑 Trash   ⟳ Rescan       │
   no extra chrome                   └──────────────────────────┘
```

- **No bottom tab bar.** On a phone the gallery is the main use, and a tab bar
  costs ~83 px of height in portrait and is worse in landscape (~390 px total
  height). The switcher goes in the drawer you already open with ☰: a
  segmented control (Gallery / Generate / Train) at the top, then the current
  section's second-level nav below it, exactly as today for the gallery.
- Every section uses the same pattern: top bar with ☰, title, section actions,
  and a drawer with the switcher plus that section's nav. One mental model on
  both form factors.
- If the Generate/Train sections later become things you use often on the
  phone, we can revisit a bottom bar. The shell keeps nav rendering in one
  component, so that change stays small.

### Future section layouts (direction only, not built now)

- **Generate / `<workflow>`**: desktop is two columns, a parameter form
  (prompt, seed, size, LoRAs; fields come from the workflow's declared inputs)
  on the left and a results strip on the right. Phone stacks them, with a
  sticky "Generate" button. Results reuse the gallery's grid and viewer, scoped
  to that workflow's output folder.
- **Train / `<dataset>`**: a dataset grid with caption status (reusing the
  gallery grid with the dataset folder as the scope) plus a runs tab (config,
  live log, sample images).
- Both need the grid and viewer to be reusable outside `App`. That extraction
  is listed under step 3 below as an optional follow-up, not a requirement of
  this refactor.

### Client code layout after the refactor

```
web/src/client/
├── main.tsx                 render(<Shell />)
├── shell/
│   ├── Shell.tsx            rail (desktop) / drawer switcher (phone), section outlet
│   ├── router.ts            section from path, legacy URL rewrite, nav helpers
│   └── sections.ts          registry: id, label, icon, path, lazy loader
├── gallery/
│   ├── GalleryApp.tsx       today's App minus the outer shell concerns
│   ├── Grid.tsx, Viewer.tsx, InfoPanel.tsx
│   └── api.ts               gallery endpoints
├── generate/GenerateApp.tsx placeholder ("coming soon" + workflow list stub)
├── train/TrainApp.tsx       placeholder
├── common/
│   ├── ui.tsx, util.ts      shared (Sheet, IconButton, Toasts, …)
│   └── http.ts              fetch + CSRF token handling, split out of api.ts
└── styles/                  base.css, shell.css, gallery.css (split from styles.css)
```

The gallery's drawer content (libraries list) stays inside `gallery/`. The
shell renders the section switcher above whatever "nav" the active section
provides, through a small slot/prop contract.

## 3. Execution order (one reviewable commit each)

| # | Step | Behavior change |
| --- | --- | --- |
| 0 | Capture baseline (see Verification). Nothing committed except, optionally, the screenshot script. | none |
| 1 | `git mv` the app into `web/`, fix `install.sh` paths, move the gallery README to `web/README.md`, write a short root README. | none (deploy path changes) |
| 2 | Redeploy from the new layout and verify the live service. | none |
| 3 | `src/web` → `src/client`, then split client files into `gallery/`, `common/`, `styles/`. Pure moves plus import path fixes. | none |
| 4 | Add the shell, router, sections registry and legacy URL rewrites. Gallery mounts at `/gallery`. | new nav; URLs gain `/gallery` |
| 5 | Placeholder Generate and Train sections, lazy-loaded. | new pages |
| 5b | Copy wandering-lora into `lora/` (without `.venv`, caches, `.git`). | none for the web app |
| 6 | (Optional, can move to the Generate plan) Extract a reusable `AssetBrowser` (grid + viewer + info, driven by a `Query`) from `GalleryApp`. | none |

Steps 1–3 are refactors with no behavior change, and the verification below
holds them to that. Steps 4–5 are the only ones that change behavior.

## 4. Verification: proving there is no gallery regression

### Baseline (before step 1)

1. `npm run typecheck`, `npm test`, `npm run build && npm run test:e2e`. Record
   pass counts per project and save the log in `.tmp/baseline/`.
2. Record build artifacts: `sha256sum` of every file in `dist/server` and
   `dist/web`, plus the gzipped bundle sizes.
3. Baseline screenshots from a small Playwright script against the e2e fixture
   server, on desktop / iPhone / iPhone landscape: grid (All media), library
   with folder chips, Libraries sheet, filter sheet, viewer, viewer with the
   info panel, caption section, Add-to-dataset dialog, and Trash. Day headers
   depend on the clock, so they're masked.
4. A read-only snapshot of the live DB through a copy: asset count, favorites
   count, ratings histogram, trash count. Also `smoke.mjs` against the live
   Tailscale URL.

### Steps 1–3 (pure refactors): must be indistinguishable

- `git diff -M --stat` for step 1 shows only renames (100% similarity), except
  the config/script files that are expected to change, and the docs.
- Same typecheck / vitest / e2e results as the baseline, all three projects.
  No test is edited in steps 1–2 except for paths. Step 3 may change only
  import paths.
- **Build output is byte-identical to the baseline** for `dist/server` (step 1)
  and `dist/web` (steps 1–3, apart from Vite chunk hashes if module IDs
  change). Any non-path difference has to be explained before moving on.
- Screenshots match the baseline pixel for pixel (excluding masked areas).

### Step 2: live deployment migration

- After `git pull && ./scripts/install.sh`, the installed unit has
  `WorkingDirectory=…/web` and `ExecStart … web/dist/server/main.js`, and the
  service is `active`. No stale `dist/` at the repo root is used: delete it and
  check that the service still serves.
- Config path, `dataDir` and `cacheDir` are unchanged. The DB snapshot counts
  from the baseline match, and thumbnails are served from cache (no
  regeneration storm in `journalctl`).
- `node web/scripts/smoke.mjs https://<host>:23334` passes on both profiles.

### Steps 4–5 (shell + routes)

- **The existing e2e suite passes unmodified.** Its `goto('/')`,
  `goto('/?fav=1')` and `goto('/trash')` calls now go through the legacy
  rewrite, so they test backward compatibility for free. Assertions on
  `.topbar h1`, the `Libraries` button, `.lib-item`, `folder=` in the URL,
  viewer, info panel and trash still hold.
- New e2e tests (all three projects):
  - legacy URLs (`/`, `/?lib=lib&folder=portraits`, `/?a=<id>`, `/trash`)
    land on the same view under `/gallery…`;
  - desktop shows the rail, phones don't, and the phone drawer shows the
    section switcher;
  - switching to Generate and back restores the same gallery view (URL state
    is kept), and the back button walks section changes;
  - viewer open → back button closes the viewer and stays in the gallery
    (the `history.state.viewer` logic still works under the new path);
  - keyboard shortcuts (`F`, `0`–`5`, `Delete`, arrows) work in the gallery and
    are inactive on other sections;
  - nothing scrolls horizontally at 320 px and 1366 px wide, and the safe-area
    insets are applied in landscape.
- Screenshot comparison against the baseline. Phone screenshots should be
  identical except inside the open drawer. Desktop screenshots differ only by
  the rail and the content offset, which I'll review by eye.
- Bundle check: the gallery's initial JS grows by no more than ~3 KB gzipped,
  and Generate/Train are separate chunks.
- On your real iPhone (Playwright only emulates it): home-screen app opens
  into the gallery, swipe/pinch/back work, the notch and home indicator are
  respected, and the drawer switcher is reachable. I'll give you a short
  checklist when we get there.

## Decisions (2026-10-10)

1. **No rename.** The repo stays `wandering-gallery`, as do the systemd unit and
   the config/data/cache paths.
2. **wandering-lora is imported as a plain copy** into `lora/` (no subtree, no
   history). It gets cleaned up separately later.
3. **The app always opens on Gallery.**
4. **Phone navigation uses the drawer switcher**, with no bottom tab bar.
5. **The app title stays "Gallery"** (browser tab, home-screen name) for now.
