/**
 * @keyframes and the rules that use them, read from stylesheet TEXT - the fallback for
 * sheets the page's own script may not inspect (cross-origin CSS). Comments and strings
 * are stripped before brace matching, so a `}` inside either cannot end a block early.
 */

import { walkCss } from "../css-parse";
import type { ExtractedKeyframe, KeyframeStop } from "../types";

function stripCommentsAndStrings(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (s) => s.replace(/[{}]/g, " "));
}

/** The index just past the `}` matching the `{` at `open`, or -1. */
function blockEnd(css: string, open: number): number {
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) return i + 1;
    }
    return -1;
}

function declarations(body: string): Record<string, string> {
    const out: Record<string, string> = {};
    walkCss(`x{${body}}`, { declaration: (prop, value) => { out[prop] = value; } });
    return out;
}

/** Every `@keyframes` (prefixed forms included) with its stops. */
export function keyframesInCss(raw: string): Array<{ name: string; stops: KeyframeStop[]; }> {
    const css = stripCommentsAndStrings(raw);
    const out: Array<{ name: string; stops: KeyframeStop[]; }> = [];
    for (const m of css.matchAll(/@(?:-[a-z]+-)?keyframes\s+([\w-]+)\s*\{/g)) {
        const open = m.index! + m[0].length - 1;
        const end = blockEnd(css, open);
        if (end < 0) continue;
        const inner = css.slice(open + 1, end - 1);
        const stops: KeyframeStop[] = [];
        for (const s of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)) stops.push({ stop: s[1]!.trim(), properties: declarations(s[2]!) });
        out.push({ name: m[1]!, stops });
    }
    return out;
}

/** Selectors whose rule names `name` in `animation` or `animation-name`, with its timing. */
export function keyframeUsage(raw: string, names: Set<string>): Map<string, Omit<ExtractedKeyframe, "name" | "stops">> {
    const css = stripCommentsAndStrings(raw).replace(/@(?:-[a-z]+-)?keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    const usage = new Map<string, Omit<ExtractedKeyframe, "name" | "stops">>();
    for (const rule of css.matchAll(/([^{};]+)\{([^{}]*\banimation[^{}]*)\}/g)) {
        const selector = rule[1]!.trim().replace(/\s+/g, " ").slice(0, 80);
        const decls = declarations(rule[2]!);
        const value = decls["animation-name"] ?? decls.animation ?? "";
        for (const token of value.split(/[\s,]+/)) {
            if (!names.has(token)) continue;
            const u = usage.get(token) ?? { usedBy: [] };
            if (!u.usedBy.includes(selector)) u.usedBy.push(selector);
            const shorthand = decls.animation ?? "";
            u.animDuration ??= decls["animation-duration"] ?? shorthand.match(/(?:^|\s)([\d.]+m?s)\b/)?.[1];
            u.animEasing ??= decls["animation-timing-function"] ?? shorthand.match(/\b(ease-in-out|ease-in|ease-out|ease|linear|cubic-bezier\([^)]*\)|steps\([^)]*\))/)?.[1];
            u.animIteration ??= decls["animation-iteration-count"] ?? shorthand.match(/\b(infinite)\b/)?.[1];
            u.animFillMode ??= decls["animation-fill-mode"] ?? shorthand.match(/\b(forwards|backwards|both)\b/)?.[1];
            u.animDirection ??= decls["animation-direction"] ?? shorthand.match(/\b(alternate-reverse|alternate|reverse)\b/)?.[1];
            usage.set(token, u);
        }
    }
    return usage;
}
