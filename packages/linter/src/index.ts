/** Programmatic API: lint in-memory source or files on disk. */

import { fixText } from "./fix";
import { RULES } from "./registry";
import { extname } from "node:path";
import { parseSource } from "./parse";
import { discoverFiles } from "./discover";
import { extractEmbedded } from "./embedded";
import { readFileSync, writeFileSync } from "node:fs";
import { JS_TS, isContainer, languageFor } from "./languages";
import type { Rule, Language, Category, Violation, RuleContext } from "./types";

export { RULES, fixText };
export type { Rule, Category, Language, Violation, Severity, RuleContext, EmbeddedBlock } from "./types";

export interface LintOptions {
    /** Restrict to these rule categories (default: all). */
    categories?: Category[];
    /** Override the rule set entirely (default: the built-in RULES). */
    rules?: Rule[];
}

/** Lint a single in-memory source and return its violations. Unknown extensions yield nothing. */
export function lintText(file: string, text: string, options: LintOptions = {}): Violation[] {
    if (isContainer(file)) return lintContainer(file, text, options);
    const language = languageFor(file);
    if (!language) return [];
    return runRules(buildContext(file, text, language, extname(file).toLowerCase(), false), options);
}

/** Lint every embedded code block of a container file, mapping violations back to physical lines. */
function lintContainer(file: string, text: string, options: LintOptions): Violation[] {
    const violations: Violation[] = [];
    for (const block of extractEmbedded(file, text)) {
        const ctx = buildContext(file, block.text, block.language, scriptExtension(block.language), true);
        for (const violation of runRules(ctx, options)) {
            violations.push({ ...violation, line: block.lineMap[violation.line - 1] ?? violation.line });
        }
    }
    return violations;
}

/** Run the (optionally filtered) rule set over one prepared context. */
function runRules(ctx: RuleContext, options: LintOptions): Violation[] {
    const rules = (options.rules ?? RULES).filter((rule) =>
        (!options.categories || options.categories.includes(rule.category)) && rule.languages.includes(ctx.language));
    return rules.flatMap((rule) => rule.check(ctx));
}

/** Prepare a rule context, parsing the AST for JavaScript/TypeScript sources. */
function buildContext(file: string, text: string, language: Language, ext: string, embedded: boolean): RuleContext {
    const sourceFile = JS_TS.includes(language) ? parseSource(file, text, ext) : undefined;
    return { file, text, lines: text.split("\n"), language, sourceFile, embedded };
}

/** The parser extension to use for an embedded script block of the given language. */
function scriptExtension(language: Language): string {
    return language === "js" ? ".js" : ".ts";
}

/** Discover and lint every source file under the given paths. */
export function lintFiles(paths: string[], options: LintOptions = {}): Violation[] {
    const violations: Violation[] = [];
    for (const file of discoverFiles(paths)) {
        let text: string;
        try { text = readFileSync(file, "utf8"); } catch { continue; }
        if (text.includes("\0")) continue; // skip binary
        violations.push(...lintText(file, text, options));
    }
    return violations;
}

/**
 * Apply the safe auto-fixes to every discovered file in place, returning the paths
 * that changed. Files are read, fixed, and only rewritten when the content differs,
 * so unchanged files are never touched (no spurious mtime churn).
 */
export function fixFiles(paths: string[]): string[] {
    const changed: string[] = [];
    for (const file of discoverFiles(paths)) {
        let text: string;
        try { text = readFileSync(file, "utf8"); } catch { continue; }
        if (text.includes("\0")) continue; // skip binary
        const fixed = fixText(file, text);
        if (fixed !== text) { writeFileSync(file, fixed); changed.push(file); }
    }
    return changed;
}
