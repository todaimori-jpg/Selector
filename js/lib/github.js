import { idb } from "./idb.js";

const KEY = "gh-config";
const API = "https://api.github.com";
// GitHub's Contents API refuses anything over 1 MB, so this is a hard product limit.
export const MAX_SYNC_BYTES = 1024 * 1024;

/** Chunked base64: String.fromCharCode(...big) blows the argument stack on real files. */
function bytesToBase64(u8) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(bin);
}

export async function loadConfig() {
  return (await idb.kv.get(KEY)) || { owner: "", repo: "", branch: "main", path: "takes", token: "" };
}

export async function saveConfig(cfg) {
  await idb.kv.set(KEY, { ...cfg });
}

export async function clearConfig() {
  await idb.kv.del(KEY);
}

function auth(cfg) {
  if (!cfg.token) throw new Error("Add a token in Settings first.");
  if (!cfg.owner || !cfg.repo) throw new Error("Owner and repository are required.");
  return { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

async function req(cfg, path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...auth(cfg), ...(init.headers || {}) } });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const hint = res.status === 401 ? "Token is invalid or expired. "
      : res.status === 403 ? "Token lacks Contents permission, or you hit an API rate limit. "
      : res.status === 404 ? "Repository, branch or path not found (a new path is created on first write). "
      : "";
    throw new Error(`${hint}${res.status}: ${body?.message || res.statusText}`);
  }
  return body;
}

export const repoPath = (cfg, name) => `${(cfg.path || "").replace(/^\/|\/$/g, "")}/${name}`.replace(/^\/+/, "");

export async function test(cfg) {
  const r = await req(cfg, `/repos/${cfg.owner}/${cfg.repo}`);
  return `${r.full_name} reachable as ${r.default_branch || cfg.branch}`;
}

export async function listTakes(cfg) {
  const p = repoPath(cfg, "");
  if (!p) return [];
  const body = await req(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${p}?ref=${encodeURIComponent(cfg.branch || "main")}`)
    .catch((e) => (String(e.message).includes("404") ? [] : Promise.reject(e)));
  if (!Array.isArray(body)) return [];
  return body.filter((f) => f.type === "file").map((f) => ({ name: f.name, size: f.size, sha: f.sha, path: f.path }));
}

export async function fetchTake(cfg, file) {
  const body = await req(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(file.path)}?ref=${encodeURIComponent(cfg.branch || "main")}`);
  const bin = atob(body.content.replace(/\n/g, ""));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: body.media_type || "audio/mp4" });
}

/** Create or update one file. Returns the commit sha. */
export async function pushTake(cfg, name, blob) {
  if (blob.size > MAX_SYNC_BYTES) {
    throw new Error(`That take is ${(blob.size / 1048576).toFixed(1)} MB. GitHub's Contents API caps writes at 1 MB — download it instead, or trim it.`);
  }
  const path = repoPath(cfg, name);
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let sha;
  try {
    const existing = await req(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(cfg.branch || "main")}`);
    sha = existing.sha;
  } catch { /* new file */ }
  const body = {
    message: `Add recording ${name}`,
    content: bytesToBase64(u8),
    branch: cfg.branch || "main",
  };
  if (sha) body.sha = sha;
  const res = await req(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return { sha: res?.commit?.sha, path };
}
