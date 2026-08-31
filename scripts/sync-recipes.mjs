/**
 * Write the stylesheets that also exist as strings in the source.
 *
 * `<Toaster />` injects its theme, so the theme has to be a JS string; `enigma add toast
 * --copy` and `@enigmax/primitives/toast.css` hand out a real `.css` file. Those are the
 * same look, and two hand-maintained copies of one look drift the first time somebody edits
 * the one they happened to open - so the TS module is the source and the CSS is generated.
 *
 *   node scripts/sync-recipes.mjs           rewrite the generated stylesheets
 *   node scripts/sync-recipes.mjs --check    fail if one is out of date, write nothing
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "packages", "primitives", "src", "react", "toast-styles.ts");
const OUT = join(ROOT, "packages", "primitives", "recipes", "toast", "styles.css");

const HEADER = `/*
 * The toast theme.
 *
 * GENERATED from src/react/toast-styles.ts by scripts/sync-recipes.mjs - edit that file, not
 * this one. It exists as a stylesheet as well as a string because <Toaster /> injects the
 * theme itself, and this is the same look for anyone who would rather import it, copy it
 * with \`enigma add toast --copy\`, or fork it outright.
 *
 * Every value is a custom property on [data-enigma-toaster]: override them there, or on
 * :root, and you have a different toast without touching a selector.
 */
`;

/** The template literal's body, which is the stylesheet. */
function extract(source) {
    const start = source.indexOf("export const TOAST_STYLES = `");
    if (start === -1) throw new Error("TOAST_STYLES not found in toast-styles.ts");
    const from = source.indexOf("`", start) + 1;
    const to = source.indexOf("`;", from);
    if (to === -1) throw new Error("TOAST_STYLES is not terminated");
    return source.slice(from, to);
}

const next = `${HEADER}${extract(readFileSync(SOURCE, "utf8")).trimStart()}`;
const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";

if (process.argv.includes("--check")) {
    if (current === next) {
        console.log("sync-recipes: the generated stylesheets match their source.");
        process.exit(0);
    }
    console.error("sync-recipes: packages/primitives/recipes/toast/styles.css is out of date with src/react/toast-styles.ts.");
    console.error("  node scripts/sync-recipes.mjs");
    process.exit(1);
}

if (current === next) {
    console.log("sync-recipes: already current.");
} else {
    writeFileSync(OUT, next);
    console.log(`sync-recipes: wrote ${(Buffer.byteLength(next) / 1024).toFixed(1)} KB of toast theme.`);
}
