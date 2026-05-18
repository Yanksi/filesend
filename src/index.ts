export interface Env {
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  UPLOAD_SECRET: string;
  // Optional override. If unset (or empty), the worker uses the origin of
  // the incoming request to build share URLs - which "just works" for both
  // workers.dev URLs and custom domains.
  PUBLIC_BASE_URL?: string;
  MAX_TTL_SECONDS: string;
}

type Visibility = "public" | "private";
type TtlBucket = "ttl-1h" | "ttl-1d" | "ttl-7d" | "ttl-max";

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const ID_LEN = 10;
const TOKEN_LEN = 24;
const SMALL_UPLOAD_MAX = 95 * 1024 * 1024;

const TTL_BUCKETS: { name: TtlBucket; maxSeconds: number }[] = [
  { name: "ttl-1h",  maxSeconds: 60 * 60 },
  { name: "ttl-1d",  maxSeconds: 24 * 60 * 60 },
  { name: "ttl-7d",  maxSeconds: 7 * 24 * 60 * 60 },
  { name: "ttl-max", maxSeconds: 7 * 24 * 60 * 60 },
];

function pickBucket(ttlSeconds: number): TtlBucket {
  for (const b of TTL_BUCKETS) {
    if (ttlSeconds <= b.maxSeconds) return b.name;
  }
  return "ttl-max";
}

function randomFrom(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

const newId = () => randomFrom(ID_ALPHABET, ID_LEN);
const newToken = () => randomFrom(ID_ALPHABET, TOKEN_LEN);

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sanitizeName(name: string | null | undefined): string {
  if (!name) return "file";
  const cleaned = name.replace(/[\x00-\x1f\x7f/\\]/g, "_").trim();
  return cleaned.slice(0, 200) || "file";
}

function jsonError(code: string, message: string, status: number, id?: string): Response {
  const body: Record<string, string> = { error: code, message };
  if (id) body.id = id;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requireAuth(req: Request, env: Env): Response | null {
  if (!env.UPLOAD_SECRET) {
    return jsonError("internal", "Worker is missing UPLOAD_SECRET", 500);
  }
  const expected = `Bearer ${env.UPLOAD_SECRET}`;
  const got = req.headers.get("authorization");
  if (!got || !constantTimeEqual(got, expected)) {
    return jsonError("unauthorized", "Missing or invalid Authorization header", 401);
  }
  return null;
}

interface UploadParams {
  ttlSeconds: number;
  visibility: Visibility;
  originalName: string;
  isDir: boolean;
  contentType: string;
}

function parseUploadParams(url: URL, req: Request, env: Env): UploadParams | Response {
  const ttlRaw = url.searchParams.get("ttl");
  const visRaw = url.searchParams.get("visibility");
  const name = url.searchParams.get("name");
  const isDir = url.searchParams.get("is_dir") === "true";
  const maxTtl = parseInt(env.MAX_TTL_SECONDS, 10) || 7 * 24 * 60 * 60;

  if (!ttlRaw) return jsonError("bad_request", "Missing ttl", 400);
  const ttlSeconds = parseInt(ttlRaw, 10);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return jsonError("bad_request", "ttl must be a positive integer (seconds)", 400);
  }
  if (ttlSeconds > maxTtl) {
    return jsonError("bad_request", `ttl exceeds max of ${maxTtl} seconds`, 400);
  }
  if (visRaw !== "public" && visRaw !== "private") {
    return jsonError("bad_request", "visibility must be 'public' or 'private'", 400);
  }
  const contentType = req.headers.get("content-type") || "application/octet-stream";
  return {
    ttlSeconds,
    visibility: visRaw,
    originalName: sanitizeName(name),
    isDir,
    contentType,
  };
}

function buildShareUrl(req: Request, env: Env, id: string, token: string | null): string {
  const baseRaw = env.PUBLIC_BASE_URL && env.PUBLIC_BASE_URL.length > 0
    ? env.PUBLIC_BASE_URL
    : new URL(req.url).origin;
  const base = baseRaw.replace(/\/$/, "");
  return token ? `${base}/d/${id}#t=${token}` : `${base}/d/${id}`;
}

function metadataFor(
  params: UploadParams,
  tokenHash: string | null,
  size: number | null,
): Record<string, string> {
  const expiresAt = Math.floor(Date.now() / 1000) + params.ttlSeconds;
  const md: Record<string, string> = {
    expires_at: String(expiresAt),
    visibility: params.visibility,
    original_name: params.originalName,
    is_dir: params.isDir ? "true" : "false",
    content_type: params.contentType,
  };
  if (tokenHash) md.token_hash = tokenHash;
  if (size != null) md.size = String(size);
  return md;
}

function uploadResponseBody(req: Request, env: Env, id: string, params: UploadParams, token: string | null) {
  return {
    id,
    url: buildShareUrl(req, env, id, token),
    expires_at: Math.floor(Date.now() / 1000) + params.ttlSeconds,
    ...(token ? { token } : {}),
  };
}

// ---------- small upload ----------

async function handleSmallUpload(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parsed = parseUploadParams(url, req, env);
  if (parsed instanceof Response) return parsed;

  const lenHdr = req.headers.get("content-length");
  if (lenHdr) {
    const len = parseInt(lenHdr, 10);
    if (Number.isFinite(len) && len > SMALL_UPLOAD_MAX) {
      return jsonError("payload_too_large", `Use multipart for bodies > ${SMALL_UPLOAD_MAX} bytes`, 413);
    }
  }
  if (!req.body) return jsonError("bad_request", "Empty body", 400);

  const id = newId();
  const key = `${pickBucket(parsed.ttlSeconds)}/${id}`;
  const token = parsed.visibility === "private" ? newToken() : null;
  const tokenHash = token ? await sha256Hex(token) : null;

  await env.BUCKET.put(key, req.body, {
    httpMetadata: { contentType: parsed.contentType },
    customMetadata: metadataFor(parsed, tokenHash, null),
  });
  return new Response(JSON.stringify(uploadResponseBody(req, env, id, parsed, token)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---------- multipart upload ----------

async function handleMpuInit(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parsed = parseUploadParams(url, req, env);
  if (parsed instanceof Response) return parsed;

  const id = newId();
  const key = `${pickBucket(parsed.ttlSeconds)}/${id}`;
  const token = parsed.visibility === "private" ? newToken() : null;
  const tokenHash = token ? await sha256Hex(token) : null;

  // R2 multipart accepts customMetadata at createMultipartUpload and persists
  // it through complete(), so we stamp everything once up-front and never have
  // to revisit the bytes on the complete path.
  const mpu = await env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: parsed.contentType },
    customMetadata: metadataFor(parsed, tokenHash, null),
  });

  return new Response(JSON.stringify({
    key,
    upload_id: mpu.uploadId,
    ...uploadResponseBody(req, env, id, parsed, token),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function handleMpuPart(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const uploadId = url.searchParams.get("upload_id");
  const partStr = url.searchParams.get("part");
  if (!key || !uploadId || !partStr) {
    return jsonError("bad_request", "Missing key, upload_id, or part", 400);
  }
  const partNumber = parseInt(partStr, 10);
  if (!Number.isFinite(partNumber) || partNumber < 1) {
    return jsonError("bad_request", "part must be a positive integer", 400);
  }
  if (!req.body) return jsonError("bad_request", "Empty part body", 400);

  const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);
  const uploaded = await mpu.uploadPart(partNumber, req.body);
  return new Response(JSON.stringify({ part: uploaded.partNumber, etag: uploaded.etag }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface MpuCompleteBody {
  key: string;
  upload_id: string;
  parts: { part: number; etag: string }[];
}

async function handleMpuComplete(req: Request, env: Env): Promise<Response> {
  let body: MpuCompleteBody;
  try {
    body = await req.json();
  } catch {
    return jsonError("bad_request", "Invalid JSON body", 400);
  }
  if (!body.key || !body.upload_id || !Array.isArray(body.parts) || body.parts.length === 0) {
    return jsonError("bad_request", "Missing key, upload_id, or parts", 400);
  }
  const mpu = env.BUCKET.resumeMultipartUpload(body.key, body.upload_id);
  const sortedParts = [...body.parts]
    .sort((a, b) => a.part - b.part)
    .map((p) => ({ partNumber: p.part, etag: p.etag }));
  await mpu.complete(sortedParts);
  return new Response(null, { status: 204 });
}

async function handleMpuAbort(req: Request, env: Env): Promise<Response> {
  let body: { key?: string; upload_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("bad_request", "Invalid JSON body", 400);
  }
  if (!body.key || !body.upload_id) {
    return jsonError("bad_request", "Missing key or upload_id", 400);
  }
  const mpu = env.BUCKET.resumeMultipartUpload(body.key, body.upload_id);
  await mpu.abort();
  return new Response(null, { status: 204 });
}

// ---------- download / metadata ----------

async function findObjectByPrefix(env: Env, id: string): Promise<{ key: string; head: R2Object } | null> {
  for (const b of TTL_BUCKETS) {
    const key = `${b.name}/${id}`;
    const head = await env.BUCKET.head(key);
    if (head) return { key, head };
  }
  return null;
}

function tokenFromRequest(req: Request, url: URL): string | null {
  const q = url.searchParams.get("t");
  if (q) return q;
  const auth = req.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return null;
}

// Shared lookup + auth used by both /d/:id and /meta/:id. Returns the object
// head + key on success, or a ready-to-return error Response. Expired objects
// are scheduled for deletion via waitUntil before the 404 is returned.
async function gatedHead(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
): Promise<{ key: string; head: R2Object; md: Record<string, string> } | Response> {
  const url = new URL(req.url);
  const found = await findObjectByPrefix(env, id);
  if (!found) return jsonError("not_found", "No such file", 404, id);

  const { key, head } = found;
  const md = head.customMetadata || {};
  const expiresAt = parseInt(md.expires_at ?? "0", 10);
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt && expiresAt < now) {
    ctx.waitUntil(env.BUCKET.delete(key).catch(() => undefined));
    return jsonError("expired", "File has expired", 404, id);
  }

  const visibility = (md.visibility as Visibility) || "private";
  if (visibility === "private") {
    const supplied = tokenFromRequest(req, url);
    if (!supplied) {
      return jsonError("forbidden", "Missing token for private file", 403, id);
    }
    const expectedHash = md.token_hash || "";
    const suppliedHash = await sha256Hex(supplied);
    if (!constantTimeEqual(expectedHash, suppliedHash)) {
      return jsonError("forbidden", "Invalid token", 403, id);
    }
  }

  return { key, head, md };
}

async function handleDownload(req: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  const url = new URL(req.url);
  const acceptHtml = (req.headers.get("accept") || "").includes("text/html");
  const dlFlag = url.searchParams.get("dl") === "1";

  // Browsers (no ?dl=1) get the landing page. The page itself calls /meta/:id
  // to fetch details and render — so we don't pay an R2 head() here just to
  // decide what to serve.
  if (acceptHtml && !dlFlag) {
    return env.ASSETS.fetch(new URL("/recv.html", req.url));
  }

  const gate = await gatedHead(req, env, ctx, id);
  if (gate instanceof Response) return gate;

  const obj = await env.BUCKET.get(gate.key);
  if (!obj) return jsonError("not_found", "Object disappeared", 404, id);

  const md = gate.md;
  const filename = (md.original_name || "file").replace(/"/g, "");
  const headers = new Headers();
  headers.set("content-type", md.content_type || "application/octet-stream");
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  headers.set("x-fw-is-dir", md.is_dir === "true" ? "true" : "false");
  headers.set("x-fw-expires-at", md.expires_at ?? "0");
  headers.set("cache-control", "no-store");
  if (md.size) headers.set("content-length", md.size);
  return new Response(obj.body, { status: 200, headers });
}

async function handleMeta(req: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  const gate = await gatedHead(req, env, ctx, id);
  if (gate instanceof Response) return gate;
  const md = gate.md;
  const body = {
    id,
    expires_at: parseInt(md.expires_at ?? "0", 10),
    original_name: md.original_name || "file",
    is_dir: md.is_dir === "true",
    size: md.size ? parseInt(md.size, 10) : null,
    visibility: md.visibility || "private",
    content_type: md.content_type || "application/octet-stream",
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

// ---------- router ----------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      if (method === "GET" && path.startsWith("/d/")) {
        const id = path.slice("/d/".length);
        if (!id || id.includes("/")) return jsonError("bad_request", "Bad id", 400);
        return await handleDownload(req, env, ctx, id);
      }
      if (method === "GET" && path.startsWith("/meta/")) {
        const id = path.slice("/meta/".length);
        if (!id || id.includes("/")) return jsonError("bad_request", "Bad id", 400);
        return await handleMeta(req, env, ctx, id);
      }

      const authErr = requireAuth(req, env);
      if (authErr) return authErr;

      if (method === "POST" && path === "/upload")       return await handleSmallUpload(req, env);
      if (method === "POST" && path === "/mpu/init")     return await handleMpuInit(req, env);
      if (method === "PUT"  && path === "/mpu/part")     return await handleMpuPart(req, env);
      if (method === "POST" && path === "/mpu/complete") return await handleMpuComplete(req, env);
      if (method === "POST" && path === "/mpu/abort")    return await handleMpuAbort(req, env);

      return jsonError("not_found", "No such route", 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError("internal", msg, 500);
    }
  },
};
