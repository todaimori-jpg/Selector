import { idb } from "./idb.js";

/**
 * Spotify, for an app that is only static files.
 *
 * What this deliberately is not: full-length streaming. The Web Playback SDK needs
 * Premium and Spotify's own player, and the Web API will not hand a browser the
 * audio of a full track under any scope. What is available is a 30-second
 * `preview_url` per track, which arrives as an ordinary AAC file over HTTPS. That
 * is long enough to fold a phrase, a vocal, or a transition into a radio blend, and
 * short enough that it must be treated as a sample rather than a bed.
 *
 * Auth is PKCE with no client secret, because a secret in a GitHub Pages bundle is
 * not a secret. The user registers their own app and pastes the client ID here.
 */

const CFG_KEY = "spotify-cfg";
const TOK_KEY = "spotify-token";
const AUTHORIZE = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

export const redirectUri = () => location.origin + location.pathname;

// ---------- pkce ----------
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function sha256(text) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// ---------- config + token ----------
export async function loadConfig() {
  return (await idb.kv.get(CFG_KEY)) || { clientId: "", enabled: false };
}

export async function saveConfig(cfg) {
  await idb.kv.set(CFG_KEY, { clientId: cfg.clientId.trim(), enabled: !!cfg.enabled });
}

export async function clearAuth() {
  await idb.kv.del(TOK_KEY);
}

async function tokens() {
  return (await idb.kv.get(TOK_KEY)) || null;
}

async function storeToken(t, now = Date.now()) {
  const rec = {
    access: t.access_token,
    refresh: t.refresh_token || t._refresh,
    expiresAt: now + (t.expires_in || 3600) * 1000,
  };
  await idb.kv.set(TOK_KEY, rec);
  return rec;
}

/** Bearer token, refreshed in place. Returns null when the user has not connected. */
export async function accessToken() {
  const t = await tokens();
  if (!t?.access) return null;
  if (t.expiresAt - 60000 > Date.now()) return t.access;
  if (!t.refresh) {
    await clearAuth();
    return null;
  }
  const cfg = await loadConfig();
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refresh,
      client_id: cfg.clientId,
    }),
  });
  if (!r.ok) {
    await clearAuth();
    return null;
  }
  return (await storeToken(await r.json())).access;
}

export const isAuthed = async () => !!(await accessToken());

// ---------- login flow ----------
export async function beginLogin() {
  const cfg = await loadConfig();
  if (!cfg.clientId) throw new Error("Enter a Spotify client ID first.");
  const verifier = random(32);
  await idb.kv.set("spotify-verifier", verifier);
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: await sha256(verifier),
    scope: "streaming",
    show_dialog: "false",
  });
  location.assign(`${AUTHORIZE}?${q}`);
}

/** Runs before the UI builds: finishes the redirect if this load is one. */
export async function completeLogin() {
  const q = new URLSearchParams(location.search);
  const code = q.get("code");
  const err = q.get("error");
  if (!code && !err) return null;
  const clean = () => history.replaceState({}, document.title, location.pathname);
  if (err) {
    clean();
    return { ok: false, message: `Spotify refused the sign-in (${err}).` };
  }
  try {
    const cfg = await loadConfig();
    const verifier = (await idb.kv.get("spotify-verifier")) || "";
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        client_id: cfg.clientId,
        code_verifier: verifier,
      }),
    });
    const j = await r.json();
    if (!r.ok) return { ok: false, message: j.error_description || `Token exchange failed (${r.status}).` };
    await storeToken(j);
    await idb.kv.del("spotify-verifier");
    clean();
    return { ok: true, message: "Spotify connected." };
  } catch (e) {
    clean();
    return { ok: false, message: `Spotify sign-in failed: ${e.message}` };
  }
}

// ---------- search ----------
const artist = (item) => item.artists.map((a) => a.name).join(", ");

export async function search(query, limit = 25) {
  const token = await accessToken();
  if (!token) return { error: "not-authed", items: [] };
  const r = await fetch(`${API}/search?type=track&limit=${limit}&q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 401) {
    await clearAuth();
    return { error: "expired", items: [] };
  }
  if (r.status === 429) return { error: "rate", items: [] };
  if (!r.ok) return { error: `Spotify error ${r.status}`, items: [] };
  const j = await r.json();
  return {
    items: (j.tracks?.items || []).filter(Boolean).map((t) => ({
      id: t.id,
      title: t.name,
      artist: artist(t),
      album: t.album?.name || "",
      ms: t.duration_ms,
      preview: t.preview_url || null,
      uri: t.uri,
    })),
  };
}

/**
 * Pulls the 30-second clip as a real file so it goes through the same analysis as
 * anything dropped from disk: peaks, cue point, loudness trim, session log.
 */
export async function fetchPreview(item) {
  if (!item.preview) return { error: "no-preview" };
  let blob;
  try {
    const r = await fetch(item.preview);
    if (!r.ok) return { error: `http-${r.status}` };
    blob = await r.blob();
  } catch (e) {
    // audio.scdn.co is not CORS-clean for every region/app type; the clip still
    // plays if opened directly, so say so instead of failing silently.
    return { error: "cors" };
  }
  const type = blob.type || "audio/mp4";
  const ext = type.includes("mpeg") ? "mp3" : type.includes("ogg") ? "ogg" : "m4a";
  const name = `${item.artist} - ${item.title} (30s preview)`.replace(/\.[^.]+$/, "");
  return { file: new File([blob], `${name}.${ext}`, { type, lastModified: Date.now() }) };
}

export const deepLink = (item) => `https://open.spotify.com/track/${item.id}`;

export const HINTS = {
  "not-authed": "Connect Spotify in Settings first.",
  expired: "The Spotify token expired — reconnect in Settings.",
  rate: "Spotify rate-limited the search; wait a few seconds.",
  "no-preview": "This track has no 30-second preview on Spotify.",
  cors: "Spotify's preview host blocked the download from this origin (CORS). The clip still opens in a new tab.",
};
