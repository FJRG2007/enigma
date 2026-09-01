/**
 * Write the stylesheets that also exist as strings in the source.
 *
 * `<Toaster />` and `<Select.Root>` inject their theme, so the theme has to be a JS string;
 * `enigma add <component> --copy` and `@enigmax/primitives/<component>.css` hand out a real
 * `.css` file. Those are the same look, and two hand-maintained copies of one look drift the
 * first time somebody edits the one they happened to open - so the TS module is the source
 * and the CSS is generated.
 *
 *   node scripts/sync-recipes.mjs           rewrite the generated stylesheets
 *   node scripts/sync-recipes.mjs --check    fail if one is out of date, write nothing
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMITIVES = join(ROOT, "packages", "primitives");

/** Every sheet that lives twice: the module that owns it, and the file generated from it. */
const SHEETS = [
    { name: "toast", export: "TOAST_STYLES", source: join(PRIMITIVES, "src", "react", "toast", "styles.ts"), out: join(PRIMITIVES, "recipes", "toast", "styles.css") },
    { name: "select", export: "SELECT_STYLES", source: join(PRIMITIVES, "src", "react", "select", "styles.ts"), out: join(PRIMITIVES, "recipes", "select", "styles.css") },
    { name: "context-menu", export: "CONTEXT_MENU_STYLES", source: join(PRIMITIVES, "src", "react", "context-menu", "styles.ts"), out: join(PRIMITIVES, "recipes", "context-menu", "styles.css") }
];

function header(sheet) {
    const from = sheet.source.slice(PRIMITIVES.length + 1).replace(/\\/g, "/");
    return `/*
 * The ${sheet.name} stylesheet.
 *
 * GENERATED from ${from} by scripts/sync-recipes.mjs - edit that file, not
 * this one. It exists as a stylesheet as well as a string because the component injects it,
 * and this is the same sheet for anyone who would rather import it, copy it with
 * \`enigma add ${sheet.name} --copy\`, or fork it outright.
 */
`;
}

/** The template literal's body, which is the stylesheet. */
function extract(source, name, sheet) {
    const start = source.indexOf(`export const ${name} = \``);
    if (start === -1) throw new Error(`${name} not found in ${sheet.source}`);
    const from = source.indexOf("`", start) + 1;
    const to = source.indexOf("`;", from);
    if (to === -1) throw new Error(`${name} is not terminated`);
    return source.slice(from, to);
}

let stale = 0;
let written = 0;

for (const sheet of SHEETS) {
    const next = `${header(sheet)}${extract(readFileSync(sheet.source, "utf8"), sheet.export, sheet).trimStart()}`;
    const current = existsSync(sheet.out) ? readFileSync(sheet.out, "utf8") : "";
    if (current === next) continue;

    if (process.argv.includes("--check")) {
        console.error(`sync-recipes: ${sheet.out.slice(ROOT.length + 1).replace(/\\/g, "/")} is out of date with its source.`);
        stale++;
        continue;
    }

    mkdirSync(dirname(sheet.out), { recursive: true });
    writeFileSync(sheet.out, next);
    console.log(`sync-recipes: wrote ${(Buffer.byteLength(next) / 1024).toFixed(1)} KB of ${sheet.name} theme.`);
    written++;
}

if (stale) {
    console.error("  node scripts/sync-recipes.mjs");
    process.exit(1);
}
if (process.argv.includes("--check")) console.log("sync-recipes: the generated stylesheets match their source.");
else if (!written) console.log("sync-recipes: already current.");
