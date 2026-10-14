/**
 * Every `enigma config <key>` that enigma tells a person or an agent to run - in a skill, the
 * memory kernel, a guardrail or CLI message, a repo note or a README - names a key the command
 * accepts. A misspelled key is an instruction that fails the moment it is followed, and an agent
 * reading it from a skill has no way to know.
 */
import { join } from "node:path";
import { expect, test } from "bun:test";
import { VALUE_CONFIG_KEYS } from "../src/settings";
import { ALL_SETTINGS } from "../src/settings-registry";
import { readdirSync, readFileSync, statSync } from "node:fs";

const PKG = join(import.meta.dir, "..");
const ROOT = join(PKG, "..", "..");
const SOURCES = [join(PKG, "assets"), join(PKG, "src"), join(ROOT, "docs", "notes"), join(PKG, "README.md"), join(ROOT, "README.md")];
const TEXT = /\.(?:md|ts|json|mjs)$/;
// A key followed by text that is not part of a key; a prefix such as `bypass-<name>` is a family, not a key.
const REFERENCE = /enigma config ([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![a-z0-9<-])/g;
// "enigma config bundle" and "enigma config file" are prose about the config, not commands.
const NOT_KEYS = new Set(["bundle", "file"]);

function files(path: string): string[] {
    if (!statSync(path, { throwIfNoEntry: false })) return [];
    if (!statSync(path).isDirectory()) return TEXT.test(path) ? [path] : [];
    return readdirSync(path).flatMap((name) => name === "node_modules" ? [] : files(join(path, name)));
}

test("every enigma config key enigma documents is a key the command accepts", () => {
    const known = new Set([...ALL_SETTINGS.map((s) => s.key), ...VALUE_CONFIG_KEYS]);
    const unknown: string[] = [];
    for (const file of SOURCES.flatMap(files)) {
        for (const match of readFileSync(file, "utf8").matchAll(REFERENCE)) {
            const key = match[1]!;
            if (!known.has(key) && !NOT_KEYS.has(key)) unknown.push(`${file.slice(ROOT.length + 1)}: ${key}`);
        }
    }
    expect(unknown).toEqual([]);
});
