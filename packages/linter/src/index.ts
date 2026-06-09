/** Programmatic API: lint in-memory source or files on disk. */

import { RULES } from "./registry";
import { extname } from "node:path";
import { parseSource } from "./parse";
import { readFileSync } from "node:fs";
import { discoverFiles } from "./discover";
import { JS_TS, languageFor } from "./languages";
import type { Rule, Category, Violation, RuleContext } from "./types";

export { RULES };
export type { Rule, Category, Language, Violation, Severity, RuleContext } from "./types";

export interface LintOptions {
    /** Restrict to these rule categories (default: all). */
    categories?: Category[];
    /** Override the rule set entirely (default: the built-in RULES). */
    rules?: Rule[];
}

/** Lint a single in-memory source and return its violations. Unknown extensions yield nothing. */
export function lintText(file: string, text: string, options: LintOptions = {}): Violation[] {
    const language = languageFor(file);
    if (!language) return [];
    const rules = (options.rules ?? RULES).filter((rule) =>
        (!options.categories || options.categories.includes(rule.category)) && rule.languages.includes(language));
    const sourceFile = JS_TS.includes(language) ? parseSource(file, text, extname(file).toLowerCase()) : undefined;
    const ctx: RuleContext = { file, text, lines: text.split("\n"), language, sourceFile };
    return rules.flatMap((rule) => rule.check(ctx));
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
