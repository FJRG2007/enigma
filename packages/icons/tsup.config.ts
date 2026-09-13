import { defineConfig } from "tsup";
import { readdirSync } from "node:fs";

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
const iconEntries = Object.fromEntries(
    readdirSync("src/icons")
        .filter((file) => file.endsWith(".tsx"))
        .map((file) => [`icons/${file.replace(/\.tsx$/, "")}`, `src/icons/${file}`]),
);

const categoryEntries = Object.fromEntries(
    readdirSync("src/categories")
        .filter((file) => file.endsWith(".ts"))
        .map((file) => [`categories/${file.replace(/\.ts$/, "")}`, `src/categories/${file}`]),
);

export default defineConfig({
    entry: {
        index: "src/index.ts",
        icon: "src/icon.tsx",
        ...iconEntries,
        ...categoryEntries,
    },
    format: ["esm"],
    dts: true,
    clean: true,
    treeshake: true,
    // Both are the consumer's copy: React because two copies break hooks, Tabler because
    // only the brand re-exports touch it and an app that imports none should not install it.
    external: ["react", "react/jsx-runtime", "@tabler/icons-react"],
});
