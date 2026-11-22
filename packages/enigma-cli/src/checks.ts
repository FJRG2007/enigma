/**
 * Convention checks: the catalog.
 *
 * A check is one short markdown file - a rule a deterministic guardrail cannot express ("code shown
 * in the UI is highlighted", "a duplicate is caught as the user types") - judged by a small model
 * against the lines a change adds, at turn end, outside the agent's context. The agent pays no
 * tokens for the catalog: it only hears about a check when its change breaks one. That is the
 * difference from a skill or a memory line, which costs context on every turn and is still skipped.
 *
 * Same file shape as Continue's AI checks (`.continue/checks/*.md`, `.agents/checks/*.md`), so a
 * repository that already has those gets them enforced locally too. Sources, later wins by name:
 *   1. built in   - <package>/assets/checks
 *   2. user       - ~/.enigma/checks (where approved learned checks land)
 *   3. project    - <repo>/.enigma/checks, <repo>/.agents/checks, <repo>/.continue/checks
 *
 * Every file is untrusted input (a cloned repository writes the project ones), so each field is
 * validated and bounded, and a check's text only ever reaches the judge model as data.
 */

import { join } from "node:path";
import { enigmaHome } from "./util";
import { globRe } from "./guardrails";
import { ASSETS_DIR } from "./assets-dir";
import { existsSync, readdirSync, readFileSync } from "node:fs";

export interface Check {
    name: string;
    description: string;
    /** Globs the changed file must match; a no-slash glob matches the basename anywhere. */
    files: string[];
    /** Globs that keep a file out even when `files` matches (tests, generated code). */
    exclude: string[];
    /** Optional prefilter: the check is judged only when this matches the added lines. */
    when: RegExp | null;
    severity: "block" | "warn";
    body: string;
    source: "builtin" | "user" | "project";
    path: string;
}

/** Bounds on an untrusted check file: a check is a rule, not a document. */
const MAX_CHECK_BYTES = 8 * 1024;
const MAX_GLOBS = 40;
const MAX_WHEN = 400;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The user-wide checks directory. */
export function userChecksDir(): string {
    return join(enigmaHome(), ".enigma", "checks");
}

/** Where learned proposals wait for the user's approval. */
export function pendingChecksDir(): string {
    return join(userChecksDir(), "pending");
}

/** `key: value` frontmatter (a strict subset of YAML: one line per key) and the body after it. */
function splitFrontmatter(text: string): { meta: Record<string, string>; body: string; } | null {
    const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) return null;
    const meta: Record<string, string> = {};
    for (const line of m[1]!.split(/\r?\n/)) {
        const kv = /^([a-zA-Z][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim();
    }
    return { meta, body: m[2]!.trim() };
}

/** A frontmatter value as a list: a JSON array, or a comma-separated line. Quotes are stripped. */
function listOf(value: string | undefined): string[] {
    if (!value) return [];
    if (value.startsWith("[")) {
        try {
            const parsed: unknown = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];
        } catch { return []; }
    }
    return value.split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** A scalar frontmatter value with surrounding quotes removed. */
function scalar(value: string | undefined): string {
    return (value ?? "").replace(/^["']|["']$/g, "").trim();
}

/**
 * Parse and validate one check file. Returns null for anything malformed, oversized or disabled,
 * so a bad file in a cloned repository costs that check and nothing else.
 */
export function parseCheck(text: string, source: Check["source"], path: string): Check | null {
    if (Buffer.byteLength(text) > MAX_CHECK_BYTES) return null;
    const parts = splitFrontmatter(text);
    if (!parts || !parts.body) return null;
    const { meta, body } = parts;
    const name = scalar(meta.name).toLowerCase();
    const description = scalar(meta.description).slice(0, 300);
    if (!NAME_RE.test(name) || !description) return null;
    if (/^(false|no|off)$/i.test(scalar(meta.enabled))) return null;
    // Continue's checks run on every file of a PR; a missing `files` means the same here.
    const files = listOf(meta.files).slice(0, MAX_GLOBS);
    const exclude = listOf(meta.exclude).slice(0, MAX_GLOBS);
    let when: RegExp | null = null;
    const whenSrc = scalar(meta.when);
    if (whenSrc) {
        if (whenSrc.length > MAX_WHEN) return null;
        try { when = new RegExp(whenSrc, "i"); } catch { return null; }
    }
    const severity = scalar(meta.severity).toLowerCase() === "warn" ? "warn" : "block";
    return { name, description, files: files.length ? files : ["**"], exclude, when, severity, body, source, path };
}

/** Every `*.md` check in `dir`, parsed; a missing directory is an empty source. */
function checksIn(dir: string, source: Check["source"]): Check[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const out: Check[] = [];
    for (const name of names.sort()) {
        if (!name.endsWith(".md") || /^readme\.md$/i.test(name)) continue;
        const path = join(dir, name);
        try {
            const check = parseCheck(readFileSync(path, "utf8"), source, path);
            if (check) out.push(check);
        } catch { /* unreadable: skipped */ }
    }
    return out;
}

/** The project directories a repository may keep checks in. */
export const PROJECT_CHECK_DIRS = [".enigma/checks", ".agents/checks", ".continue/checks"];

/**
 * The active catalog for repository `root`: built-in, then user, then project, a later source
 * replacing an earlier check of the same name. A file with `enabled: false` under a name removes
 * that check, which is how a user or a project turns a built-in one off.
 */
export function loadChecks(root: string | null): Check[] {
    const byName = new Map<string, Check>();
    const disabled = new Set<string>();
    const layer = (dir: string, source: Check["source"]): void => {
        for (const c of checksIn(dir, source)) { byName.set(c.name, c); disabled.delete(c.name); }
        for (const name of disabledIn(dir)) { byName.delete(name); disabled.add(name); }
    };
    layer(join(ASSETS_DIR, "checks"), "builtin");
    layer(userChecksDir(), "user");
    if (root) for (const d of PROJECT_CHECK_DIRS) layer(join(root, d), "project");
    return [...byName.values()];
}

/** Names that a directory switches off with `enabled: false`. */
function disabledIn(dir: string): string[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const out: string[] = [];
    for (const n of names) {
        if (!n.endsWith(".md")) continue;
        try {
            const parts = splitFrontmatter(readFileSync(join(dir, n), "utf8"));
            if (parts && /^(false|no|off)$/i.test(scalar(parts.meta.enabled))) out.push(scalar(parts.meta.name).toLowerCase());
        } catch { /* unreadable */ }
    }
    return out;
}

/** The checks that apply to `file` (repo-relative, forward slashes) given the lines it adds. */
export function applicableChecks(checks: Check[], file: string, added: string): Check[] {
    return checks.filter((c) => covers(c, file) && (!c.when || c.when.test(added)));
}

/** Whether any check could apply to `file`, before reading its diff: the post-edit hook's cheap test. */
export function anyCheckFor(checks: Check[], file: string): boolean {
    return checks.some((c) => covers(c, file));
}

/** Whether check `c` covers `file` by its globs. */
function covers(c: Check, file: string): boolean {
    return c.files.some((g) => g === "**" || globRe(g).test(file)) && !c.exclude.some((g) => globRe(g).test(file));
}

/** Render a check back to its file form (used for learned proposals). */
export function renderCheck(c: { name: string; description: string; files: string[]; when?: string; body: string; }): string {
    const lines = ["---", `name: ${c.name}`, `description: ${c.description}`, `files: ${JSON.stringify(c.files)}`];
    if (c.when) lines.push(`when: ${c.when}`);
    lines.push("---", "", c.body.trim(), "");
    return lines.join("\n");
}

/** True when the built-in catalog shipped with this install is present. */
export function builtinChecksPresent(): boolean {
    return existsSync(join(ASSETS_DIR, "checks"));
}
