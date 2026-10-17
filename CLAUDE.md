# wandering-gallery

A self-hosted gallery and generation app for a local ComfyUI pipeline, with two clients on one
backend:

- `web/`: the Node.js server (Fastify, SQLite) and the web app (Preact). See `web/README.md`.
- `ios/`: the native iPhone/iPad app (SwiftUI), a client of the same `/api/*`. See `ios/README.md`.
- `lora/`, `comfyui/`, `deploy/`, `scripts/`, `docs/`: dataset tooling, workflows, service, plans.

## Feature parity between web and iOS

Both clients must offer the same features. A user-facing feature is done when it works in
both, or when the missing side is recorded as `pending` in `docs/parity.md`, never silently
skipped.

### Workflow for a feature

1. **Web first.** Build the feature in `web/` (server and web client) with its tests:
   `npm test`, and a Playwright test (`web/e2e/`) for user-visible behavior.
2. **Build and serve the web** so the user can try it before iOS starts:
   - On the Mac mini (where the iOS work also happens): `cd web && npm run build`, then restart
     the dev backend, detached so it outlives the session:
     `pkill -f ios-dev-backend; nohup npm run dev:ios > /tmp/iosdev.log 2>&1 < /dev/null &`.
     It serves the built web app at `https://<machine>.<tailnet>.ts.net:23399` (Tailscale Serve)
     and `http://localhost:2399`.
   - On a machine with the installed service: `./scripts/install.sh` (builds and restarts it).
   - If something blocks this (build or tests fail, the server won't start, a decision is
     needed), **stop and tell the user** instead of moving on to iOS.
3. **Tell the user the web is ready.** If you're running under yuki-conductor (the
   `yuki-conductor-send` skill is available), send a push message with what changed and the
   URL to try. Then move on to iOS.
4. **iOS.** Build the same feature in `ios/`, with tests (`ios/WanderingGalleryUITests` for
   user-visible behavior), run them against the dev backend, and publish a build for the
   user's devices if the `ios-publish` skill is available
   (`ios-dist.sh publish wandering-gallery --method debugging --notes "…"`).
5. **Update `docs/parity.md`** in the same change: a new ID for each new behavior, its status on
   each side, and a `// parity: ID` comment on the tests that cover it. `npm test` fails when
   the file and the tags disagree.

### When iOS can't be built here (Linux, Windows)

Xcode and the iOS simulator only run on macOS. Do steps 1–3, then in `docs/parity.md` set the
feature's iOS status to `pending` with a note saying what's left, e.g.
`web done on Linux 2026-10-20; iOS: new "Rename" action in the viewer, API field asset.title`.
If the API changed, also update the contract fixtures (below) so the Mac sees exactly what
moved. On the Mac, `cd web && npm run parity` lists what's pending; catch up on those first.

## The API contract

The iOS app decodes the server's JSON with its own models (`ios/WanderingGallery/API/Models.swift`).

- **Additive changes only:** add fields and endpoints; don't rename, remove or retype
  fields. Phones update later than the server, so an older app must keep working.
- After changing any response, run `cd web && npm run test:contract`. It starts a seeded
  backend, calls every endpoint the app uses and compares each response's structure with the
  fixtures in `ios/WanderingGalleryTests/Fixtures`. If it reports a change, run it with
  `-- --update`, then make the iOS models decode the new fixtures (the iOS unit tests decode
  every fixture and fail on any fixture they don't know). On Linux/Windows, update the
  fixtures and record the iOS model work as pending.
- A new endpoint for the app: add its call to `web/scripts/api-contract.ts`, so it gets a
  fixture and a decoding test.
- Prefer putting logic in the server (filtering, labels, summaries) over writing it twice in
  the clients. The iOS Markdown renderer reuses the web's code
  (`cd web && npm run build:ios-markdown` after changing it).

## Commands

```bash
cd web
npm test                      # unit/API tests + the parity check
npm run test:e2e              # Playwright browser tests
npm run test:contract         # API responses vs the iOS fixtures (needs ffmpeg)
npm run parity                # parity summary and what's pending
npm run dev:ios               # seeded backend + stand-in ComfyUI on :2399 (data in .tmp/ios-dev)

cd ios                        # macOS only
xcodebuild test -project WanderingGallery.xcodeproj -scheme WanderingGallery \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -parallel-testing-enabled NO
```

The iOS UI tests need the dev backend running on :2399.
