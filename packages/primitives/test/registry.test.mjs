import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname, posix } from "node:path";

/**
 * The catalogue `enigma add --copy` reads.
 *
 * Copying a component is a literal find-and-replace over its source: every `@/...` specifier a
 * copied file contains has to be named in that file's rewrite map, and what it is rewritten TO
 * has to be a file the same entry ships. Neither is visible from the package itself, which
 * compiles against the alias - so an import added to a shared core lands in someone's project
 * as a path that resolves to nothing, and only they find out.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));

/** Every `@/...` a source file imports from, however it spells the import. */
function aliasImports(source) {
    return new Set([...source.matchAll(/["'](@\/[^"']+)["']/g)].map((match) => match[1]));
}

test("every alias a copied file imports is rewritten to a file that travels with it", () => {
    for (const item of registry.items) {
        const shipped = new Set(item.files.map((file) => file.dest.replace(/\.[^./]+$/, "")));
        for (const file of item.files) {
            if (!/\.tsx?$/.test(file.path)) continue;
            const rewrite = file.rewrite ?? {};
            for (const specifier of aliasImports(readFileSync(join(ROOT, file.path), "utf8"))) {
                const target = rewrite[specifier];
                assert.ok(target, `${item.name}: ${file.path} imports ${specifier}, which its rewrite map does not name`);
                if (!target.startsWith(".")) continue;
                const resolved = posix.normalize(posix.join(posix.dirname(file.dest), target));
                assert.ok(shipped.has(resolved), `${item.name}: ${file.path} rewrites ${specifier} to ${target}, which the entry does not ship`);
            }
        }
    }
});

test("the copy bundled with the CLI is the one the package publishes", () => {
    const vendored = readFileSync(join(ROOT, "..", "enigma-cli", "assets", "registry", "primitives", "registry.json"), "utf8");
    // `npm run seal` copies it. Out of date, the catalogue an agent lists differs from the one
    // an install actually copies from.
    assert.equal(vendored, readFileSync(join(ROOT, "registry.json"), "utf8"));
});
