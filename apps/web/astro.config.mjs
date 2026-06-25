// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";

// Static marketing + docs site. GitHub Pages serves it at
// https://fjrg2007.github.io/enigma/, so everything lives under the /enigma base path.
// Deployed by .github/workflows/pages.yml (npm ci && npm run build -> dist/).
export default defineConfig({
    site: "https://fjrg2007.github.io",
    base: "/enigma",
    trailingSlash: "ignore",
    integrations: [mdx()],
    markdown: {
        // Warm, low-contrast dark theme that sits well on the surface palette; the code
        // block background is overridden in CSS to match the design exactly.
        shikiConfig: { theme: "vesper" },
    },
});
