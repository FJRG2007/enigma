import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/** One icon as the browser needs it: what it is called, what it draws, what it files under. */
export interface IconEntry {
    /** The component name a project imports, e.g. IconExternalLink. */
    name: string;
    category: string;
    /** The SVG children, ready to be injected inside a <svg> element. */
    body: string;
}

/**
 * The icon package, read out of the checkout.
 *
 * The same order `recipe()` and `sourcePath()` read in, and for the same reason: this site
 * lives INSIDE the monorepo, so building it from a clone should document what that clone
 * contains rather than whatever was published when the site was last installed.
 *
 * Off the working directory, not `import.meta.url`: this module is bundled into
 * dist/.prerender at build time, so a URL relative to itself points at the output.
 */
const PACKAGE = resolve(process.cwd(), "..", "..", "packages", "icons");

/**
 * The drawing the generator wrote into a module, pulled back out of it.
 *
 * A generated module is one line - `export const X = icon("X", "<children>");` - with the
 * body as a JSON string literal. That literal is parsed as one rather than unescaped by
 * hand, so a quote or a backslash inside a path cannot corrupt the markup.
 */
const BODY = /icon\("[^"]+", "(.*)"\);$/m;

/**
 * Every icon in the package, sorted by name.
 *
 * Read at build time and rendered to static HTML, so the page paints the whole set on the
 * first frame and the client never fetches or parses a glyph.
 */
export function loadIcons(): IconEntry[] {
    const map = resolve(PACKAGE, "icon-map.json");
    if (!existsSync(map)) {
        // Loudly, rather than an empty grid that looks like a set with no icons in it.
        throw new Error(`The icons package is not in the checkout at ${PACKAGE}; this page is built from it.`);
    }

    const { icons } = JSON.parse(readFileSync(map, "utf8")) as {
        icons: Record<string, { category: string; }>;
    };

    return Object.keys(icons).sort().map((name) => {
        const module = resolve(PACKAGE, "src", "icons", `${name}.tsx`);
        const found = readFileSync(module, "utf8").match(BODY);
        if (!found) throw new Error(`Could not read the drawing out of ${name}.tsx.`);
        return { name, category: icons[name].category, body: JSON.parse(`"${found[1]}"`) as string };
    });
}
