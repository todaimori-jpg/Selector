/**
 * Parses every module in the project without running it.
 *
 * A stray bracket in one control file makes the whole module graph fail to
 * evaluate, and the browser reports nothing in the console — the app simply never
 * builds its UI. Parsing catches that in a second, so run it before pushing.
 *
 * Each file is checked through a temporary `.mjs` copy because that extension is
 * unambiguously an ES module, whatever the host's Node version does with `--check`.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

const files = [...walk(join(root, "js")), ...walk(join(root, "tools")), join(root, "sw.js"), join(root, "serve.mjs")];
const tmp = join(tmpdir(), `selector-check-${process.pid}.mjs`);
let bad = 0;

try {
  for (const f of files) {
    writeFileSync(tmp, readFileSync(f));
    const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    if (r.status !== 0) {
      bad++;
      console.error(`FAIL ${f.replace(root + "/", "")}`);
      console.error(r.stderr.trim().replace(tmp, f) + "\n");
    }
  }
} finally {
  rmSync(tmp, { force: true });
}

console.log(`${files.length - bad}/${files.length} files parse cleanly`);
process.exit(bad ? 1 : 0);
