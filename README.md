# file_worker

A personal scp-replacement. `fw send <path>` uploads a file or folder to a
Cloudflare Worker backed by R2 and prints a share URL. `fw recv <url>` pulls it
down on the other end. Folders are auto-zipped and auto-extracted. Each upload
gets a per-call TTL and is either public or guarded by a one-shot token.

```
fw send ./build.tar.gz --ttl 2h
fw send ./mydir         --ttl 1d --public
fw recv https://files.example.dev/d/aB3xK9pQzM#t=xK2pQz
```

The worker also serves a small **web UI** at its root URL: drop a file or
folder, set TTL/visibility, get a share URL. Recipients who open a `/d/<id>`
URL in a browser see a friendly landing page (filename, size, expiry) before
the download starts. The Python CLI and the browser UI both use the same
`/upload`, `/mpu/*`, and `/d/<id>` endpoints. See
[docs/superpowers/specs/2026-05-17-web-ui-design.md](docs/superpowers/specs/2026-05-17-web-ui-design.md)
for the design.

## Deploy the worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Yanksi/file_worker)

Replace the URL above with your own fork. The button reads the repo-root
`wrangler.toml`, creates the R2 bucket, and prompts for the upload secret.

### After the button finishes

Two one-time post-deploy steps:

1. **Set the upload secret.** This is the shared secret your client uses in
   `Authorization: Bearer ...`.
   ```
   wrangler secret put UPLOAD_SECRET
   ```
2. **Configure R2 lifecycle rules** (the wrangler config language does not
   yet declare these). In the Cloudflare dashboard → R2 → your bucket →
   Settings → Object lifecycle rules, add:

   | Prefix     | Expire current versions after |
   |------------|-------------------------------|
   | `ttl-1h/`  | 1 day                         |
   | `ttl-1d/`  | 1 day                         |
   | `ttl-7d/`  | 7 days                        |
   | `ttl-max/` | 7 days                        |

   Also enable "Abort incomplete multipart uploads after 1 day" for the entire
   bucket so failed uploads don't leak storage.

### Manual deploy (no button)

```
npm install
wrangler secret put UPLOAD_SECRET
wrangler deploy
```

Share URLs auto-detect the host the upload came in on, so they work for both
`*.workers.dev` and any custom domain without config. Set `PUBLIC_BASE_URL` in
`wrangler.toml` only if you want to override that (rare).

## Install the client

`fw` is a single Python script driven by [`uv`](https://docs.astral.sh/uv/) —
dependencies are declared inline in its PEP 723 header, so the first run
materializes a venv automatically.

```
git clone https://github.com/Yanksi/file_worker.git
cd file_worker
ln -s "$(pwd)/client/fw.py" ~/.local/bin/fw     # or `alias fw='uv run /full/path/to/fw.py'`
fw config setup
```

`fw config setup` asks for your worker URL and upload secret. The secret is
stored in your OS keychain when one is available (macOS Keychain, Windows
Credential Manager, Linux libsecret/KWallet). On headless systems without a
credential daemon (HPC clusters, minimal containers), it falls back to
`~/.config/fw/secrets.toml` with mode 0600. `fw config show` reports which
backend is in use.

## Use the client

```
fw send ./report.pdf                       # private (token), default TTL 1d
fw send ./report.pdf --ttl 2h --public     # public share, 2 hour TTL
fw send ./mydir --ttl 7d                   # auto-zip; private

fw recv aB3xK9pQzM --token xK2pQz          # bare id + token
fw recv https://files.example.dev/d/aB3xK9pQzM#t=xK2pQz
fw recv https://files.example.dev/d/aB3xK9pQzM -o ./downloads/
fw recv aB3xK9pQzM --keep-zip              # for folders: also keep the .zip
```

`fw send` prints the share URL on stdout (and the bare id / token / expiry on
following lines), so it pipes cleanly into other tools.

### TTL syntax

`30s`, `15m`, `2h`, `3d`. Max is 7 days. The client rounds **up** to the
nearest R2 lifecycle bucket (`ttl-1h/`, `ttl-1d/`, `ttl-7d/`); the worker
records the precise expiration in object metadata and enforces it on
download regardless.

### Visibility

- **`--public`** — anyone with the URL can download. No token is generated.
- **default (private)** — server generates a random 24-char token; only its
  sha256 is stored in R2. The client returns the token in the URL fragment
  (`#t=…`) so it never hits server logs.

## How it works

```
fw send ─┐
         │ small (≤ 95 MB)        POST /upload  ──┐
         │ large (> 95 MB)  POST /mpu/init        │
         │                  PUT  /mpu/part * N    │ → R2 object in
         │                  POST /mpu/complete    │   ttl-{1h,1d,7d,max}/<id>
         │                                        │   with custom metadata:
fw recv ─── GET /d/<id>[?t=token]  ──────────────┤   expires_at, visibility,
                                                  │   token_hash, is_dir, …
                                                  │
                                            R2 lifecycle rules delete
                                            objects after their bucket's
                                            window; download path enforces
                                            the precise TTL lazily and
                                            best-effort deletes expired
                                            objects on access.
```

See [`docs/superpowers/specs/2026-05-16-file-worker-design.md`](docs/superpowers/specs/2026-05-16-file-worker-design.md)
for the full design.

## Limits

- Single file or zipped-folder ≤ ~5 GB.
- Max TTL: 7 days.
- One upload secret = one user. No per-user accounts.
- No upload resume in v1; on connection failure, the client aborts and you
  retry from scratch.

## Cost

R2 storage is $0.015 / GB / month, with 10 GB free per month. Egress is free.
For occasional personal use this is effectively free; even sustained use is
small change. Workers free tier covers 100k requests/day.
