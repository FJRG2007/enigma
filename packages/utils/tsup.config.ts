import { defineConfig } from "tsup";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Entries that must carry `"use client"` in the published output.
 *
 * esbuild strips a module-level directive when it bundles ("Module level directives cause
 * errors when bundled"), so a `"use client"` written in the source never reaches dist. Put
 * back here, on the React entry only: the core has to stay importable from a server
 * component, and marking the whole package client-side would take that away.
 *
 * Only the entry is marked. The shared chunk it imports stays neutral, which is what keeps
 * a single copy of the core - and so a single instance of every module-level singleton -
 * between the two entries.
 */
const CLIENT_ENTRIES = ["dist/react/index.js"];

export default defineConfig({
    entry: ["src/index.ts", "src/react/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    treeshake: true,
    external: ["react", "@github/relative-time-element"],
    onSuccess: async () => {
        for (const file of CLIENT_ENTRIES) {
            const code = readFileSync(file, "utf8");
            if (!code.startsWith('"use client"')) writeFileSync(file, `"use client";\n${code}`);
        }
    }
});
