# Plan: hidden items

Status: implemented · 2026-10-10

## Goal

Hide individual images and videos. A hidden item is invisible in the gallery and
refused by the API, until the browser is unlocked with a passphrase. An unlock lasts
15 minutes.

## Decisions

- **Per file, from the UI.** There's an eye button in the viewer. The flag is a
  `hidden` column in `assets`, so files can be anywhere and are never touched.
  Like favorite and rating, it follows a file that's moved or renamed (the same
  row is reused), including copy-then-delete moves (`adoptIntoCopy`).
- **Mixed into the normal grid when unlocked**, with a small eye badge.
- **Hide any time, unhide only when unlocked.** A locked browser can't even see the
  item.
- **Passphrase, stored as a scrypt hash** in `hidden.passphraseHash`
  (`npm run hash-passphrase`). Without it, hiding is off and its buttons aren't shown.
- **The unlock is a cookie**, `wg_unlock=<expiry>.<hmac>`, set as HttpOnly,
  SameSite=Strict and Secure over HTTPS, with Max-Age equal to the unlock time.
  A cookie because `<img>`/`<video>` can't send headers. The HMAC key is random
  per process, so a restart locks everything (the easier option). The expiry is
  fixed (no sliding renewal) and enforced on the server.
- **Guessing**: after 5 failed attempts in a row, each further attempt has to wait
  30 s, doubling up to 1 h. A success resets the count.
- **Locked = 404, not 403**, so a locked client can't tell that a hidden id exists.
  Error responses are `no-store`.

## Where it applies (locked)

| | |
| --- | --- |
| `/api/assets` (grid), counts in `/api/libraries`, `/api/folders`, `/api/status` (trash count) | hidden rows filtered out |
| `/api/trash` | filtered out |
| `/api/assets/:id`, `/metadata`, `/raw/*`, `/caption`, `/thumb`, `/preview`, `/file` | 404 |
| favorite, rating, caption, trash, dataset, restore, purge, unhide | 404 |
| folder covers | never a hidden item, even when unlocked |

Search is out of scope for now. When it exists, it filters the same way.

## Caching

Visible thumbnails and previews are `immutable` for a year. For hidden items:

- `v` in the media URL gets an `h` suffix when an item is hidden. So hiding
  changes the URL, and the old long-cached thumbnail URL is no longer used by
  the app.
- Hidden media is sent with `max-age` = the time left on the unlock that fetched
  it (never `immutable`). When the unlock ends, the browser's copies are stale
  too, and refetching gets a 404.

What remains: the old URL's cached copy still exists in the browser's cache
until evicted. The app no longer references it, but someone who knew the old
URL could open it from that browser's cache. This is accepted under the
"browsing" threat model.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/session` | `{csrf, hiddenEnabled, unlockMinutes, unlockedForMs}` |
| POST | `/api/unlock` | `{passphrase}` → session, sets the cookie (403 wrong, 429 waiting) |
| POST | `/api/lock` | clears the cookie |
| POST | `/api/assets/:id/hidden` | `{hidden: boolean}` → asset |

Assets carry `hidden: boolean`.

## Client

- 🔒 in the top bar (only when hiding is set up) opens a sheet with the passphrase
  field, or with the countdown and *Lock now* when unlocked.
- Lists, folders, and counts reload when the lock state changes. A timer relocks
  when the unlock ends, and so does returning to the tab after it expired. A
  hidden item open in the viewer closes on relock.
- Hiding while locked removes the item from the view, the way a delete does.

## Not covered

Access to the files on disk (they aren't encrypted). Dataset move/copy keeps no
hidden state (that feature is going away).
