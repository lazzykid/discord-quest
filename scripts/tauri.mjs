// tauri wrapper. fun fact: tauri-winres chokes on apostrophes in the project
// path while embedding the window icon (RC2135: file not found), so the icon
// is staged to %LOCALAPPDATA% and bundle.icon is overridden via TAURI_CONFIG.
// on normal paths the override just points at the same staged copy.
//   node scripts/tauri.mjs dev
//   node scripts/tauri.mjs build
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Stage the icon to an apostrophe-free path (kept in sync with ensure-host.mjs).
const iconSrc = join(root, "src-tauri", "icons", "icon.ico");
const iconDst = join(
  process.env.LOCALAPPDATA || root,
  "DiscordQuest",
  "icon.ico",
).replace(/\\/g, "/");
mkdirSync(dirname(iconDst), { recursive: true });
copyFileSync(iconSrc, iconDst);

const cfg = JSON.stringify({ bundle: { icon: [iconDst] } });

const result = spawnSync("npx", ["tauri", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  cwd: root,
  env: { ...process.env, TAURI_CONFIG: cfg },
});
process.exit(result.status ?? 1);
