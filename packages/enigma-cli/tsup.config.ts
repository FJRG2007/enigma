import { defineConfig } from "tsup";

// Two independent entry points:
//   src/bin/enigma.ts -> dist/enigma.js  (the CLI; @clack/prompts stays external)
//   src/guard.ts      -> dist/guard.js   (the commit guard; MUST stay self-contained,
//                                         Node-builtins-only, so it can be copied into
//                                         any repo's .githooks and run without install)
// splitting:false guarantees no shared chunks leak into guard.js.
export default defineConfig({
    entry: {
        enigma: "src/bin/enigma.ts",
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
