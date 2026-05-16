# file_worker — Design

Status: approved 2026-05-16
Owner: Shuhao Li

## Goal

A personal scp-replacement that uses a Cloudflare Worker + R2 as the transport. From any machine the user controls, `fw send <path>` uploads a file (or a folder, auto-zipped) and prints a share URL; on the destination machine, `fw recv <url>` pulls it down (and unzips if it was a folder). The user picks per-upload TTL and visibility (public / private + token).

Non-goals: multi-user accounts, web UI for browsing files, resumable multipart on flaky connections (v1), files larger than ~5 GB.

## Architecture

Three pieces:

1. **Worker** — single TypeScript file, deployed via `wrangler`. Owns the protocol, auth, multipart orchestration, TTL enforcement, and download streaming.
2. **R2 bucket** — only persistent store. Holds file bytes and per-file metadata (as R2 custom object metadata).
3. **Python client** (`fw`) — `uv`-runnable script that drives upload/download and handles folder zipping, multipart chunking, and credential storage.

No KV, no D1, no Durable Objects. Lifecycle rules on R2 are the free safety net for cleanup; a lazy check in the Worker enforces precise TTL at download time.

## Storage layout

Files are stored under one of four TTL prefixes:

| Prefix     | Lifecycle rule       | Used when TTL is        |
|------------|----------------------|-------------------------|
| `ttl-1h/`  | delete after 1 day*  | ≤ 1 hour                |
| `ttl-1d/`  | delete after 1 day   | ≤ 1 day                 |
| `ttl-7d/`  | delete after 7 days  | ≤ 7 days                |
| `ttl-max/` | delete after 7 days  | (alias for max)         |

*R2 lifecycle granularity is days, so 1-hour files get the day-level safety net plus exact lazy enforcement.

File IDs are 10-char URL-safe random strings (~60 bits of entropy). Full R2 key: `<prefix>/<id>`.

### Object custom metadata

| Key             | Value                                                  |
|-----------------|--------------------------------------------------------|
| `expires_at`    | unix seconds, authoritative TTL                        |
| `visibility`    | `public` \| `private`                                  |
| `token_hash`    | `sha256(token)` hex; present iff private               |
| `original_name` | sanitized filename or folder name                      |
| `is_dir`        | `"true"` \| `"false"` — was the upload auto-zipped?    |
| `content_type`  | client-provided                                        |
| `size`          | bytes (string)                                         |

The token itself is never stored — only its sha256. Downloads compare `sha256(supplied_token)` against `token_hash`.

### Download flow

1. `R2.head(key)`. Miss → 404.
2. If `expires_at < now` → schedule `R2.delete(key)` via `waitUntil`, return 404 with code `expired`.
3. If `visibility == "private"` and `sha256(supplied) !== token_hash` → 403.
4. Stream the body via `R2.get(key).body` with `Content-Disposition: attachment; filename="<original_name>"`.

Expired and missing both return 404 (don't leak existence).

## Wire protocol

All endpoints except `GET /d/:id` require `Authorization: Bearer <UPLOAD_SECRET>`.

### Small upload (≤ 95 MB)

```
POST /upload?ttl=3600&visibility=private&name=build.tar.gz&is_dir=false
Authorization: Bearer <SECRET>
Content-Type: application/octet-stream
Body: <raw bytes>

→ 200 { "id", "token"?, "url", "expires_at" }
```

### Multipart upload (> 95 MB)

```
POST /mpu/init?ttl=...&visibility=...&name=...&is_dir=...
  → { "id", "key", "upload_id" }

PUT  /mpu/part?key=...&upload_id=...&part=N
  Body: <chunk ≥ 5 MB, except last>
  → { "part": N, "etag": "..." }

POST /mpu/complete
  Body: { "key", "upload_id", "parts": [{"part","etag"}, ...] }
  → { "id", "token"?, "url", "expires_at" }

POST /mpu/abort
  Body: { "key", "upload_id" }
  → 204
```

### Download

```
GET /d/:id              ← public files
GET /d/:id?t=<token>    ← private (also accepts Authorization: Bearer <token>)
GET /d/:id#t=<token>    ← fragment form; tiny inline HTML shim re-requests with ?t=

→ 200
  Content-Disposition: attachment; filename="..."
  X-FW-Is-Dir: true|false
  X-FW-Expires-At: <unix>
  Body: <streamed object>

404 / 403 with uniform JSON error shape.
```

### Error envelope

```json
{ "error": "<code>", "message": "<human-readable>", "id"?: "<file-id>" }
```

Codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `expired` (404), `bad_request` (400), `payload_too_large` (413), `internal` (500).

## Python client

### Packaging

Two files, distributed together, both run via `uv`:

```
client/
├── fw.py        ← entry script with PEP 723 inline metadata header
└── _fwlib.py    ← sibling module: config, keyring, http, multipart, zip helpers
```

`fw.py` starts with:

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27", "keyring>=24", "tqdm>=4.66"]
# ///
```

User typically aliases `fw='uv run /path/to/fw.py'` or symlinks into `~/.local/bin/`.

### Commands

```
fw send <path> [--ttl 1h] [--public] [--name NAME] [--concurrency 4]
fw recv <id-or-url> [-o ./outdir] [--token TOKEN] [--keep-zip]
fw config setup
fw config show
fw config set-url <URL>
fw config set-secret              # reads from stdin, no echo
```

### Config & credentials

- `~/.config/fw/config.toml` — non-secret: `worker_url`, `default_ttl`, `default_concurrency`. Mode 644.
- Upload secret: try `keyring.get/set_password("fw", "upload_secret", ...)`; on `NoKeyringError`, missing backend, or `fail.Keyring`, fall back to `~/.config/fw/secrets.toml` (chmod 0600). `fw config show` reports which backend is in use.
- Download tokens are **not persisted** — passed per-call via `--token`, URL fragment, or `?t=`.

### Folder handling

- On `send`: if `Path(target).is_dir()` → stream contents into a temp `zipfile.ZipFile` (`ZIP_DEFLATED`); set `is_dir=true` and `original_name = <folder-name>` (no `.zip` suffix); upload as `application/zip`.
- On `recv`: if `X-FW-Is-Dir: true`, stream body to a temp file, then `zipfile.ZipFile.extractall(outdir)`; delete the temp unless `--keep-zip`.
- Zip files aren't streamable (central directory at the end), so a temp file is correct.

### TTL flag

Accepts human strings: `30s`, `15m`, `2h`, `3d`. The client rounds **up** to the nearest TTL bucket and sends both the bucket and the precise expiration; the worker records the precise value in metadata for exact lazy enforcement.

### Multipart upload

- Threshold: 95 MB. Below → `/upload`. At or above → `/mpu/*`.
- Default part size 25 MB; default 4 concurrent parts via `ThreadPoolExecutor` + a single `httpx.Client` (HTTP/2, keepalive).
- On any part failure → `POST /mpu/abort`; user retries from scratch. (Resume is deferred — explicit non-goal in v1.)
- `tqdm` progress bar spans the entire upload, summed across parts.

## Testing

| Layer    | Tooling                                                 | Cases                                                                                    |
|----------|---------------------------------------------------------|------------------------------------------------------------------------------------------|
| Worker   | `vitest` + `@cloudflare/vitest-pool-workers` (fake R2)  | small round trip, multipart round trip, private OK / bad token, public no token, expired → 404 + delete, no auth → 401 |
| Client   | `pytest` + `respx` (httpx mocking)                      | size-based routing at 95 MB threshold, folder → zip + `is_dir`, recv unzips, keyring miss → file fallback, TTL parsing |
| Smoke    | `make smoke` (`wrangler dev` + client)                  | 1 MB file, 200 MB file, folder; verify bytes match end-to-end                            |

## Deployment

- `wrangler.toml` declares the R2 binding `BUCKET` and reads `UPLOAD_SECRET` from secrets.
- Post-deploy steps (in README): `wrangler secret put UPLOAD_SECRET`, configure R2 lifecycle rules per prefix, optional custom domain.
- `README.md` includes a **Deploy to Cloudflare** button pointing at the GitHub repo so a fresh user clicks through to provision the worker + R2 bucket.

## Out of scope (v1)

- Resumable multipart uploads.
- Multi-user accounts / per-user secrets.
- Manual `DELETE /d/:id` revocation (TTL handles it).
- Files > 5 GB.
- Web download UI beyond the optional fragment-token redirect shim.

## Open follow-ups (post-v1, not blocking)

- Resume on flaky connections (`/mpu/list-parts` + client state in `~/.cache/fw/`).
- Manual revocation endpoint.
- Rate limiting per upload secret (would require KV or Durable Objects).
