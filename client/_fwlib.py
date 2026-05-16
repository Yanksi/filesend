"""Shared helpers for fw.py - config, secrets, HTTP, multipart, zip.

This module is imported by fw.py via sibling import; both files are shipped
together. Dependencies are declared in fw.py's PEP 723 header.
"""
from __future__ import annotations

import getpass
import os
import re
import sys
import tempfile
import tomllib
import urllib.parse
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import httpx
from tqdm import tqdm


SERVICE_NAME = "fw"
CONFIG_DIR = Path(os.environ.get("FW_CONFIG_DIR") or Path.home() / ".config" / "fw")
CONFIG_PATH = CONFIG_DIR / "config.toml"
SECRETS_PATH = CONFIG_DIR / "secrets.toml"

SMALL_UPLOAD_MAX = 95 * 1024 * 1024
DEFAULT_PART_SIZE = 25 * 1024 * 1024
MIN_PART_SIZE = 5 * 1024 * 1024
DEFAULT_CONCURRENCY = 4
DEFAULT_TTL = "1d"
HTTP_TIMEOUT = httpx.Timeout(connect=15.0, read=300.0, write=300.0, pool=15.0)


class FwError(Exception):
    """User-facing error. Caught at the CLI boundary; message is printed as-is."""


# ----------------------------- config (non-secret) -----------------------------

def _ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    with CONFIG_PATH.open("rb") as f:
        return tomllib.load(f)


def save_config(cfg: dict) -> None:
    _ensure_config_dir()
    lines: list[str] = []
    for k, v in cfg.items():
        if isinstance(v, str):
            esc = v.replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'{k} = "{esc}"')
        elif isinstance(v, (int, float)):
            lines.append(f"{k} = {v}")
        elif isinstance(v, bool):
            lines.append(f"{k} = {'true' if v else 'false'}")
        else:
            raise FwError(f"Unsupported config value type for {k}: {type(v).__name__}")
    CONFIG_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def get_worker_url() -> str:
    cfg = load_config()
    url = cfg.get("worker_url")
    if not url:
        raise FwError(
            "No worker_url configured. Run `fw config setup` or "
            "`fw config set-url <URL>` first."
        )
    return url.rstrip("/")


# ----------------------------- secrets (keyring + fallback) -----------------------------

@dataclass
class SecretBackend:
    name: str  # "keyring" or "file"
    detail: str  # backend class name for keyring, or path for file


def _try_keyring():
    try:
        import keyring  # type: ignore
        from keyring.backends.fail import Keyring as FailKeyring  # type: ignore
        return keyring, FailKeyring
    except Exception:
        return None, None


def _read_secrets_file() -> dict:
    if not SECRETS_PATH.exists():
        return {}
    with SECRETS_PATH.open("rb") as f:
        return tomllib.load(f)


def _write_secrets_file(data: dict) -> None:
    _ensure_config_dir()
    lines = [f'{k} = "{v}"' for k, v in data.items()]
    SECRETS_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.chmod(SECRETS_PATH, 0o600)
    except OSError:
        # Windows: chmod is best-effort; ACLs differ but the file is in the
        # user-only %USERPROFILE%\.config tree, so this is acceptable.
        pass


def get_secret(key: str) -> str | None:
    keyring, FailKeyring = _try_keyring()
    if keyring is not None:
        try:
            backend = keyring.get_keyring()
            if FailKeyring is None or not isinstance(backend, FailKeyring):
                val = keyring.get_password(SERVICE_NAME, key)
                if val is not None:
                    return val
        except Exception:
            pass
    return _read_secrets_file().get(key)


def set_secret(key: str, value: str) -> SecretBackend:
    keyring, FailKeyring = _try_keyring()
    if keyring is not None:
        try:
            backend = keyring.get_keyring()
            if FailKeyring is None or not isinstance(backend, FailKeyring):
                keyring.set_password(SERVICE_NAME, key, value)
                return SecretBackend(name="keyring", detail=type(backend).__name__)
        except Exception:
            pass
    data = _read_secrets_file()
    data[key] = value
    _write_secrets_file(data)
    return SecretBackend(name="file", detail=str(SECRETS_PATH))


def current_secret_backend() -> SecretBackend:
    keyring, FailKeyring = _try_keyring()
    if keyring is not None:
        try:
            backend = keyring.get_keyring()
            if FailKeyring is None or not isinstance(backend, FailKeyring):
                return SecretBackend(name="keyring", detail=type(backend).__name__)
        except Exception:
            pass
    return SecretBackend(name="file", detail=str(SECRETS_PATH))


def get_upload_secret() -> str:
    s = get_secret("upload_secret")
    if not s:
        raise FwError(
            "No upload_secret configured. Run `fw config set-secret` (it will "
            "prompt without echo)."
        )
    return s


# ----------------------------- TTL parsing -----------------------------

_TTL_RE = re.compile(r"^\s*(\d+)\s*([smhd])\s*$", re.IGNORECASE)
_TTL_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
MAX_TTL_SECONDS = 7 * 86400


def parse_ttl(spec: str) -> int:
    m = _TTL_RE.match(spec)
    if not m:
        raise FwError(
            f"Invalid TTL {spec!r}. Use forms like 30s, 15m, 2h, 3d."
        )
    n = int(m.group(1))
    unit = m.group(2).lower()
    seconds = n * _TTL_UNIT_SECONDS[unit]
    if seconds <= 0:
        raise FwError("TTL must be positive.")
    if seconds > MAX_TTL_SECONDS:
        raise FwError(f"TTL exceeds maximum of 7d ({MAX_TTL_SECONDS} seconds).")
    return seconds


# ----------------------------- ID / URL parsing -----------------------------

@dataclass
class ParsedShare:
    id: str
    token: str | None


_ID_RE = re.compile(r"^[A-Za-z0-9]{6,40}$")


def parse_share(raw: str) -> ParsedShare:
    """Accept a bare ID or a full share URL with #t= or ?t= for the token."""
    if "://" in raw or raw.startswith("/d/"):
        url = raw if "://" in raw else f"https://placeholder{raw}"
        u = urllib.parse.urlsplit(url)
        path_parts = [p for p in u.path.split("/") if p]
        if len(path_parts) < 2 or path_parts[-2] != "d":
            raise FwError(f"Unrecognized share URL: {raw!r}")
        file_id = path_parts[-1]
        token = None
        if u.fragment:
            for kv in u.fragment.split("&"):
                if kv.startswith("t="):
                    token = urllib.parse.unquote(kv[2:])
                    break
        if not token:
            qs = urllib.parse.parse_qs(u.query)
            if "t" in qs and qs["t"]:
                token = qs["t"][0]
        return ParsedShare(id=file_id, token=token)

    if not _ID_RE.match(raw):
        raise FwError(f"Not a valid file ID: {raw!r}")
    return ParsedShare(id=raw, token=None)


# ----------------------------- HTTP -----------------------------

def make_client() -> httpx.Client:
    return httpx.Client(timeout=HTTP_TIMEOUT, http2=False, follow_redirects=True)


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {get_upload_secret()}"}


def _raise_for_status(resp: httpx.Response, what: str) -> None:
    if resp.status_code < 400:
        return
    try:
        body = resp.json()
        msg = body.get("message") or body.get("error") or resp.text
    except Exception:
        msg = resp.text or resp.reason_phrase
    raise FwError(f"{what} failed ({resp.status_code}): {msg}")


# ----------------------------- folder zip -----------------------------

@contextmanager
def temp_zip_of(directory: Path) -> Iterator[Path]:
    """Yield a Path to a temp .zip of `directory`; deletes on exit."""
    if not directory.is_dir():
        raise FwError(f"Not a directory: {directory}")
    fd, tmp_path = tempfile.mkstemp(prefix="fwsend-", suffix=".zip")
    os.close(fd)
    tmp = Path(tmp_path)
    try:
        base = directory.resolve()
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, _dirs, files in os.walk(base):
                for fn in files:
                    full = Path(root) / fn
                    arc = full.relative_to(base.parent)
                    zf.write(full, arcname=str(arc))
        yield tmp
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def extract_zip_to(zip_path: Path, outdir: Path) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        # zipfile.extractall in Python 3.11+ already rejects absolute paths
        # and '..' traversal, so this is safe.
        zf.extractall(outdir)


# ----------------------------- upload -----------------------------

@dataclass
class UploadResult:
    id: str
    url: str
    token: str | None
    expires_at: int


def _common_query(ttl: int, visibility: str, name: str, is_dir: bool) -> str:
    return urllib.parse.urlencode({
        "ttl": ttl,
        "visibility": visibility,
        "name": name,
        "is_dir": "true" if is_dir else "false",
    })


def upload_small(
    client: httpx.Client,
    worker_url: str,
    path: Path,
    ttl: int,
    visibility: str,
    name: str,
    is_dir: bool,
    content_type: str,
) -> UploadResult:
    size = path.stat().st_size
    qs = _common_query(ttl, visibility, name, is_dir)
    url = f"{worker_url}/upload?{qs}"
    headers = {
        **auth_headers(),
        "content-type": content_type,
        "content-length": str(size),
    }
    with path.open("rb") as fh, tqdm(
        total=size, unit="B", unit_scale=True, desc=f"upload {name}", leave=False
    ) as bar:
        wrapped = _ProgressReader(fh, bar)
        resp = client.post(url, headers=headers, content=wrapped)
    _raise_for_status(resp, "Upload")
    data = resp.json()
    return UploadResult(
        id=data["id"],
        url=data["url"],
        token=data.get("token"),
        expires_at=data["expires_at"],
    )


def upload_multipart(
    client: httpx.Client,
    worker_url: str,
    path: Path,
    ttl: int,
    visibility: str,
    name: str,
    is_dir: bool,
    content_type: str,
    part_size: int = DEFAULT_PART_SIZE,
    concurrency: int = DEFAULT_CONCURRENCY,
) -> UploadResult:
    size = path.stat().st_size
    if part_size < MIN_PART_SIZE:
        raise FwError(f"part_size must be >= {MIN_PART_SIZE}")

    qs = _common_query(ttl, visibility, name, is_dir)
    init_resp = client.post(f"{worker_url}/mpu/init?{qs}", headers=auth_headers())
    _raise_for_status(init_resp, "Multipart init")
    init = init_resp.json()
    key, upload_id = init["key"], init["upload_id"]

    parts_total = (size + part_size - 1) // part_size
    parts_done: list[dict[str, object]] = []
    bar = tqdm(total=size, unit="B", unit_scale=True, desc=f"upload {name}", leave=False)

    try:
        def upload_one(part_num: int, offset: int, length: int) -> dict:
            with path.open("rb") as fh:
                fh.seek(offset)
                buf = fh.read(length)
            part_url = (
                f"{worker_url}/mpu/part?"
                + urllib.parse.urlencode({"key": key, "upload_id": upload_id, "part": part_num})
            )
            resp = client.put(
                part_url,
                headers={**auth_headers(), "content-type": "application/octet-stream"},
                content=buf,
            )
            _raise_for_status(resp, f"Multipart part {part_num}")
            bar.update(length)
            return resp.json()

        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = []
            for i in range(parts_total):
                offset = i * part_size
                length = min(part_size, size - offset)
                futures.append(pool.submit(upload_one, i + 1, offset, length))
            for fut in as_completed(futures):
                parts_done.append(fut.result())
    except BaseException:
        bar.close()
        # Best-effort abort; swallow errors so we don't mask the original.
        try:
            client.post(
                f"{worker_url}/mpu/abort",
                headers={**auth_headers(), "content-type": "application/json"},
                json={"key": key, "upload_id": upload_id},
            )
        except Exception:
            pass
        raise
    finally:
        bar.close()

    complete_resp = client.post(
        f"{worker_url}/mpu/complete",
        headers={**auth_headers(), "content-type": "application/json"},
        json={"key": key, "upload_id": upload_id, "parts": parts_done},
    )
    _raise_for_status(complete_resp, "Multipart complete")

    return UploadResult(
        id=init["id"],
        url=init["url"],
        token=init.get("token"),
        expires_at=init["expires_at"],
    )


class _ProgressReader:
    """File wrapper that updates a tqdm bar as it's read. httpx accepts any
    iterable of bytes via `content=`, but for a single-shot POST we hand it a
    file-like that streams chunks."""
    def __init__(self, fh, bar: tqdm, chunk: int = 1024 * 256):
        self._fh = fh
        self._bar = bar
        self._chunk = chunk

    def __iter__(self):
        while True:
            buf = self._fh.read(self._chunk)
            if not buf:
                return
            self._bar.update(len(buf))
            yield buf


# ----------------------------- download -----------------------------

@dataclass
class DownloadResult:
    bytes_written: int
    is_dir: bool
    suggested_name: str
    expires_at: int


def download(
    client: httpx.Client,
    worker_url: str,
    share: ParsedShare,
    token_override: str | None,
    out_dir: Path,
    keep_zip: bool,
) -> DownloadResult:
    token = token_override or share.token
    params = {}
    if token:
        params["t"] = token
    url = f"{worker_url}/d/{share.id}"
    out_dir.mkdir(parents=True, exist_ok=True)

    with client.stream("GET", url, params=params, headers={"accept": "*/*"}) as resp:
        if resp.status_code >= 400:
            # Read body for the error message before raising.
            body = resp.read().decode("utf-8", errors="replace")
            try:
                import json
                obj = json.loads(body)
                msg = obj.get("message") or obj.get("error") or body
            except Exception:
                msg = body
            raise FwError(f"Download failed ({resp.status_code}): {msg}")

        is_dir = resp.headers.get("x-fw-is-dir", "false") == "true"
        expires_at = int(resp.headers.get("x-fw-expires-at", "0") or 0)
        suggested = _filename_from_disposition(resp.headers.get("content-disposition", "")) or share.id
        total = int(resp.headers.get("content-length", "0") or 0)

        if is_dir:
            fd, tmp_path = tempfile.mkstemp(prefix="fwrecv-", suffix=".zip")
            os.close(fd)
            tmp = Path(tmp_path)
            try:
                bytes_written = _stream_to_file(resp, tmp, total, desc=f"download {suggested}")
                extract_zip_to(tmp, out_dir)
            finally:
                if not keep_zip:
                    try:
                        tmp.unlink(missing_ok=True)
                    except OSError:
                        pass
                else:
                    final = out_dir / f"{suggested}.zip"
                    try:
                        tmp.replace(final)
                    except OSError:
                        pass
            return DownloadResult(
                bytes_written=bytes_written,
                is_dir=True,
                suggested_name=suggested,
                expires_at=expires_at,
            )

        target = out_dir / suggested
        bytes_written = _stream_to_file(resp, target, total, desc=f"download {suggested}")
        return DownloadResult(
            bytes_written=bytes_written,
            is_dir=False,
            suggested_name=suggested,
            expires_at=expires_at,
        )


def _stream_to_file(resp: httpx.Response, target: Path, total: int, desc: str) -> int:
    written = 0
    with target.open("wb") as out, tqdm(
        total=total or None, unit="B", unit_scale=True, desc=desc, leave=False
    ) as bar:
        for chunk in resp.iter_bytes():
            out.write(chunk)
            written += len(chunk)
            bar.update(len(chunk))
    return written


_DISPOSITION_RE = re.compile(r'filename="([^"]+)"')


def _filename_from_disposition(s: str) -> str | None:
    if not s:
        return None
    m = _DISPOSITION_RE.search(s)
    if m:
        return m.group(1)
    return None


# ----------------------------- interactive setup helpers -----------------------------

def prompt_password(prompt: str) -> str:
    if not sys.stdin.isatty():
        return sys.stdin.readline().rstrip("\n")
    return getpass.getpass(prompt)


def prompt(prompt_text: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    raw = input(f"{prompt_text}{suffix}: ").strip()
    return raw or (default or "")
