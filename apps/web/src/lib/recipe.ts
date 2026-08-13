import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Read a recipe file out of the INSTALLED package at build time.
 *
 * The docs then show the exact component `enigma add --copy` writes, at the version this
 * site depends on, and the two can never drift - a code sample pasted into an MDX file
 * goes stale the first time the recipe is edited and nothing reports it.
 */
export function recipe(pkg: string, file: string): string {
    // Resolved through registry.json rather than package.json: the packages declare an
    // `exports` map, and package.json is deliberately not a public subpath of it.
    const root = require.resolve(`${pkg}/registry.json`).replace(/registry\.json$/, "");
    return readFileSync(`${root}recipes/${file}`, "utf8").trimEnd();
}
