import { defineConfig } from "tsup";

// The CLI app itself is shipped as a Bun-compiled binary (see scripts/
// build-binaries.ts), not as a Node bundle. tsup builds the parts that have to run
// under a Node that is not the binary.
//
// The standalone engines enigma copies into a repo's .githooks and runs under that
// repo's Node (these MUST stay Node-builtins-only, no cross-module imports):
//   src/guard.ts      -> dist/guard.js       (commit secret/junk guard)
//   src/guardrails.ts -> dist/guardrails.js  (convention-rule commit/CI backstop)
//   src/trim.ts       -> dist/trim.js        (end-of-file blank-line trimmer)
// Each ships as a real file in the main package; the binary reads guard.js via
// ENIGMA_GUARD_PATH, guardrails.js via ENIGMA_GUARDRAILS_PATH and trim.js via
// ENIGMA_TRIM_PATH. splitting:false keeps each output a single self-contained file.
//
// And the post-edit hook:
//   src/post-edit-hook.ts -> dist/post-edit.js
// which the npm launcher imports instead of spawning the binary, so an edit costs one
// Node start rather than a Node start plus a Bun start (see post-edit-hook.ts for the
// numbers). Unlike the three above it is free to import across the source tree - it is
// bundled whole - and it is the one entry that also runs the managed linter, which only
// a Node resolver can reach.
export default defineConfig({
    entry: {
        guard: "src/guard.ts",
        guardrails: "src/guardrails.ts",
        trim: "src/trim.ts",
        "post-edit": "src/post-edit-hook.ts",
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
