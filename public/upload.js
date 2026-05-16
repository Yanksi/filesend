// Upload form logic: secret entry, file/folder picker, drag-drop, small +
// multipart upload paths, folder zipping via fflate (lazy-imported only when
// a folder is actually picked).

const SMALL_UPLOAD_MAX = 95 * 1024 * 1024;
const PART_SIZE = 25 * 1024 * 1024;
const CONCURRENCY = 4;
const FOLDER_WARN_BYTES = 500 * 1024 * 1024;
const FOLDER_HARD_LIMIT = 2 * 1024 * 1024 * 1024;
const SECRET_KEY = "fw.uploadSecret";

const $ = (id) => document.getElementById(id);
const els = {
  secretView: $("secret-view"),
  secretInput: $("secret-input"),
  secretSave: $("secret-save"),
  forget: $("forget"),
  uploadView: $("upload-view"),
  drop: $("drop"),
  pickFile: $("pick-file"),
  pickFolder: $("pick-folder"),
  fileInput: $("file-input"),
  folderInput: $("folder-input"),
  selected: $("selected"),
  ttl: $("ttl"),
  vis: () => document.querySelector('input[name="vis"]:checked').value,
  name: $("name"),
  upload: $("upload"),
  progress: $("progress"),
  progressLine: $("progress-line"),
  error: $("error"),
  resultView: $("result-view"),
  resultUrl: $("result-url"),
  resultMeta: $("result-meta"),
  copy: $("copy"),
  uploadAnother: $("upload-another"),
};

let selection = null; // { kind: "file" | "folder", file?: File, files?: File[], displayName: string, totalBytes: number }

// ---------- view switching ----------

function showSecretView() {
  els.secretView.classList.remove("hidden");
  els.uploadView.classList.add("hidden");
  els.resultView.classList.add("hidden");
  els.forget.classList.add("hidden");
  els.secretInput.focus();
}

function showUploadView() {
  els.secretView.classList.add("hidden");
  els.uploadView.classList.remove("hidden");
  els.resultView.classList.add("hidden");
  els.forget.classList.remove("hidden");
}

function showResultView(result) {
  els.uploadView.classList.add("hidden");
  els.resultView.classList.remove("hidden");
  els.resultUrl.value = result.url;
  const expiresIn = formatExpiresIn(result.expires_at);
  els.resultMeta.textContent = `expires ${expiresIn} · id: ${result.id}`;
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.remove("hidden");
}
function clearError() {
  els.error.classList.add("hidden");
  els.error.textContent = "";
}

// ---------- formatting ----------

function fmtBytes(n) {
  if (n == null) return "?";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatExpiresIn(unixSeconds) {
  const delta = unixSeconds - Math.floor(Date.now() / 1000);
  if (delta <= 0) return "now";
  const h = Math.floor(delta / 3600);
  const d = Math.floor(delta / 86400);
  if (d >= 1) return `in ${d} day${d === 1 ? "" : "s"}`;
  if (h >= 1) return `in ${h} hour${h === 1 ? "" : "s"}`;
  return `in ${Math.floor(delta / 60)} min`;
}

function ttlToSeconds(spec) {
  const m = /^(\d+)([smhd])$/.exec(spec);
  if (!m) throw new Error(`bad ttl: ${spec}`);
  const n = parseInt(m[1], 10);
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

// ---------- selection ----------

function setSelection(sel) {
  selection = sel;
  if (!sel) {
    els.selected.textContent = "no selection";
    els.upload.disabled = true;
    return;
  }
  els.selected.textContent = `${sel.displayName} (${fmtBytes(sel.totalBytes)})`;
  els.name.placeholder = sel.displayName;
  els.upload.disabled = false;
  clearError();
}

function setFileSelection(file) {
  setSelection({
    kind: "file",
    file,
    displayName: file.name,
    totalBytes: file.size,
  });
}

function setFolderSelection(files) {
  if (!files.length) return;
  const first = files[0];
  const rel = first.webkitRelativePath || first.name;
  const folderName = rel.split("/")[0] || "folder";
  let total = 0;
  for (const f of files) total += f.size;
  setSelection({
    kind: "folder",
    files: Array.from(files),
    displayName: folderName,
    totalBytes: total,
  });
}

// ---------- drag and drop ----------

function setupDropZone() {
  const dz = els.drop;
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
    }),
  );
  dz.addEventListener("drop", async (e) => {
    const items = e.dataTransfer.items;
    if (!items || !items.length) return;
    // Detect folder by checking the first item.
    const firstEntry = items[0].webkitGetAsEntry ? items[0].webkitGetAsEntry() : null;
    if (firstEntry && firstEntry.isDirectory) {
      try {
        const files = await readDirectoryAsFiles(firstEntry);
        setFolderSelection(files);
      } catch (err) {
        showError(`Could not read folder: ${err.message}`);
      }
    } else {
      const file = e.dataTransfer.files[0];
      if (file) setFileSelection(file);
    }
  });
  dz.addEventListener("click", (e) => {
    if (e.target === dz) els.pickFile.click();
  });
}

async function readDirectoryAsFiles(dirEntry) {
  const out = [];
  async function walk(entry, pathPrefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      // Synthesize webkitRelativePath so the same packaging code works.
      Object.defineProperty(file, "webkitRelativePath", {
        value: `${pathPrefix}${file.name}`,
        configurable: true,
      });
      out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns at most ~100 at a time; loop until empty.
      while (true) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) {
          await walk(child, `${pathPrefix}${entry.name}/`);
        }
      }
    }
  }
  await walk(dirEntry, "");
  return out;
}

// ---------- progress ----------

let bytesUploaded = 0;
let bytesTotal = 0;

function progressReset(total) {
  bytesUploaded = 0;
  bytesTotal = total;
  els.progress.classList.remove("hidden");
  els.progressLine.classList.remove("hidden");
  els.progress.max = total;
  els.progress.value = 0;
  els.progressLine.textContent = `0 / ${fmtBytes(total)}`;
}

function progressAdd(bytes) {
  bytesUploaded += bytes;
  els.progress.value = bytesUploaded;
  const pct = Math.floor((bytesUploaded / bytesTotal) * 100);
  els.progressLine.textContent = `${pct}%  ${fmtBytes(bytesUploaded)} / ${fmtBytes(bytesTotal)}`;
}

function progressHide() {
  els.progress.classList.add("hidden");
  els.progressLine.classList.add("hidden");
}

// ---------- upload (small) via XHR ----------

function xhrUpload(method, url, body, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { resolve(xhr.responseText); }
      } else {
        let msg = xhr.responseText;
        try { const j = JSON.parse(xhr.responseText); msg = j.message || j.error || msg; } catch {}
        reject(new Error(`${xhr.status}: ${msg}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(body);
  });
}

async function uploadSmall({ blob, secret, ttlSec, visibility, name, isDir, contentType }) {
  const qs = new URLSearchParams({
    ttl: String(ttlSec),
    visibility,
    name,
    is_dir: isDir ? "true" : "false",
  });
  let last = 0;
  return xhrUpload(
    "POST",
    `/upload?${qs.toString()}`,
    blob,
    { Authorization: `Bearer ${secret}`, "Content-Type": contentType },
    (loaded) => { progressAdd(loaded - last); last = loaded; },
  );
}

// ---------- upload (multipart) via fetch ----------

async function uploadMultipart({ blob, secret, ttlSec, visibility, name, isDir, contentType }) {
  const qs = new URLSearchParams({
    ttl: String(ttlSec),
    visibility,
    name,
    is_dir: isDir ? "true" : "false",
  });
  const initResp = await fetch(`/mpu/init?${qs.toString()}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": contentType },
  });
  if (!initResp.ok) throw new Error(await errorText(initResp));
  const init = await initResp.json();

  const total = blob.size;
  const partCount = Math.ceil(total / PART_SIZE);
  const parts = new Array(partCount);
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= partCount) return;
      const offset = i * PART_SIZE;
      const length = Math.min(PART_SIZE, total - offset);
      const chunk = blob.slice(offset, offset + length);
      const partUrl = `/mpu/part?` + new URLSearchParams({
        key: init.key, upload_id: init.upload_id, part: String(i + 1),
      });
      const resp = await fetch(partUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/octet-stream" },
        body: chunk,
      });
      if (!resp.ok) throw new Error(await errorText(resp));
      const json = await resp.json();
      parts[i] = { part: json.part, etag: json.etag };
      progressAdd(length);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, partCount) }, worker));
  } catch (err) {
    fetch(`/mpu/abort`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ key: init.key, upload_id: init.upload_id }),
    }).catch(() => {});
    throw err;
  }

  const completeResp = await fetch(`/mpu/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key: init.key, upload_id: init.upload_id, parts }),
  });
  if (!completeResp.ok) throw new Error(await errorText(completeResp));
  return {
    id: init.id, url: init.url, token: init.token, expires_at: init.expires_at,
  };
}

async function errorText(resp) {
  let body = await resp.text();
  try { const j = JSON.parse(body); body = j.message || j.error || body; } catch {}
  return `${resp.status}: ${body}`;
}

// ---------- folder zipping ----------

async function zipFolderFiles(files) {
  // Pre-flight memory sanity checks.
  let totalIn = 0;
  for (const f of files) totalIn += f.size;
  if (totalIn > FOLDER_HARD_LIMIT) {
    throw new Error(`Folder is ${fmtBytes(totalIn)}, over the browser 2 GB hard limit. Use the CLI.`);
  }
  if (totalIn > FOLDER_WARN_BYTES) {
    const ok = confirm(
      `This folder is ${fmtBytes(totalIn)}. Zipping it in the browser may run out of memory. ` +
      `For folders this size the CLI (\`fw send\`) is more reliable. Continue anyway?`,
    );
    if (!ok) throw new Error("Cancelled by user.");
  }

  const { zipSync } = await import(
    "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/index.mjs"
  ).catch(() => {
    throw new Error(
      "Could not load fflate from jsdelivr.net (needed for folder zipping). " +
      "Single-file uploads still work; for folders use the CLI.",
    );
  });

  const tree = {};
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    const buf = new Uint8Array(await f.arrayBuffer());
    tree[rel] = buf;
  }
  return zipSync(tree, { level: 6 });
}

// ---------- main upload action ----------

async function startUpload() {
  clearError();
  if (!selection) return;
  const secret = localStorage.getItem(SECRET_KEY);
  if (!secret) { showSecretView(); return; }

  const visibility = els.vis();
  const ttlSec = ttlToSeconds(els.ttl.value);
  const nameOverride = els.name.value.trim();

  els.upload.disabled = true;

  try {
    let blob, displayName, isDir, contentType;
    if (selection.kind === "file") {
      blob = selection.file;
      displayName = nameOverride || selection.displayName;
      isDir = false;
      contentType = selection.file.type || "application/octet-stream";
    } else {
      progressReset(selection.totalBytes); // bytes-to-zip + bytes-to-upload share the bar coarsely
      els.progressLine.textContent = "zipping folder...";
      const zipped = await zipFolderFiles(selection.files);
      blob = new Blob([zipped], { type: "application/zip" });
      displayName = nameOverride || selection.displayName;
      isDir = true;
      contentType = "application/zip";
    }

    progressReset(blob.size);
    const args = { blob, secret, ttlSec, visibility, name: displayName, isDir, contentType };
    const result = blob.size <= SMALL_UPLOAD_MAX
      ? await uploadSmall(args)
      : await uploadMultipart(args);

    progressHide();
    showResultView(result);
  } catch (err) {
    progressHide();
    showError(err.message || String(err));
    els.upload.disabled = false;
    if (/401/.test(err.message)) {
      // Bad secret; nudge the user to re-enter.
      localStorage.removeItem(SECRET_KEY);
      showSecretView();
    }
  }
}

// ---------- wire-up ----------

function init() {
  els.secretSave.addEventListener("click", () => {
    const v = els.secretInput.value.trim();
    if (!v) return;
    localStorage.setItem(SECRET_KEY, v);
    els.secretInput.value = "";
    showUploadView();
  });
  els.secretInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.secretSave.click();
  });
  els.forget.addEventListener("click", (e) => {
    e.preventDefault();
    if (!confirm("Forget the upload secret stored in this browser?")) return;
    localStorage.removeItem(SECRET_KEY);
    showSecretView();
  });

  els.pickFile.addEventListener("click", (e) => { e.stopPropagation(); els.fileInput.click(); });
  els.pickFolder.addEventListener("click", (e) => { e.stopPropagation(); els.folderInput.click(); });
  els.fileInput.addEventListener("change", () => {
    const f = els.fileInput.files[0];
    if (f) setFileSelection(f);
  });
  els.folderInput.addEventListener("change", () => {
    if (els.folderInput.files.length) setFolderSelection(els.folderInput.files);
  });
  setupDropZone();

  els.upload.addEventListener("click", startUpload);

  els.copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.resultUrl.value);
      els.copy.textContent = "Copied";
      setTimeout(() => { els.copy.textContent = "Copy"; }, 1500);
    } catch {
      els.resultUrl.select();
      document.execCommand("copy");
    }
  });
  els.uploadAnother.addEventListener("click", () => {
    setSelection(null);
    els.name.value = "";
    els.error.classList.add("hidden");
    progressHide();
    els.upload.disabled = false;
    showUploadView();
  });

  if (localStorage.getItem(SECRET_KEY)) showUploadView();
  else showSecretView();
}

init();
