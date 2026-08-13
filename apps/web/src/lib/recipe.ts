import { readFileSync } from "node:fs";
import { createHighlighter } from "shiki";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Matches the theme the MDX fenced blocks are rendered with (astro.config.mjs). */
const THEME = "vesper";

/**
 * Read a recipe file out of the INSTALLED package at build time.
 *
 * The docs then show the exact component `enigma add --copy` writes, at the version this
 * site depends on, and the two can never drift - a code sample pasted into an MDX file
 * goes stale the first time the recipe is edited and nothing reports it.
 */
export function recipe(pkg: string, file: string): string {
    // Resolved through registry.json rather than package.json: the packages declare an
    // `exports` map, and package.json is deliberately not a public subpath of it.
    const root = require.resolve(`${pkg}/registry.json`).replace(/registry\.json$/, "");
    return readFileSync(`${root}recipes/${file}`, "utf8").trimEnd();
}

/**
 * Shiki is started once, at module load, so the highlighter can be called synchronously
 * below. An `export const x = await ...` inside MDX does NOT resolve - the Promise reaches
 * the template and renders as nothing, which is how the first version shipped an empty
 * block - so the await has to live here instead.
 */
const highlighter = await createHighlighter({ themes: [THEME], langs: ["tsx", "ts", "css"] });

/**
 * The same file, highlighted.
 *
 * A fenced block in MDX goes through Shiki automatically; a string rendered into a <pre>
 * does not, and arrives as flat grey text. Running it through the SAME theme keeps the
 * two kinds of block indistinguishable on the page.
 */
export function highlightedRecipe(pkg: string, file: string, lang?: string): string {
    const source = recipe(pkg, file);
    const language = lang ?? (file.endsWith(".css") ? "css" : file.endsWith(".tsx") ? "tsx" : "ts");
    return highlighter.codeToHtml(source, { lang: language, theme: THEME });
}
