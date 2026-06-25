// Mirror the repo's shared brand assets into public/ so Astro serves them, instead of
// duplicating the binaries inside the web app. Single source of truth: <repo>/assets.
// Runs as predev/prebuild; the copied files are gitignored.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));   // apps/web/scripts
const repo = join(here, "..", "..", "..");              // repo root
const pub = join(here, "..", "public");                 // apps/web/public

mkdirSync(join(pub, "logos"), { recursive: true });
cpSync(join(repo, "assets", "logos"), join(pub, "logos"), { recursive: true });
cpSync(join(repo, "assets", "images", "dashboard.png"), join(pub, "dashboard.png"));

console.log("Synced logos/ and dashboard.png into public/.");
