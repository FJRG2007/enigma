import { defineConfig } from "tsup";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * One entry PER COMPONENT, not one entry for the package.
 *
 * `@enigmax/primitives/react` still exports everything and is the convenient import. It is
 * not, however, a small one: a barrel is only as tree-shakeable as its least pure module,
 * and enough of what a component library does at module scope (`forwardRef(...)`,
 * `createContext(...)`, `lazy(...)`, `Palette.Root = Root`) reads as a side effect to a
 * bundler, which then keeps the lot. Measured before this split: a form of two text fields
 * pulled the whole command palette in.
 *
 * So every component is also its own entry - `@enigmax/primitives/react/input`,
 * `/react/palette`, `/react/button` - which is the shape Radix ships for the same reason. A
 * subpath import is a guarantee rather than a hope: nothing else is in the module. Shared
 * code stays shared through the split chunks, so importing two subpaths never duplicates
 * the core.
 */
const REACT_ENTRIES = {
    "react/index": "src/react/index.ts",
    "react/input": "src/react/input/index.tsx",
    "react/palette": "src/react/palette/index.tsx",
    "react/select": "src/react/select/index.tsx",
    "react/context-menu": "src/react/context-menu/index.tsx",
    "react/selection": "src/react/selection/index.tsx",
    "react/button": "src/react/button.tsx",
    "react/flag": "src/react/flag.tsx",
    "react/toast": "src/react/toaster.tsx",
    "react/marquee": "src/react/use-marquee.ts",
    "react/search": "src/react/use-search.ts",
    "react/network": "src/react/use-network-state.ts",
    "react/notifications": "src/react/use-notifications.ts",
    "react/relative-time": "src/react/relative-time.ts",
    "react/slot": "src/react/slot.tsx"
};

/**
 * Entries that must carry `"use client"` in the published output.
 *
 * esbuild strips a module-level directive when it bundles ("Module level directives cause
 * errors when bundled"), so one written in the source never reaches dist. Put back here, on
 * the React entries only: the core has to stay importable from a server component, and
 * marking the whole package client-side would take that away.
 *
 * Only the entries are marked. The shared chunks they import stay neutral, which is what
 * keeps one copy of the core - and so one instance of every module-level singleton - across
 * them.
 */
const CLIENT_ENTRIES = [
    ...Object.keys(REACT_ENTRIES).map((name) => `dist/${name}.js`),
    "dist/next/index.js",
    "dist/react-router/index.js"
];

export default defineConfig({
    entry: {
        index: "src/index.ts",
        "search/index": "src/search/index.ts",
        "next/index": "src/next/index.tsx",
        "react-router/index": "src/react-router/index.tsx",
        ...REACT_ENTRIES
    },
    format: ["esm"],
    dts: true,
    clean: true,
    treeshake: true,
    external: ["react", "react-dom", "fuse.js", "next/link", "react-router", "@github/relative-time-element"],
    onSuccess: async () => {
        for (const file of CLIENT_ENTRIES) {
            if (!existsSync(file)) continue;
            const code = readFileSync(file, "utf8");
            if (!code.startsWith('"use client"')) writeFileSync(file, `"use client";\n${code}`);
        }
    }
});
