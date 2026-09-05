// Ensures src-tauri/binaries/game_host.exe exists (and optionally rebuilds it).
// Tauri validates bundle resource paths on every cargo build, so the file must
// be present even for `tauri dev`.
//   node scripts/ensure-host.mjs          -> build only if missing
//   node scripts/ensure-host.mjs --fresh  -> always rebuild from source
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcTauri = join(root, "src-tauri");
const built = join(srcTauri, "target", "release", "game_host.exe");
const staged = join(srcTauri, "binaries", "game_host.exe");

const fresh = process.argv.includes("--fresh");

// Stage the window icon next to the game files (apostrophe-free path; the
// Tauri CLI wrapper points bundle.icon at it — see scripts/tauri.mjs).
const iconSrc = join(srcTauri, "icons", "icon.ico");
const iconDst = join(process.env.LOCALAPPDATA || root, "DiscordQuest", "icon.ico");
mkdirSync(dirname(iconDst), { recursive: true });
copyFileSync(iconSrc, iconDst);

if (fresh || !existsSync(staged)) {
  execSync('cargo build --release -p game-host', { cwd: srcTauri, stdio: "inherit" });
  mkdirSync(dirname(staged), { recursive: true });
  copyFileSync(built, staged);
  console.log("game_host.exe staged ->", staged);
} else {
  console.log("game_host.exe already staged");
}
