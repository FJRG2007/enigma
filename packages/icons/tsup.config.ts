import { defineConfig } from "tsup";
import { readdirSync, existsSync, statSync } from "node:fs";

/**
 * One entry PER ICON, not one entry for the package.
 *
 * The root export is the convenient import and still exports everything, but a barrel is
 * only as tree-shakeable as its least pure module: every icon calls `forwardRef(...)` at
 * module scope, which a bundler is entitled to read as a side effect and keep. With one
 * entry per icon, `@enigmax/icons/icons/IconMapPin` is a guarantee rather than a hope -
 * nothing else is in that module - and the shared factory stays a single split chunk, so
 * importing fifty icons never duplicates it.
 *
 * Entries are read off the generated tree rather than listed by hand: the generator owns
 * what exists, and a hand-kept list would drift the first time the map changes.
 */
function entriesUnder(dir: string, prefix: string, ext: string): Record<string, string> {
    if (!existsSync(dir)) return {};
    return Object.fromEntries(
        readdirSync(dir)
            .filter((file) => file.endsWith(ext))
            .map((file) => [`${prefix}${file.slice(0, -ext.length)}`, `${dir}/${file}`]),
    );
}

/**
 * Every weight the generator has written, each one its own set of entries.
 *
 * The DEFAULT weight lives at the root of `src` so the main entry never changes as weights
 * are added; any other weight is a directory beside it, and is discovered here rather than
 * declared - adding one is `generate.mjs --weight <name>` and nothing else. A weight has to
 * pay for itself: nothing about it is bundled for an app that imports another one.
 */
const weightDirs = readdirSync("src", { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "icons" && e.name !== "categories")
    .filter((e) => existsSync(`src/${e.name}/index.ts`) && statSync(`src/${e.name}/icons`).isDirectory())
    .map((e) => e.name);

const weightEntries = Object.fromEntries(
    weightDirs.flatMap((weight) => [
        [`${weight}/index`, `src/${weight}/index.ts`],
        ...Object.entries(entriesUnder(`src/${weight}/icons`, `${weight}/icons/`, ".tsx")),
        ...Object.entries(entriesUnder(`src/${weight}/categories`, `${weight}/categories/`, ".ts")),
    ]),
);

export default defineConfig({
    entry: {
        index: "src/index.ts",
        icon: "src/icon.tsx",
        ...entriesUnder("src/icons", "icons/", ".tsx"),
        ...entriesUnder("src/categories", "categories/", ".ts"),
        ...weightEntries,
    },
    format: ["esm"],
    dts: true,
    clean: true,
    treeshake: true,
    // Both are the consumer's copy: React because two copies break hooks, Tabler because
    // only the brand re-exports touch it and an app that imports none should not install it.
    external: ["react", "react/jsx-runtime", "@tabler/icons-react"],
});
