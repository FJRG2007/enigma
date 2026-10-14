/**
 * frontend-policy's primitive catalogue is written by hand, and a hand-written list drifts: it
 * once named 14 of 20 entries, so agents never learned that `image`, `video` or `safe-fetch`
 * existed and re-implemented them. Every registry entry must be named in the skill.
 * Run under Bun: bun test tests/frontend-catalogue.test.ts
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

const root = join(import.meta.dir, "..", "..", "..");
const names = (file: string): string[] => (JSON.parse(readFileSync(join(root, file), "utf8")) as { items: Array<{ name: string; }>; }).items.map((i) => i.name);

test("frontend-policy names every primitive and utility enigma add can install", () => {
    const skill = readFileSync(join(root, "packages", "enigma-cli", "assets", "skills", "frontend-policy", "SKILL.md"), "utf8");
    const missing = [...names("packages/primitives/registry.json"), ...names("packages/utils/registry.json")].filter((n) => !skill.includes(`\`${n}\``));
    expect(missing).toEqual([]);
});
