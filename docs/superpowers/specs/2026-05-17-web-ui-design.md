# file_worker — Web UI Design

Status: approved 2026-05-17
Owner: Shuhao Li
Supersedes: nothing (extends `2026-05-16-file-worker-design.md`)

## Goal

Ship a browser UI from the same Cloudflare Worker so you can send/receive files
without the Python CLI handy (laptop, friend's machine, a phone tab). The UI
covers the full send path including folder upload (zipped client-side) and the
full receive path with a friendly landing page.

The Python client and the existing wire protocol are unchanged; the UI is a
second consumer of the same JSON endpoints, plus one tiny new endpoint
(`/meta/:id`) the landing page uses.

Non-goals: multi-user accounts, upload history, manual revocation, in-browser
preview, pause/resume, anything resembling a Dropbox/Drive replacement.

## Architecture summary (Approach A)

- **Workers Static Assets** binding ships HTML/CSS/JS from `public/`.
  Wrangler-served, edge-cached, no build step.
- Two HTML pages, no SPA router:
  - `public/index.html` + `public/upload.js` → upload form at `/`.
  - `public/recv.html` + `public/recv.js` → download landing page, returned
    by the worker when a browser hits `/d/:id`.
- One new worker endpoint, `GET /meta/:id`, returns the same R2 custom
  metadata as JSON so the landing page can render filename/size/expiry before
  the user clicks Download.
- `fflate` (zip lib, ~25 KB gzipped) imported by `upload.js` via jsdelivr ESM:
  `import { zipSync } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/index.mjs"`.
  No npm dependency, no bundler. Folder upload degrades to a clear error if
  jsdelivr is blocked (single-file upload still works).
- Worker bytes API (`/upload`, `/mpu/*`, `/d/:id`) unchanged in shape; only
  `/d/:id` gains a top-of-handler branch on `Accept` and `?dl=1`.
- The legacy `FRAGMENT_SHIM` constant is removed — `recv.html` subsumes its
  role.

## Wrangler config delta

```toml
[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "none"
```

`not_found_handling = "none"` is critical: unknown paths fall through to the
worker so `/d/:id`, `/meta/:id`, etc. still route correctly. The default
`"single-page-application"` would shadow them.

## Routing

| Method & Path                  | Handled by         | Behavior |
|--------------------------------|--------------------|----------|
| `GET /`, `/upload.js`, `/recv.html`, `/recv.js`, `/styles.css`, `/favicon.ico` | Static Assets (auto) | Plain static serve from `public/` with edge caching headers |
| `GET /d/:id`                   | Worker             | If `Accept: text/html` **and** no `?dl=1`: `env.ASSETS.fetch(new URL("/recv.html", req.url))` re-emitted. Otherwise: existing direct-stream path (auth via token if private). |
| `GET /meta/:id[?t=<token>]`    | Worker (**new**)   | Same auth gating as download. Returns JSON `{id, expires_at, original_name, is_dir, size, visibility, content_type}`. 404 for missing/expired (with `waitUntil` delete), 403 for bad token. |
| `POST /upload`, `POST /mpu/*`, `PUT /mpu/part` | Worker | Unchanged. |
| Anything else                  | Worker → 404       | Unchanged. |

The Python CLI sends `Accept: */*` (see `client/_fwlib.py:download`), so its
behavior is unaffected by the new browser branch.

## Upload page (`public/index.html` + `public/upload.js`)

### UX

```
┌─────────────────────────────────────────┐
│  fw                          [forget]   │
├─────────────────────────────────────────┤
│  ╭─ Drop a file or folder here ───╮     │
│  │  ── or ──                       │     │
│  │  [Choose file]  [Choose folder] │     │
│  ╰─────────────────────────────────╯     │
│  TTL: [1d ▾]   Visibility: ○Private ●Public │
│  Name (optional): [____________________]    │
│              [ Upload ]                 │
├─────────────────────────────────────────┤
│  ▰▰▰▰▰▰▰▰▱▱  61%  (12 / 200 MB)         │
└─────────────────────────────────────────┘

Post-success:
  ✓ Uploaded
  https://files.you.dev/d/aB3xK9pQzM#t=...
  [ Copy ]
  expires in 1 day
  [ Upload another ]
```

### Secret handling

- First visit (no `fw.uploadSecret` in `localStorage`): page shows a "Enter
  upload secret" form. On save, secret goes to `localStorage` and the upload
  UI swaps in. No validation round-trip — first upload reveals a bad secret
  via the worker's `401` response.
- Top-bar "forget" link clears `localStorage` and reverts to the secret prompt.
- The secret is sent as `Authorization: Bearer <secret>` on every upload
  request. The worker never stores it.

### File path (≤ 95 MB)

```js
fetch(`/upload?${qs}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}`, "content-type": file.type || "application/octet-stream" },
  body: file,   // File extends Blob; browser streams from disk
});
```

### Multipart path (> 95 MB)

- `POST /mpu/init` → `{id, key, upload_id, url, token?, expires_at}`.
- For each part i in 1..N: `file.slice(offset, offset+partSize)` → `PUT /mpu/part?...`. Up to 4 parts in flight via a small concurrency limiter.
- On any part failure: `POST /mpu/abort` then surface the worker's error message.
- On success: `POST /mpu/complete` with `{key, upload_id, parts: [{part, etag}, ...]}`.

### Folder path

- Folder picker: `<input type="file" webkitdirectory>` (Chrome/Edge/Safari/Firefox all support it now).
- Drag-drop folder: walk `DataTransferItem.webkitGetAsEntry()` recursively to a `File[]`.
- Read each file as `ArrayBuffer`, pass to fflate's `zipSync({ "name/path": bytes, ... })` → `Uint8Array`. Wrap in `Blob` and dispatch to the small or multipart upload path based on resulting size.
- Pre-zip size cap: warn if the source folder exceeds 500 MB ("zipping in browser may run out of memory; consider the CLI"). Hard fail if the resulting zip exceeds 2 GB (browser tab limit).
- `is_dir=true` and `name=<folder-name>` set in the query string; `content-type: application/zip`.

### Progress UI

- `<progress>` element. Small (single-shot) uploads use `XMLHttpRequest`
  for its `upload.onprogress` event (the only cross-browser way to read
  upload byte counts today). Multipart uploads use `fetch` per part and
  increment the bar by `part_size` as each `PUT` returns (good enough
  resolution at 25 MB granularity).

### Error UI

- Worker errors render in a red callout below the form, showing the JSON
  envelope's `error` code and `message`. Multipart failures auto-abort.

## Receive landing page (`public/recv.html` + `public/recv.js`)

### UX

```
┌────────────────────────────────────┐
│              fw                    │
├────────────────────────────────────┤
│  build.tar.gz                      │
│  47.3 MB                           │
│  expires in 23 hours               │
│  (folder — arrives as .zip)        │   ← if is_dir
│         [  Download  ]             │
└────────────────────────────────────┘

Error states:
  - "This file has expired or doesn't exist."
  - "This share is private. The URL needs the part after #;
     make sure you pasted the full URL."
```

### Flow

1. `recv.js` reads `:id` from `window.location.pathname` and the token (if any) from `window.location.hash` (`#t=<token>`). Hashes never reach the worker — that's exactly why private shares use them.
2. `fetch("/meta/<id>" + (token ? "?t=" + encodeURIComponent(token) : ""))`.
3. On `200`: render filename, size, expiry, folder hint; Download button is `<a href="/d/<id>?dl=1[&t=<token>]" download>`. Native browser navigation → stream-to-disk, no JS buffering.
4. On `404`: render the expired/missing message.
5. On `403`: render the missing-token message.

### Token-in-query for the actual download

When a private file is downloaded via the browser, the token appears in the
URL query string for that one GET. Cloudflare access logs do not include query
strings on the free tier; if you ever attach a custom logging pipeline, the
token may end up there. For a personal tool with rotating one-shot tokens this
is acceptable. The CLI continues to use `Authorization: Bearer <token>` and is
unaffected.

## Caching

- Static assets (`recv.html`, `index.html`, `upload.js`, `recv.js`, `styles.css`): long cache lifetime + content hash, applied automatically by Workers Static Assets.
- `/meta/:id` and `/d/:id` responses: `Cache-Control: no-store`. Necessary because metadata can flip to "expired" mid-window and bytes are token-gated.

## Browser support

Targets evergreen Chrome/Edge/Firefox/Safari. Required features all widely
supported: `fetch`, `XMLHttpRequest` (for upload progress events,
since `fetch`'s streaming-upload request body is Chrome-only), `Blob.slice`,
`<input webkitdirectory>`, ES modules. No IE, no transpilation.

## Testing

| Layer    | Tooling                                          | Cases                                                                                  |
|----------|--------------------------------------------------|----------------------------------------------------------------------------------------|
| Worker   | `vitest` + `@cloudflare/vitest-pool-workers`     | `/meta/:id` happy / 404 / 403 / expired; `/d/:id` HTML-branch returns recv.html bytes; `?dl=1` always streams the file regardless of Accept |
| Frontend | `vitest` + `happy-dom`                           | recv.js renders the right view for 200 / 404 / 403; upload.js TTL-string → query param mapping; multipart part-size math |
| Smoke    | `wrangler dev` + a real browser                  | Upload via UI (small + multipart + folder); receive via UI (public + private); ensure CLI still works against the same deployment |

## Out of scope (v1, deferred)

- Upload history / "recent shares" list in localStorage.
- Manual revocation endpoint and UI.
- In-browser preview for text/image/audio files.
- Pause/resume for in-flight uploads.
- QR code of the share URL.
- Telemetry / usage counters.

## Open follow-ups (post-v1)

- If jsdelivr blockage becomes a real problem, vendor `fflate.min.js` into
  `public/` as a one-file swap.
- If single-user becomes multi-user, the localStorage-secret model gives way
  to a real session-cookie auth flow — implies a non-trivial rework, not
  in this spec.
