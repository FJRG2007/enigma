/**
 * The generated tree against the map that produced it.
 *
 * These run over the source the generator wrote, not over a render: what breaks in
 * practice is not React, it is the table drifting from the files - a name added to the
 * map and never generated, a category barrel that forgot a member, an icon whose body
 * came out empty and renders an invisible square that nothing ever reports, or a weight
 * that exists for some icons and not the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { icons, brands, weights } = JSON.parse(readFileSync(resolve(ROOT, "icon-map.json"), "utf8"));
const read = (...parts) => readFileSync(resolve(ROOT, ...parts), "utf8");

const names = Object.keys(icons);
const available = weights?.available ?? [];
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

test("the map declares its weights and privileges none of them", () => {
    assert.ok(available.length > 0, "icon-map.json declares no weights");
    // A default would make one weight the one you get by not choosing, which is the thing
    // this package deliberately does not have: with many weights, none of them is the one.
    assert.equal(weights.default, undefined, "icon-map.json still declares a default weight");
});

test("every icon is named in every declared weight", () => {
    // Half a weight is the worst outcome: the icons that have it render and the rest
    // vanish, which reads as a broken page rather than a missing name in a JSON file.
    for (const weight of available) {
        const absent = names.filter((name) => !icons[name].glyphs?.[weight]);
        assert.equal(absent.length, 0, `weight '${weight}' is missing ${absent.length} icon(s), e.g. ${absent[0]}`);
    }
});

test("every declared weight generated every icon as its own module", () => {
    for (const weight of available) {
        const generated = new Set(
            readdirSync(resolve(ROOT, "src", weight, "icons")).map((file) => file.replace(/\.tsx$/, "")),
        );
        assert.equal(generated.size, names.length, `weight '${weight}' generated ${generated.size} of ${names.length}`);
        for (const name of names) assert.ok(generated.has(name), `weight '${weight}' is missing ${name}`);
    }
});

test("no icon body is empty, and every one paints with currentColor", () => {
    for (const weight of available) {
        for (const name of names) {
            const source = read("src", weight, "icons", `${name}.tsx`);
            const body = source.match(/icon\("[^"]+", "(.*)"\);$/m)?.[1];
            assert.ok(body && body.length > 0, `${weight}/${name} has no body`);
            assert.ok(body.includes("currentColor"), `${weight}/${name} does not use currentColor`);
            assert.ok(body.includes("<path") || body.includes("<circle") || body.includes("<rect"),
                `${weight}/${name} has no drawable shape`);
        }
    }
});

test("category barrels cover every icon exactly once, in every weight", () => {
    for (const weight of available) {
        const seen = new Map();
        for (const file of readdirSync(resolve(ROOT, "src", weight, "categories"))) {
            if (file === "index.ts") continue;
            for (const [, name] of read("src", weight, "categories", file).matchAll(/export \{ (\w+) \}/g)) {
                assert.ok(!seen.has(name), `${name} appears in ${file} and ${seen.get(name)}`);
                seen.set(name, file);
            }
        }
        assert.equal(seen.size, names.length);
        for (const name of names) {
            assert.equal(seen.get(name), `${slug(icons[name].category)}.ts`, `${name} filed under the wrong category`);
        }
    }
});

test("each weight's barrel exports every icon in that weight", () => {
    for (const weight of available) {
        const index = read("src", weight, "index.ts");
        for (const name of names) {
            assert.ok(index.includes(`export { ${name} } from "./icons/${name}";`),
                `${weight} barrel omits ${name}`);
        }
    }
});

test("the root carries what the weights share, and no icons of its own", () => {
    const index = read("src", "index.ts");
    // The last entry carries no trailing comma, so match the line rather than the comma.
    for (const brand of brands) {
        assert.match(index, new RegExp(`^ {4}${brand},?$`, "m"), `root omits brand ${brand}`);
    }
    assert.ok(index.includes('from "@tabler/icons-react";'), "brands are not re-exported from their own package");
    assert.ok(index.includes("export type { Icon, IconProps }"), "the root does not export the shared types");
    // An icon at the root would BE a default weight, whatever the map says.
    assert.doesNotMatch(index, /from "\.\/icons\//, "the root exports icons, which makes that weight the default");
});

test("an external link is the diagonal arrow, not a box with an arrow leaving it", () => {
    // The convention this set is drawn against: at small sizes the box reads as clutter.
    // Asserted on the shape rather than a full name, so it holds for every weight.
    for (const weight of available) {
        assert.match(icons.IconExternalLink.glyphs[weight], /^arrow-right-up\b/);
    }
});
