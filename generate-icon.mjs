import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const w = 32;
const h = 32;
const pixels = Buffer.alloc(w * h * 4, 0);
for (let i = 0; i < w * h; i++) {
  pixels[i * 4] = 242; // B
  pixels[i * 4 + 1] = 101; // G
  pixels[i * 4 + 2] = 88; // R
  pixels[i * 4 + 3] = 255;
}

const header = Buffer.alloc(40);
header.writeUInt32LE(40, 0);
header.writeInt32LE(w, 4);
header.writeInt32LE(h * 2, 8);
header.writeUInt16LE(1, 12);
header.writeUInt16LE(32, 14);

const xor = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) {
  const src = (h - 1 - y) * w * 4;
  pixels.copy(xor, y * w * 4, src, src + w * 4);
}
const andMask = Buffer.alloc(Math.ceil(w / 32) * 4 * h);
const image = Buffer.concat([header, xor, andMask]);

const ico = Buffer.alloc(6 + 16 + image.length);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = w;
ico[7] = h;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(image.length, 14);
ico.writeUInt32LE(22, 18);
image.copy(ico, 22);

const dir = join(dirname(fileURLToPath(import.meta.url)), "src-tauri", "icons");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "icon.ico"), ico);
writeFileSync("C:/Users/aitba/discord-quest-icon.ico", ico);
console.log("wrote", join(dir, "icon.ico"));
