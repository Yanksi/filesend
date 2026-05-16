#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "httpx>=0.27",
#   "keyring>=24",
#   "tqdm>=4.66",
# ]
# ///
"""fw - a personal scp-replacement built on Cloudflare Worker + R2.

Usage:
  fw send <path> [--ttl 1d] [--public] [--name NAME] [--concurrency 4]
  fw recv <id-or-url> [-o ./outdir] [--token TOKEN] [--keep-zip]
  fw config setup
  fw config show
  fw config set-url <URL>
  fw config set-secret
"""
from __future__ import annotations

import argparse
import mimetypes
import sys
from pathlib import Path

# Sibling-module import. uv runs this script in place, so the parent dir is on
# sys.path automatically when invoked as `uv run path/to/fw.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _fwlib as fw  # noqa: E402


def cmd_send(args: argparse.Namespace) -> int:
    worker_url = fw.get_worker_url()
    src = Path(args.path).expanduser().resolve()
    if not src.exists():
        raise fw.FwError(f"No such path: {src}")

    ttl = fw.parse_ttl(args.ttl)
    visibility = "public" if args.public else "private"

    if src.is_dir():
        display_name = args.name or src.name
        with fw.temp_zip_of(src) as zip_path:
            size = zip_path.stat().st_size
            content_type = "application/zip"
            with fw.make_client() as client:
                result = _upload_dispatch(
                    client, worker_url, zip_path, size, ttl, visibility,
                    display_name, is_dir=True, content_type=content_type,
                    concurrency=args.concurrency,
                )
    else:
        display_name = args.name or src.name
        size = src.stat().st_size
        guess, _ = mimetypes.guess_type(str(src))
        content_type = guess or "application/octet-stream"
        with fw.make_client() as client:
            result = _upload_dispatch(
                client, worker_url, src, size, ttl, visibility,
                display_name, is_dir=False, content_type=content_type,
                concurrency=args.concurrency,
            )

    print(result.url)
    print(f"id: {result.id}")
    if result.token:
        print(f"token: {result.token}")
    print(f"expires_at: {result.expires_at}")
    return 0


def _upload_dispatch(
    client, worker_url, path, size, ttl, visibility, name, is_dir, content_type, concurrency,
):
    if size <= fw.SMALL_UPLOAD_MAX:
        return fw.upload_small(
            client, worker_url, path, ttl, visibility, name, is_dir, content_type,
        )
    return fw.upload_multipart(
        client, worker_url, path, ttl, visibility, name, is_dir, content_type,
        concurrency=concurrency,
    )


def cmd_recv(args: argparse.Namespace) -> int:
    worker_url = fw.get_worker_url()
    share = fw.parse_share(args.share)
    out_dir = Path(args.out).expanduser().resolve()
    with fw.make_client() as client:
        result = fw.download(
            client, worker_url, share, args.token, out_dir, keep_zip=args.keep_zip,
        )
    if result.is_dir:
        print(f"extracted {result.bytes_written} bytes into {out_dir}")
    else:
        print(f"wrote {result.bytes_written} bytes to {out_dir / result.suggested_name}")
    return 0


def cmd_config_setup(_args: argparse.Namespace) -> int:
    cfg = fw.load_config()
    cur_url = cfg.get("worker_url", "")
    url = fw.prompt("Worker URL (e.g. https://file-worker.workers.dev)", cur_url or None)
    if not url:
        raise fw.FwError("Worker URL is required.")
    cfg["worker_url"] = url.rstrip("/")
    fw.save_config(cfg)

    print("Upload secret (input hidden; press Enter to leave unchanged):")
    secret = fw.prompt_password("upload_secret: ")
    if secret:
        backend = fw.set_secret("upload_secret", secret)
        print(f"Saved upload_secret via {backend.name} ({backend.detail}).")
    else:
        print("Left upload_secret unchanged.")
    print(f"Config written to {fw.CONFIG_PATH}")
    return 0


def cmd_config_show(_args: argparse.Namespace) -> int:
    cfg = fw.load_config()
    backend = fw.current_secret_backend()
    print(f"config_path:    {fw.CONFIG_PATH}")
    print(f"worker_url:     {cfg.get('worker_url', '(unset)')}")
    print(f"secret_backend: {backend.name} ({backend.detail})")
    have_secret = fw.get_secret("upload_secret") is not None
    print(f"upload_secret:  {'set' if have_secret else 'unset'}")
    return 0


def cmd_config_set_url(args: argparse.Namespace) -> int:
    cfg = fw.load_config()
    cfg["worker_url"] = args.url.rstrip("/")
    fw.save_config(cfg)
    print(f"worker_url set to {cfg['worker_url']}")
    return 0


def cmd_config_set_secret(_args: argparse.Namespace) -> int:
    secret = fw.prompt_password("upload_secret: ")
    if not secret:
        raise fw.FwError("Empty secret; not saved.")
    backend = fw.set_secret("upload_secret", secret)
    print(f"Saved upload_secret via {backend.name} ({backend.detail}).")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fw", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("send", help="upload a file or folder")
    s.add_argument("path", help="file or directory to upload")
    s.add_argument("--ttl", default=fw.DEFAULT_TTL, help="lifetime, e.g. 30s, 15m, 2h, 3d (max 7d)")
    s.add_argument("--public", action="store_true", help="no token required to download")
    s.add_argument("--name", default=None, help="override the stored filename")
    s.add_argument("--concurrency", type=int, default=fw.DEFAULT_CONCURRENCY,
                   help="parallel multipart parts (default 4)")
    s.set_defaults(func=cmd_send)

    r = sub.add_parser("recv", help="download a file or folder by id or share URL")
    r.add_argument("share", help="file ID or full share URL")
    r.add_argument("-o", "--out", default=".", help="output directory (default: cwd)")
    r.add_argument("--token", default=None, help="download token (private files)")
    r.add_argument("--keep-zip", action="store_true",
                   help="for folder downloads, also keep the .zip alongside the extracted contents")
    r.set_defaults(func=cmd_recv)

    c = sub.add_parser("config", help="manage client config and secrets")
    csub = c.add_subparsers(dest="config_cmd", required=True)

    csub.add_parser("setup", help="interactive setup").set_defaults(func=cmd_config_setup)
    csub.add_parser("show", help="print current config").set_defaults(func=cmd_config_show)
    set_url = csub.add_parser("set-url", help="set worker URL")
    set_url.add_argument("url")
    set_url.set_defaults(func=cmd_config_set_url)
    csub.add_parser("set-secret", help="set upload secret (reads stdin)").set_defaults(func=cmd_config_set_secret)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except fw.FwError as e:
        print(f"fw: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("fw: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
