import { defineConfig } from "tsup";

// The CLI app itself is shipped as a Bun-compiled binary (see scripts/
// build-binaries.ts), not as a Node bundle. tsup only builds the commit guard:
//   src/guard.ts -> dist/guard.js  (MUST stay self-contained, Node-builtins-only, so
//                                   `enigma security` can copy it into any repo's
//                                   .githooks and run it under that repo's Node)
// dist/guard.js ships as a real file in the main package; the binary reads it via
// ENIGMA_GUARD_PATH. splitting:false keeps guard.js a single self-contained file.
export default defineConfig({
    entry: {
        guard: "src/guard.ts",
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
