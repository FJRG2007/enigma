import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/** One icon as the browser needs it: what it is called, what it draws, what it files under. */
export interface IconEntry {
    /** The component name a project imports, e.g. IconExternalLink. */
    name: string;
    category: string;
    /**
     * What the glyph is called in the set it was drawn for, as plain words.
     *
     * A second thing to match on and never something to show. The component names are the
     * vocabulary of one library, and a reader types the vocabulary of the thing they want:
     * "camera" should reach the video icon too, because that glyph IS a video camera and is
     * called one upstream. Ranked below the name so the literal match still comes first.
     */
    alias: string;
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
 * The weight name, dropped from an alias so it never reaches the search index.
 *
 * Left in, every alias would end in the same words and a search for either of them would
 * match all 391. Read from the map's declared default rather than hard-coded, so the day a
 * second weight ships this keeps stripping the right thing instead of silently stopping.
 */
const weightSuffix = (weight: string): RegExp => new RegExp(`-${weight}$`);

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

    const { icons, weights } = JSON.parse(readFileSync(map, "utf8")) as {
        icons: Record<string, { category: string; glyph: string; }>;
        weights?: { default: string; available: string[]; };
    };

    // The default weight's modules live at the root of `src`, which is the set this page
    // browses. Another weight is a directory beside it and would be browsed on its own.
    const suffix = weightSuffix(weights?.default ?? "bold-duotone");

    return Object.keys(icons).sort().map((name) => {
        const module = resolve(PACKAGE, "src", "icons", `${name}.tsx`);
        const found = readFileSync(module, "utf8").match(BODY);
        if (!found) throw new Error(`Could not read the drawing out of ${name}.tsx.`);
        return {
            name,
            category: icons[name].category,
            alias: icons[name].glyph.replace(suffix, "").replace(/-/g, " "),
            body: JSON.parse(`"${found[1]}"`) as string,
        };
    });
}
