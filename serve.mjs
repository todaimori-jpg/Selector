import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

/**
 * Zero-dependency static server. ES modules will not load from file://, and
 * GitHub Pages serves over HTTPS, so this exists purely to make local testing
 * match how the app is actually delivered.
 */
const ROOT = resolve(import.meta.dirname);
const PORT = Number(process.env.PORT || 8080);
// A prefix mirrors a Pages project site at /<repo>/ so relative paths get tested for real.
const PREFIX = process.env.BASE ? `/${process.env.BASE.replace(/^\/|\/$/g, "")}` : "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path = decodeURIComponent(url.pathname);
  if (PREFIX && path.startsWith(PREFIX)) path = path.slice(PREFIX.length) || "/";

  // normalise first, then check containment: joining an unsanitised path lets ../ escape the root
  const rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
  let file = resolve(join(ROOT, rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
});

server.listen(PORT, () => {
  const shown = PREFIX ? `${PREFIX}/` : "/";
  console.log(`Selector → http://localhost:${PORT}${shown}`);
});
