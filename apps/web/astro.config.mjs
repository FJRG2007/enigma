// @ts-check
import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import { buildId } from "./scripts/build-id.mjs";

// Per-deploy cache-busting token stamped onto public/ sub-resources via asset() (see
// src/lib/url.ts). Astro already content-hashes its own bundled CSS/JS, so only the
// hand-referenced public assets need this.
const BUILD_ID = buildId();

// Static marketing + docs site. GitHub Pages serves it at
// https://fjrg2007.github.io/enigma/, so everything lives under the /enigma base path.
// Deployed by .github/workflows/pages.yml (npm ci && npm run build -> dist/).
export default defineConfig({
    site: "https://fjrg2007.github.io",
    base: "/enigma",
    trailingSlash: "ignore",
    integrations: [mdx(), react()],
    markdown: {
        // One theme per colour scheme, emitted as CSS variables (defaultColor: false) so the
        // site's stylesheet picks the one matching the visitor's scheme. The block background
        // is overridden in CSS to match the design exactly.
        shikiConfig: { themes: { dark: "vesper", light: "github-light" }, defaultColor: false },
    },
    vite: {
        // Expose the build token to import.meta.env for asset() cache-busting.
        define: { "import.meta.env.PUBLIC_BUILD_ID": JSON.stringify(BUILD_ID) },
    },
});
