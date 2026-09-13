import { defineConfig } from "tsup";
import { readdirSync, existsSync } from "node:fs";

/**
 * One entry PER ICON, not one entry for the package.
 *
 * A barrel is only as tree-shakeable as its least pure module: every icon calls
 * `forwardRef(...)` at module scope, which a bundler is entitled to read as a side effect
 * and keep. With one entry per icon, `@enigmax/icons/bold-duotone/icons/IconMapPin` is a
 * guarantee rather than a hope - nothing else is in that module - and the shared factory
 * stays a single split chunk, so importing fifty icons never duplicates it.
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
 * Every weight is a directory under `src`, and none of them is privileged.
 *
 * There is no default weight, so the root builds only what the weights SHARE - the factory
 * and the brand re-exports - and each weight builds its own icons, categories and barrel.
 * Weights are discovered rather than declared: adding one is `generate.mjs --weight <name>`
 * and nothing else, and an app pays only for the weights it imports.
 */
const weights = readdirSync("src", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((weight) => existsSync(`src/${weight}/index.ts`));

const weightEntries = Object.fromEntries(
    weights.flatMap((weight) => [
        [`${weight}/index`, `src/${weight}/index.ts`],
        ...Object.entries(entriesUnder(`src/${weight}/icons`, `${weight}/icons/`, ".tsx")),
        ...Object.entries(entriesUnder(`src/${weight}/categories`, `${weight}/categories/`, ".ts")),
    ]),
);

export default defineConfig({
    entry: {
        index: "src/index.ts",
        icon: "src/icon.tsx",
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
