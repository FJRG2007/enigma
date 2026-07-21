import { defineConfig } from "tsup";

// The CLI app itself is shipped as a Bun-compiled binary (see scripts/
// build-binaries.ts), not as a Node bundle. tsup only builds the standalone,
// self-contained engines enigma copies into a repo's .githooks and runs under that
// repo's Node (both MUST stay Node-builtins-only, no cross-module imports):
//   src/guard.ts      -> dist/guard.js       (commit secret/junk guard)
//   src/guardrails.ts -> dist/guardrails.js  (convention-rule commit/CI backstop)
// Each ships as a real file in the main package; the binary reads guard.js via
// ENIGMA_GUARD_PATH and guardrails.js via ENIGMA_GUARDRAILS_PATH. splitting:false
// keeps each output a single self-contained file.
export default defineConfig({
    entry: {
        guard: "src/guard.ts",
        guardrails: "src/guardrails.ts",
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
