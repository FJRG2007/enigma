/**
 * Repeated UI components on a live page, found structurally: elements sharing a
 * fingerprint (tag, stable classes, child tags) three or more times are one component,
 * reported with its classes, a category and a trimmed HTML sample.
 */

import type { Page } from "../browser/page";
import type { DOMComponent } from "../types";

/** Runs in the page. */
const COMPONENTS_SCRIPT = String.raw`() => {
    const stable = (el, max, minLen) => Array.from(el.classList).filter((c) => {
        if (/^(js-|is-|has-|data-|aria-)/.test(c)) return false;
        if (/^(hover:|focus:|active:|sm:|md:|lg:|xl:|2xl:)/.test(c)) return false;
        return c.length >= minLen && c.length <= 40 && /^[a-zA-Z]/.test(c);
    }).sort().slice(0, max);
    const fingerprint = (el) => el.tagName.toLowerCase() + "[" + stable(el, 4, 3).join(".") + "](" +
        Array.from(el.children).slice(0, 4).map((c) => c.tagName.toLowerCase()).join(",") + ")";
    const snippet = (el) => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll("script, style").forEach((n) => n.remove());
        Array.from(clone.querySelectorAll("*")).slice(12).forEach((n) => n.remove());
        clone.querySelectorAll("*").forEach((n) => {
            if (n.children.length === 0 && n.textContent && n.textContent.length > 40) n.textContent = n.textContent.slice(0, 40) + "...";
        });
        return clone.outerHTML.replace(/\s+/g, " ").slice(0, 600);
    };
    const categorize = (el, classes) => {
        const tag = el.tagName.toLowerCase();
        const cls = classes.join(" ").toLowerCase();
        if (/card|tile|item|product|post/.test(cls)) return "card";
        if (/nav.*item|menu.*item|tab/.test(cls)) return "nav-item";
        if (tag === "li" || /list.*item/.test(cls)) return "list-item";
        if (tag === "button" || /btn|button/.test(cls)) return "button";
        if (/badge|tag|chip|label/.test(cls)) return "badge";
        if (/field|input|form/.test(cls)) return "form-field";
        return "unknown";
    };
    const SKIP = ["html", "body", "main", "head", "script", "style", "link", "meta"];
    const groups = new Map();
    for (const el of Array.from(document.querySelectorAll("[class]"))) {
        if (SKIP.includes(el.tagName.toLowerCase())) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) continue;
        const fp = fingerprint(el);
        if (!groups.has(fp)) groups.set(fp, []);
        groups.get(fp).push(el);
    }
    const out = [];
    for (const [fp, els] of groups) {
        if (els.length < 3) continue;
        const rep = els[0];
        const classes = stable(rep, 6, 3);
        const main = classes[0] || rep.tagName.toLowerCase();
        const name = main.replace(/[-_]/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim() || rep.tagName.toLowerCase();
        out.push({ name, pattern: fp, instances: els.length, commonClasses: classes, htmlSnippet: snippet(rep), category: categorize(rep, classes) });
    }
    return out.sort((a, b) => b.instances - a.instances).slice(0, 20);
}`;

export async function detectDomComponents(page: Page): Promise<DOMComponent[]> {
    try { return await page.evaluate<DOMComponent[]>(COMPONENTS_SCRIPT); } catch { return []; }
}
