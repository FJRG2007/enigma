import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Docs are MDX files compiled to static HTML at build. `order` drives the sidebar and
// the search index; the entry id (filename without extension) is the route slug.
const docs = defineCollection({
    loader: glob({ pattern: "**/*.mdx", base: "./src/content/docs" }),
    schema: z.object({
        title: z.string(),
        description: z.string(),
        group: z.string().default("Docs"),
        order: z.number().default(99),
        // Top-level docs section the page belongs to (a navbar tab + its own sidebar).
        space: z.enum(["core", "packs", "components"]).default("core"),
        // Pack id for pages inside a specific pack's sub-section (e.g. "helio").
        pack: z.string().optional(),
    }),
});

export const collections = { docs };
