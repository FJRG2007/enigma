/**
 * Vendor the framework-agnostic half of `@enigmax/primitives` into the dashboard.
 *
 * The dashboard is one static HTML file served over loopback, with no bundler and no
 * node_modules to resolve from - so it takes the package the way it takes Chart.js: a built
 * file beside it. Only the CORE goes in (no React, no renderers): the dashboard writes its
 * own DOM, and what it needed was never the markup - it was the search engine, the keyboard
 * arithmetic, the grouping and the history it had hand-rolled.
 *
 *   node scripts/sync-primitives.mjs           rebuild the vendored bundle
 *   node scripts/sync-primitives.mjs --check    fail if it is out of date, write nothing
 *
 * `--check` is what stops it drifting: the bundle is committed, so an edit to the package
 * that never reaches the dashboard would otherwise be invisible until someone opened the
 * palette and found the old behaviour.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "packages", "primitives", "src", "index.ts");
const OUT = join(ROOT, "packages", "dashboard", "assets", "lib", "enigma-primitives.js");

const check = process.argv.includes("--check");

const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: "iife",
    // A classic script tag, so the exports arrive as one global rather than as an import.
    globalName: "EnigmaPrimitives",
    target: "es2020",
    write: false,
    // The package's own path alias, which esbuild does not read from tsconfig here.
    alias: { "@": join(ROOT, "packages", "primitives", "src") },
    banner: { js: "/* @enigmax/primitives core, vendored by scripts/sync-primitives.mjs. Do not edit. */" }
});

const next = result.outputFiles[0].text;
const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";

if (check) {
    if (current === next) {
        console.log("sync-primitives: the vendored bundle matches the package.");
        process.exit(0);
    }
    console.error("sync-primitives: packages/dashboard/assets/lib/enigma-primitives.js is out of date with @enigmax/primitives.");
    console.error("  node scripts/sync-primitives.mjs");
    process.exit(1);
}

if (current === next) {
    console.log("sync-primitives: already current.");
} else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, next);
    console.log(`sync-primitives: wrote ${(Buffer.byteLength(next) / 1024).toFixed(1)} KB into the dashboard.`);
}
