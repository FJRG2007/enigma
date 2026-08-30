/**
 * Command-aware compression for shell and tool output.
 *
 * The generic compressors read structure out of the content itself. Command output
 * has something better available: the command that produced it. `npm install` prints
 * a thousand progress lines and one error; `vitest` prints every passing test and one
 * failing suite. Knowing which tool ran turns "keep the head and tail" into "keep the
 * failures and the summary", which is where the whole saving is.
 *
 * A filter (see ./shell-filters) is matched against the command when one is known,
 * against the output's shape when it is not, and its rules are applied in a fixed
 * order: verdict, drop, keep, collapse, dedupe, group, truncate. Everything removed
 * is recoverable via CCR (see index.ts) - this module never destroys anything by
 * itself, it only decides what the model has to read.
 */

import { SHELL_FILTERS } from "./shell-filters";
import type { ShellFilter } from "./shell-filters";

export type { ShellFilter } from "./shell-filters";

/** Consecutive identical (or near-identical) lines are collapsed from this run length up. */
const REPEAT_THRESHOLD = 3;

/** How many of a filter's patterns must hit before its shape alone selects it. */
const SHAPE_MATCHES = 2;

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Lines a filter is never allowed to lose to its own whitelist, and that always survive
 * truncation. A filter's `keep` list is a whitelist, so anything its author did not
 * foresee disappears silently - and what gets forgotten is exactly the thing worth
 * keeping. The npm filter is the case that proved it: its list was written against
 * npm 8's `ERR!` and npm 9 renamed that to `npm error`, so a failed install compressed
 * to two deprecation warnings with the ERESOLVE failure gone. This runs over EVERY
 * filter, so no single whitelist has to be exhaustive for the engine to be safe.
 *
 * It overrides `keep` (an omission) but never `drop` (a deliberate exclusion), and it
 * is narrow on purpose: a line that merely mentions errors - "error handling", a path
 * named errors.ts - must not pin a whole log open.
 */
const ALWAYS_KEEP = /\bERR!|(^|\s)errors?[\s:!]|\bfatal[:\s]|\bpanic:|Traceback \(most recent call last\)|\w+Exception\b|\bFAIL(?:ED|URE)?\b|\bsegmentation fault\b|\b\d+ vulnerabilit/i;

/** Filters ordered so a specific one is always tried before the generic fallback. */
const ORDERED = [...SHELL_FILTERS].sort((a, b) => b.priority - a.priority);

const cache = new Map<string, RegExp | null>();

/** Compile `pattern` once and reuse it; an invalid pattern is dropped, never thrown. */
function compile(pattern: string, flags: string): RegExp | null {
    const key = `${flags} ${pattern}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let re: RegExp | null = null;
    try { re = new RegExp(pattern, flags); } catch { re = null; }
    cache.set(key, re);
    return re;
}

function compileAll(patterns: string[] | undefined): RegExp[] {
    if (!patterns) return [];
    return patterns.map((p) => compile(p, "i")).filter((re): re is RegExp => re !== null);
}

function matchesAny(line: string, patterns: RegExp[]): boolean {
    return patterns.some((re) => re.test(line));
}

/** How many of `patterns` hit `text` - the corroboration behind a shape-only match. */
function countMatches(text: string, patterns: RegExp[]): number {
    return patterns.filter((re) => re.test(text)).length;
}

/**
 * Reduce the command line to the segment that actually produced the output: the last
 * stage of a pipe or an `&&` chain, with a `$`/`>` prompt and env-var prefixes removed.
 * `cd repo && npm test` is npm test's output, not cd's.
 */
export function commandTail(command: string): string {
    let tail = command.trim().replace(/^[$>]\s+/, "");
    const parts = tail.split(/\s*(?:\|\||&&|\||;)\s*/).filter((p) => p.trim());
    if (parts.length > 0) tail = parts[parts.length - 1].trim();
    // Drop `VAR=value` prefixes and a leading `sudo`/`time`/`npx`-style runner is kept,
    // since the filters match on the runner too (`^npx\s+biome`).
    while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(tail)) tail = tail.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
    return tail;
}

/**
 * Pick the filter for this output. An explicit `command` decides it. Without one the
 * output's own shape is used, but only on CORROBORATION - two independent patterns of
 * the same filter have to hit. One is not enough, and the difference is not academic:
 * the GitHub CLI filter recognises a line shaped `X <word>`, which every second
 * sentence of English prose satisfies. A filter applied to content it was not written
 * for is the one way this engine can destroy meaning, so shape matching also never
 * reaches the generic fallback - that one is command-only.
 */
export function matchShellFilter(text: string, command?: string): ShellFilter | null {
    const tail = command ? commandTail(command) : "";
    if (tail) {
        const byCommand = ORDERED.find((f) => matchesAny(tail, compileAll(f.commands)));
        if (byCommand) return byCommand;
    }
    const byShape = ORDERED.find((f) => f.id !== "generic-output" && countMatches(text, compileAll(f.patterns)) >= SHAPE_MATCHES);
    if (byShape) return byShape;
    // A known command with no specific filter still gets the generic treatment; an
    // unrecognised blob gets none.
    return tail ? ORDERED.find((f) => f.id === "generic-output") ?? null : null;
}

/** Collapse runs of identical consecutive lines into one plus a count. */
function collapseRepeats(lines: string[]): { lines: string[]; dropped: number; } {
    const out: string[] = [];
    let dropped = 0;
    for (let i = 0; i < lines.length;) {
        const line = lines[i];
        let run = 1;
        while (i + run < lines.length && lines[i + run] === line) run++;
        out.push(line);
        if (line.trim() && run >= REPEAT_THRESHOLD) {
            out.push(`    ... (${run - 1} identical lines elided)`);
            dropped += run - 1;
        } else for (let k = 1; k < run; k++) out.push(line);
        i += run;
    }
    return { lines: out, dropped };
}

/**
 * Reduce a line to its shape by masking the parts that vary between otherwise
 * identical lines - timestamps, hashes, versions, numbers - so that a run of
 * "Downloading pkg-1.2.3" lines is recognised as one repeated line.
 */
function shapeOf(line: string): string {
    return line
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<N>")
        .replace(/\b[0-9a-f]{6,40}\b/gi, "<N>")
        .replace(/\bv?\d+\.\d+\.\d+(\.\d+)*\b/g, "<N>")
        .replace(/\b\d+\b/g, "<N>")
        .replace(/\s+/g, " ")
        .trim();
}

/** Collapse runs of consecutive lines that differ only in volatile tokens. */
function groupSimilar(lines: string[]): { lines: string[]; dropped: number; } {
    const out: string[] = [];
    let dropped = 0;
    for (let i = 0; i < lines.length;) {
        const shape = shapeOf(lines[i]);
        let run = 1;
        while (i + run < lines.length && shapeOf(lines[i + run]) === shape) run++;
        if (shape && run >= REPEAT_THRESHOLD) {
            out.push(`${lines[i]}    ... (${run - 1} more similar lines)`);
            dropped += run - 1;
        } else for (let k = 0; k < run; k++) out.push(lines[i + k]);
        i += run;
    }
    return { lines: out, dropped };
}

/**
 * Cut `lines` down to `maxLines`, keeping the head, the tail, and every line the
 * filter anchored (failures, error summaries) wherever it sat. Anchors are what make
 * this different from a head+tail cut: the one line that says why the build failed
 * is usually in the middle.
 */
function truncate(lines: string[], filter: ShellFilter, anchors: RegExp[]): { lines: string[]; dropped: number; } {
    const max = filter.maxLines ?? 0;
    if (max <= 0 || lines.length <= max) return { lines, dropped: 0 };

    const head = Math.max(0, filter.headLines);
    const tail = Math.max(0, filter.tailLines);
    const keep = new Set<number>();
    for (let i = 0; i < Math.min(head, lines.length); i++) keep.add(i);
    for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) keep.add(i);
    for (let i = 0; i < lines.length; i++) {
        if (ALWAYS_KEEP.test(lines[i]) || matchesAny(lines[i], anchors)) keep.add(i);
    }

    const dropped = lines.length - keep.size;
    if (dropped <= 0) return { lines, dropped: 0 };

    const out: string[] = [];
    let gap = 0;
    const flushGap = () => { if (gap > 0) out.push(`    ... (${gap} lines elided)`); gap = 0; };
    for (let i = 0; i < lines.length; i++) {
        if (keep.has(i)) { flushGap(); out.push(lines[i]); } else gap++;
    }
    flushGap();
    return { lines: out, dropped };
}

export interface ShellCrushResult {
    compressed: string;
    offloaded: number;
    /** Id of the filter that produced the result, for reporting. */
    filter?: string;
}

/**
 * Apply `filter` to `text`. Returns the reduced output and how many lines it removed;
 * `offloaded === 0` means nothing changed and the caller should keep the original.
 */
export function crushShell(text: string, filter: ShellFilter): ShellCrushResult {
    let lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const before = lines.length;

    if (filter.stripAnsi) lines = lines.map((l) => l.replace(ANSI, ""));

    // A verdict short-circuits everything: the run proved clean, so the output is one
    // line and the rest is noise the model never has to read. It runs BEFORE the
    // too-short gate below, because it is a statement about what the output MEANS -
    // three lines proving the build passed still collapse to one.
    const blob = lines.join("\n");
    for (const verdict of filter.verdicts ?? []) {
        const hit = compile(verdict.pattern, "im");
        if (!hit?.test(blob)) continue;
        const unless = verdict.unless ? compile(verdict.unless, "im") : null;
        if (unless?.test(blob)) continue;
        if (before <= 1) break;
        return { compressed: verdict.message, offloaded: before - 1, filter: filter.id };
    }

    const drop = compileAll(filter.drop);
    if (drop.length > 0) lines = lines.filter((l) => !matchesAny(l, drop));

    // `keep` is a whitelist, but only when it actually selects something: a filter
    // whose keep patterns match nothing must not blank the output. Whatever the filter
    // forgot to whitelist, ALWAYS_KEEP holds on to - see its comment for why that is
    // the difference between a compressed failure and a lost one.
    const keep = compileAll(filter.keep);
    if (keep.length > 0) {
        const kept = lines.filter((l) => matchesAny(l, keep) || ALWAYS_KEEP.test(l));
        if (kept.length > 0) lines = kept;
    }

    const collapse = compileAll(filter.collapse);
    if (collapse.length > 0) {
        const seen = new Set<string>();
        lines = lines.filter((l) => {
            if (!matchesAny(l, collapse)) return true;
            const key = l.trim();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    if (filter.dedupe) ({ lines } = collapseRepeats(lines));
    ({ lines } = groupSimilar(lines));
    ({ lines } = truncate(lines, filter, compileAll(filter.anchor)));

    let compressed = lines.join("\n");
    if (!compressed.trim() && filter.onEmpty) compressed = filter.onEmpty;

    const after = compressed ? compressed.split("\n").length : 0;
    const offloaded = Math.max(0, before - after);
    if (offloaded === 0) return { compressed: text, offloaded: 0 };
    return { compressed, offloaded, filter: filter.id };
}
