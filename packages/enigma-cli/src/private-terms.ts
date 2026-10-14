/**
 * Private terms: the real names, handles, server and community names of the user and of the
 * people they serve, which must never reach a tracked file - not in code, a comment, a doc, and
 * above all not in a test, where real data is copied most (tests use anonymous data).
 *
 * Shared by the commit guard (guard.ts) and the edit-time guardrail (guardrails.ts). Both are
 * copied into a repo's .githooks as single bundles, so this module stays a Node-builtins-only
 * leaf with no side effects: tsup inlines it into each bundle.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

/**
 * The list, read ONLY from the user-wide ~/.enigma-guard.json: the per-repo layer is committed,
 * so the list there would publish exactly what it protects. ENIGMA_CONFIG_HOME wins so tests can
 * use a synthetic home. A term shorter than three characters is ignored; it would match half the
 * codebase.
 */
export function readPrivateTerms(): string[] {
    try {
        const raw = JSON.parse(readFileSync(join(process.env.ENIGMA_CONFIG_HOME || homedir(), ".enigma-guard.json"), "utf8"));
        if (!Array.isArray(raw.privateTerms)) return [];
        return raw.privateTerms.filter((t: unknown): t is string => typeof t === "string" && t.trim().length >= 3);
    } catch { return []; }
}

/**
 * One matcher over every private term, or null when there are none. Case-insensitive, and a
 * run of spaces, `_` or `-` between a term's words matches any other such run or none, so
 * "Er Migue" also finds "ErMigue04" and "er_migue". It matches a whole word: a term inside a
 * longer word ("Arnau" in "Barnaul") is not a match, while a camelCase join ("offgridServer")
 * and a trailing number ("ErMigue04") are. Letters are spelled as explicit [xX] classes instead
 * of the `i` flag so the lowercase-letter boundary keeps its case.
 */
export function privateTermMatcher(terms: string[]): RegExp | null {
    const anyCase = (ch: string): string => {
        const lo = ch.toLowerCase(), up = ch.toUpperCase();
        return lo === up ? ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") : `[${lo}${up}]`;
    };
    const parts = terms
        .map((t) => t.trim().split(/[\s_-]+/).filter(Boolean).map((w) => [...w].map(anyCase).join("")).join("[\\s_-]*"))
        .filter(Boolean);
    if (!parts.length) return null;
    return new RegExp(`(?:(?<![\\p{L}\\p{N}])|(?<=\\p{Ll})(?=\\p{Lu}))(?:${parts.join("|")})(?!\\p{Ll})`, "u");
}

/** Whether one line carries a private term. URLs are left out: a repository or profile link is an address, not data. */
export function hasPrivateTerm(line: string, re: RegExp): boolean {
    return re.test(line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " "));
}

/** 1-based lines of `text` carrying a private term. */
export function privateTermLines(text: string, re: RegExp): number[] {
    const out: number[] = [];
    text.split("\n").forEach((line, i) => { if (hasPrivateTerm(line, re)) out.push(i + 1); });
    return out;
}
