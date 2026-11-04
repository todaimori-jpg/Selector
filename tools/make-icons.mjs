import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

/**
 * Dependency-free PNG writer for the app icons. iOS needs real raster
 * apple-touch-icons, and pulling in a canvas stack just to emit two files
 * is not worth it.
 */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(path, size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

/** Signed distance to a rounded box, in normalised 0..1 space. */
function sdRoundBox(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const CYAN = [79, 216, 232];
const MAG = [240, 106, 156];

/** Returns [r,g,b,a] or null when the dial does not cover this point. */
function dial(u, v, cx, cy, r, color, pointerAngle) {
  const dx = u - cx, dy = v - cy;
  const d = Math.hypot(dx, dy);
  if (d > r) return null;
  if (d > r - 0.006) return [40, 58, 82, 255]; // rim
  const body = mix([43, 59, 82], [19, 29, 43], Math.min(1, d / r));
  const a = Math.atan2(dx, -dy);
  let diff = Math.abs(a - pointerAngle);
  if (diff > Math.PI) diff = Math.PI * 2 - diff;
  if (d > r * 0.24 && d < r - 0.008 && diff < 0.13) return [...color, 255];
  if (d < r * 0.09) return [...color, 255]; // spindle
  return [...body, 255];
}

function render(x, y, S) {
  const u = (x + 0.5) / S, v = (y + 0.5) / S;
  const edge = sdRoundBox(u, v, 0.5, 0.5, 0.44, 0.44, 0.1);
  if (edge > 0) return [0, 0, 0, 0];

  const bg = mix([16, 24, 39], [8, 13, 23], v);
  const left = dial(u, v, 0.31, 0.5, 0.125, CYAN, -0.62);
  if (left) return left;
  const right = dial(u, v, 0.69, 0.5, 0.125, MAG, 0.52);
  if (right) return right;
  // link between the dials
  if (Math.abs(v - 0.5) < 0.008 && u > 0.435 && u < 0.565) return [120, 145, 180, 255];
  return [...bg, 255];
}

mkdirSync("icons", { recursive: true });
writePng("icons/icon-192.png", 192, render);
writePng("icons/icon-512.png", 512, render);
console.log("wrote icons/icon-192.png icons/icon-512.png");
