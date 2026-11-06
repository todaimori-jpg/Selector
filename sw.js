const VERSION = "v5-phone-cue";
const SHELL = [
  "./",
  "./index.html",
  "./phone-cue.html",
  "./phone-cue.js",
  "./phone-cue.css",
  "./css/app.css",
  "./js/main.js",
  "./js/ui/app.js",
  "./js/ui/build.js",
  "./js/ui/touch.js",
  "./js/ui/waveform.js",
  "./js/ui/meter.js",
  "./js/audio/engine.js",
  "./js/audio/deck.js",
  "./js/audio/sources.js",
  "./js/audio/peaks.js",
  "./js/audio/recorder.js",
  "./js/lib/dom.js",
  "./js/lib/idb.js",
  "./js/lib/library.js",
  "./js/lib/session.js",
  "./js/lib/github.js",
  "./js/lib/spotify.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(`${VERSION}:shell`);
    // resolve against the sw location so Pages project subpaths (/repo/) work
    await Promise.all(SHELL.map((p) => cache.add(new URL(p, self.location)).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(VERSION)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Never intercept cross-origin: the GitHub API and its tokens stay on the network.
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET") return;

  if (req.mode === "navigate") {
    const shell = url.pathname.endsWith("/phone-cue.html") ? "./phone-cue.html" : "./index.html";
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(`${VERSION}:shell`);
        if (fresh.ok) cache.put(shell, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(shell)) || Response.error();
      }
    })());
    return;
  }

  // Code is network-first: a cached module that no longer matches the rest of the
  // graph is the worst possible failure mode here, because the app simply stops
  // booting with no error. Icons and the manifest keep cache-first for fast paint.
  if (/\.(?:js|css)(?:\?|$)/.test(url.pathname)) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) caches.open(`${VERSION}:shell`).then((c) => c.put(req, fresh.clone()));
        return fresh;
      } catch {
        return (await caches.match(req)) || Response.error();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.ok) caches.open(`${VERSION}:shell`).then((c) => c.put(req, res.clone()));
    return res;
  })());
});
