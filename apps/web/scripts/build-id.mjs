// Cache-busting build token shared by the Astro config (page assets) and sync-assets.mjs
// (the demo scripts), so both stamp the SAME ?v= value. It is the short commit SHA - stable
// within a deploy, changed on every deploy - so a new build is never served from a stale
// cache, while unchanged deploys keep their cached assets. Falls back to a timestamp when
// git is unavailable (e.g. a source tarball with no .git).
import { execSync } from "node:child_process";

export function buildId() {
    try {
        return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).toString().trim();
    } catch {
        return Date.now().toString(36);
    }
}
