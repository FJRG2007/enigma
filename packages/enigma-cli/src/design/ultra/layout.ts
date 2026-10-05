/**
 * The layout containers of a live page - flex and grid parents, sections, page chrome -
 * with their computed direction, alignment, gaps, padding and width limits, shallowest
 * (most structural) first.
 */

import type { Page } from "../browser/page";
import type { LayoutRecord } from "../types";

/** Runs in the page. */
const LAYOUT_SCRIPT = String.raw`() => {
    const SELECTORS = ["header", "nav", "main", "footer", "section", "article", "[class*=container]", "[class*=wrapper]",
        "[class*=layout]", "[class*=grid]", "[class*=flex]", "[class*=row]", "[class*=col]", "[class*=hero]", "[class*=card]"];
    const depthOf = (el) => { let d = 0; for (let n = el.parentElement; n; n = n.parentElement) d++; return d; };
    const selectorOf = (el) => {
        const classes = Array.from(el.classList).filter((c) => !/^(js-|is-|has-)/.test(c)).slice(0, 2).map((c) => "." + c).join("");
        return (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + classes).slice(0, 60);
    };
    const seen = new Set();
    const out = [];
    for (const sel of SELECTORS) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
            if (out.length >= 60) break;
            if (seen.has(el)) continue;
            seen.add(el);
            const s = getComputedStyle(el);
            if (!["flex", "grid", "block", "inline-flex", "inline-grid"].includes(s.display)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 30 || el.children.length === 0) continue;
            out.push({
                tag: el.tagName.toLowerCase(), selector: selectorOf(el), display: s.display,
                flexDirection: s.flexDirection || "", flexWrap: s.flexWrap || "", justifyContent: s.justifyContent || "",
                alignItems: s.alignItems || "", gap: s.gap || "", rowGap: s.rowGap || "", columnGap: s.columnGap || "",
                padding: s.padding || "", margin: s.margin || "", gridTemplateColumns: s.gridTemplateColumns || "",
                gridTemplateRows: s.gridTemplateRows || "", maxWidth: s.maxWidth || "", width: s.width || "",
                height: s.height || "", position: s.position || "", childCount: el.children.length, depth: depthOf(el),
            });
        }
    }
    return out.sort((a, b) => a.depth - b.depth).slice(0, 40);
}`;

export async function extractLayouts(page: Page): Promise<LayoutRecord[]> {
    try { return await page.evaluate<LayoutRecord[]>(LAYOUT_SCRIPT); } catch { return []; }
}
