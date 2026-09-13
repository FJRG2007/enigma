/**
 * The generated tree against the map that produced it.
 *
 * These run over the source the generator wrote, not over a render: what breaks in
 * practice is not React, it is the table drifting from the files - a name added to the
 * map and never generated, a category barrel that forgot a member, an icon whose body
 * came out empty and renders an invisible square that nothing ever reports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { icons, brands } = JSON.parse(readFileSync(resolve(ROOT, "icon-map.json"), "utf8"));
const read = (...parts) => readFileSync(resolve(ROOT, ...parts), "utf8");

const names = Object.keys(icons);
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

test("every mapped icon has its own module", () => {
    const generated = new Set(
        readdirSync(resolve(ROOT, "src", "icons")).map((file) => file.replace(/\.tsx$/, "")),
    );
    assert.equal(generated.size, names.length);
    for (const name of names) assert.ok(generated.has(name), `missing module for ${name}`);
});

test("no icon body is empty, and every one paints with currentColor", () => {
    for (const name of names) {
        const source = read("src", "icons", `${name}.tsx`);
        const body = source.match(/icon\("[^"]+", "(.*)"\);$/m)?.[1];
        assert.ok(body && body.length > 0, `${name} has no body`);
        assert.ok(body.includes("currentColor"), `${name} does not use currentColor`);
        assert.ok(body.includes("<path") || body.includes("<circle") || body.includes("<rect"),
            `${name} has no drawable shape`);
    }
});

test("category barrels cover every icon exactly once", () => {
    const seen = new Map();
    for (const file of readdirSync(resolve(ROOT, "src", "categories"))) {
        if (file === "index.ts") continue;
        for (const [, name] of read("src", "categories", file).matchAll(/export \{ (\w+) \}/g)) {
            assert.ok(!seen.has(name), `${name} appears in ${file} and ${seen.get(name)}`);
            seen.set(name, file);
        }
    }
    assert.equal(seen.size, names.length);
    for (const name of names) {
        assert.equal(seen.get(name), `${slug(icons[name].category)}.ts`, `${name} filed under the wrong category`);
    }
});

test("the root index exports every icon and re-exports every brand", () => {
    const index = read("src", "index.ts");
    for (const name of names) {
        assert.ok(index.includes(`export { ${name} } from "./icons/${name}";`), `index omits ${name}`);
    }
    // The last entry carries no trailing comma, so match the line rather than the comma.
    for (const brand of brands) {
        assert.match(index, new RegExp(`^ {4}${brand},?$`, "m"), `index omits brand ${brand}`);
    }
    assert.ok(index.includes('from "@tabler/icons-react";'), "brands are not re-exported from their own package");
});

test("an external link is the diagonal arrow, not a box with an arrow leaving it", () => {
    // The convention this set is drawn against: at small sizes the box reads as clutter.
    assert.equal(icons.IconExternalLink.glyph, "arrow-right-up-bold-duotone");
});

test("no icon is mapped to a name from another visual weight", () => {
    // Mixing weights is the one drift that looks like a rendering bug rather than a typo.
    for (const name of names) {
        assert.match(icons[name].glyph, /-bold-duotone$/, `${name} is not bold duotone`);
    }
});
