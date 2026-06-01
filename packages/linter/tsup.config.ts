import { defineConfig } from "tsup";

// Two entries:
//   src/cli.ts   -> dist/cli.js    (the `enigmax-lint` bin)
//   src/index.ts -> dist/index.js  (the programmatic API)
// `typescript` is a runtime dependency and stays external (tsup externalizes
// package.json dependencies). splitting:false keeps each entry self-contained.
export default defineConfig({
    entry: {
        cli: "src/cli.ts",
        index: "src/index.ts",
    },
    format: ["esm"],
    target: "node18",
    platform: "node",
    outDir: "dist",
    splitting: false,
    clean: true,
    dts: false,
    sourcemap: false,
    shims: false,
    banner: { js: "#!/usr/bin/env node" },
});
