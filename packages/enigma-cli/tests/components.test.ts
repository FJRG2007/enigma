/**
 * The component catalogue: how a name is resolved, and what a miss says.
 *
 * The case that prompted this: `enigma add flag` came back "not in the catalogue" for a
 * component that is published and documented, because the item is called `flags`. Being
 * right about the plural is not worth an error, and the error itself said nothing about the
 * other reason a name goes missing - a catalogue read from an older installed package.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

const { findComponent, suggestComponents, listComponents } = await import("../src/components");

const PROJECT = mkdtempSync(join(tmpdir(), "enigma-components-"));
mkdirSync(join(PROJECT, "node_modules"), { recursive: true });
writeFileSync(join(PROJECT, "package.json"), JSON.stringify({ name: "probe", dependencies: { react: "^19.0.0" } }));

afterAll(() => rmSync(PROJECT, { recursive: true, force: true }));

test("the catalogue is readable with nothing installed, from the CLI's own copy", () => {
    const names = listComponents(PROJECT).map((item) => item.name);
    expect(names).toContain("flags");
    expect(names).toContain("palette");
    expect(names).toContain("input");
});

test("an exact name wins, always", () => {
    expect(findComponent("flags", PROJECT)?.name).toBe("flags");
    expect(findComponent("input", PROJECT)?.name).toBe("input");
});

test("the singular reaches the plural, and the other way round", () => {
    // `<Flag>` in a snippet, `flags` in the catalogue: the reader types what they saw.
    expect(findComponent("flag", PROJECT)?.name).toBe("flags");
    expect(findComponent("notification", PROJECT)?.name).toBe("notifications");
});

test("case and stray spacing are not a mistake worth failing on", () => {
    expect(findComponent("  Flags  ", PROJECT)?.name).toBe("flags");
});

test("a name that is genuinely not there resolves to nothing", () => {
    expect(findComponent("carousel", PROJECT)).toBe(null);
    expect(findComponent("", PROJECT)).toBe(null);
});

test("a miss offers the names it could have meant", () => {
    expect(suggestComponents("markee", PROJECT)).toContain("marquee");
    expect(suggestComponents("pal", PROJECT)).toContain("palette");
    // Nothing related is worse than nothing at all.
    expect(suggestComponents("zzz", PROJECT)).toEqual([]);
});
