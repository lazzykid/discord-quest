// Wrapper around the Tauri CLI.
//
// tauri-winres mangles paths containing apostrophes when embedding the window
// icon (RC2135: file not found), so if the project lives under such a path we
// stage the icon into %LOCALAPPDATA% and override `bundle.icon` via the
// TAURI_CONFIG merge. On apostrophe-free machines this is a no-op override.
//
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
