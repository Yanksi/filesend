// Receive landing page: parse :id from the URL path and the token (if any)
// from the URL fragment, fetch /meta/:id, and render the view.

const $ = (id) => document.getElementById(id);

function fmtBytes(n) {
  if (n == null) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatExpiresIn(unixSeconds) {
  const delta = unixSeconds - Math.floor(Date.now() / 1000);
  if (delta <= 0) return "expired";
  const d = Math.floor(delta / 86400);
  const h = Math.floor(delta / 3600);
  const m = Math.floor(delta / 60);
  if (d >= 1) return `expires in ${d} day${d === 1 ? "" : "s"}`;
  if (h >= 1) return `expires in ${h} hour${h === 1 ? "" : "s"}`;
  return `expires in ${m} min`;
}

function parseLocation() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const id = parts[parts.length - 1] || "";
  let token = null;
  const hash = window.location.hash || "";
  for (const kv of hash.replace(/^#/, "").split("&")) {
    if (kv.startsWith("t=")) {
      token = decodeURIComponent(kv.slice(2));
      break;
    }
  }
  return { id, token };
}

function showError(msg) {
  $("loading").classList.add("hidden");
  $("ready").classList.add("hidden");
  $("error").classList.remove("hidden");
  $("error-msg").textContent = msg;
}

function showReady(meta, id, token) {
  $("loading").classList.add("hidden");
  $("error").classList.add("hidden");
  $("ready").classList.remove("hidden");

  $("filename").textContent = meta.original_name || id;
  $("size").textContent = fmtBytes(meta.size);
  $("expires").textContent = formatExpiresIn(meta.expires_at);
  if (meta.is_dir) $("dirhint").classList.remove("hidden");

  const params = new URLSearchParams({ dl: "1" });
  if (token) params.set("t", token);
  $("download-btn").href = `/d/${encodeURIComponent(id)}?${params.toString()}`;
}

async function main() {
  const { id, token } = parseLocation();
  if (!id) {
    showError("No file id in URL.");
    return;
  }
  const url = "/meta/" + encodeURIComponent(id) + (token ? "?t=" + encodeURIComponent(token) : "");
  let resp;
  try {
    resp = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    showError(`Network error: ${err.message}`);
    return;
  }
  if (resp.status === 404) {
    showError("This file has expired or doesn't exist.");
    return;
  }
  if (resp.status === 403) {
    showError(
      "This share is private. The URL needs the part after “#” " +
      "containing the access token — make sure you pasted the full URL.",
    );
    return;
  }
  if (!resp.ok) {
    let msg = `${resp.status}`;
    try { const j = await resp.json(); msg = j.message || j.error || msg; } catch {}
    showError(msg);
    return;
  }
  const meta = await resp.json();
  showReady(meta, id, token);
}

main();
