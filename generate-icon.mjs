// draws the app icon (ink rounded square + acid bolt, same shape as the
// titlebar mark) into a multi-size .ico: bmp entries for 16/24/32/48,
// png for 256. also dumps a preview png to %TEMP%.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)); // script lives at project root

// bolt polygon in a 20x20 design grid (matches the titlebar mark)
const BOLT = [
  [11.5, 1],
  [3, 11.5],
  [8, 11.5],
  [8.5, 19],
  [17, 8.5],
  [12, 8.5],
];
const INK = [11, 12, 8]; // RGB #0B0C08
const ACID = [216, 255, 61]; // RGB #D8FF3D

function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inRoundedRect(px, py, s, r) {
  if (px < 0 || py < 0 || px >= s || py >= s) return false;
  const cx = Math.min(Math.max(px, r), s - r);
  const cy = Math.min(Math.max(py, r), s - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// point-in-shape tests work in "icon units" (0..1)
const scaledBolt = (s) => BOLT.map(([x, y]) => [(x / 20) * s, (y / 20) * s]);

function renderRGBA(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  const bolt = scaledBolt(size);
  const ss = 5; // supersampling grid per axis
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hitBg = 0;
      let hitBolt = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          if (inRoundedRect(px, py, size, r)) {
            hitBg++;
            if (inPoly(px, py, bolt)) hitBolt++;
          }
        }
      }
      const total = ss * ss;
      const i = (y * size + x) * 4;
      let R = 0, G = 0, B = 0, A = Math.round((hitBg / total) * 255);
      if (hitBg > 0) {
        const t = hitBolt / hitBg;
        R = Math.round(INK[0] + (ACID[0] - INK[0]) * t);
        G = Math.round(INK[1] + (ACID[1] - INK[1]) * t);
        B = Math.round(INK[2] + (ACID[2] - INK[2]) * t);
      }
      rgba[i] = R;
      rgba[i + 1] = G;
      rgba[i + 2] = B;
      rgba[i + 3] = A;
    }
  }
  return rgba;
}

// ── minimal PNG encoder (8-bit RGBA, no filters) ────────────────────────────
const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO assembly ─────────────────────────────────────────────────────────────
function dibFromRGBA(size, rgba) {
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8); // XOR + AND
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  // DIB pixels are BGRA, bottom-up — our buffer is RGBA, top-down.
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((size - 1 - y) * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = rgba[src + 2]; // B
      xor[dst + 1] = rgba[src + 1]; // G
      xor[dst + 2] = rgba[src]; // R
      xor[dst + 3] = rgba[src + 3]; // A
    }
  }
  const andRow = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(andRow * size);
  return Buffer.concat([hdr, xor, and]);
}

const SIZES = [16, 24, 32, 48, 256];
const images = SIZES.map((s) => ({ size: s, rgba: renderRGBA(s) }));

const entries = [];
for (const { size, rgba } of images) {
  if (size <= 48) {
    entries.push({ size, data: dibFromRGBA(size, rgba) });
  } else {
    entries.push({ size, data: encodePNG(size, rgba) });
  }
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(entries.length, 4);

const dir = Buffer.alloc(16 * entries.length);
let offset = 6 + 16 * entries.length;
entries.forEach((e, i) => {
  const b = i * 16;
  dir[b] = e.size === 256 ? 0 : e.size;
  dir[b + 1] = e.size === 256 ? 0 : e.size;
  dir.writeUInt16LE(1, b + 4); // planes
  dir.writeUInt16LE(32, b + 6); // bpp
  dir.writeUInt32LE(e.data.length, b + 8);
  dir.writeUInt32LE(offset, b + 12);
  offset += e.data.length;
});

const ico = Buffer.concat([header, dir, ...entries.map((e) => e.data)]);

const iconDir = join(root, "src-tauri", "icons");
mkdirSync(iconDir, { recursive: true });
writeFileSync(join(iconDir, "icon.ico"), ico);

const preview = encodePNG(256, images[images.length - 1].rgba);
const previewPath = join(tmpdir(), "dq-icon-preview.png");
writeFileSync(previewPath, preview);
console.log("wrote", join(iconDir, "icon.ico"), "and preview", previewPath);
