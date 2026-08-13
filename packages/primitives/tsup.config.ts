import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/react/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    treeshake: true,
    external: ["react"]
});
