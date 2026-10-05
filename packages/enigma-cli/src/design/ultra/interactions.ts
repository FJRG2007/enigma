/**
 * Micro-interactions: for up to three visible buttons, links, inputs and role=button
 * elements, capture the default, hover and focus states (screenshot + computed-style
 * diff against the default).
 */

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { Page } from "../browser/page";
import type { InteractionRecord, StyleDiff, StyleSnapshot } from "../types";

const PER_TYPE = 3;
const TRACKED: Array<keyof StyleSnapshot> = [
    "backgroundColor", "color", "borderColor", "borderWidth", "boxShadow", "opacity",
    "transform", "outline", "outlineColor", "textDecoration", "transition",
];
const TARGETS: Array<{ type: InteractionRecord["componentType"]; selector: string; }> = [
    { type: "button", selector: "button:not([disabled])" },
    { type: "role-button", selector: "[role=\"button\"]:not([disabled])" },
    { type: "link", selector: "a[href]:not([href^=\"#\"]):not([href^=\"mailto\"])" },
    { type: "input", selector: "input:not([type=\"hidden\"]):not([disabled])" },
];

interface Probe { id: string; label: string; }
interface Target { rect: { x: number; y: number; width: number; height: number; }; center: { x: number; y: number; }; styles: StyleSnapshot; }

/** Runs in the page: tag the first visible matches of `selector` and return their ids and labels. */
const TAG_SCRIPT = String.raw`(arg) => {
    const out = [];
    for (const el of Array.from(document.querySelectorAll(arg.selector))) {
        if (out.length >= arg.limit) break;
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0 && r.width < 800)) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        const id = arg.type + "-" + (out.length + 1);
        el.setAttribute("data-enigma-probe", id);
        const text = (el.innerText || "").trim() || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("type") || el.tagName.toLowerCase();
        out.push({ id, label: text.replace(/\s+/g, " ").slice(0, 40) });
    }
    return out;
}`;

/** Runs in the page: scroll a probe into view, return its document rect, viewport center and styles. */
const TARGET_SCRIPT = String.raw`async (id) => {
    const el = document.querySelector("[data-enigma-probe=\"" + id + "\"]");
    if (!el) return null;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((r) => setTimeout(r, 100));
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
        rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
        center: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        styles: { backgroundColor: s.backgroundColor, color: s.color, borderColor: s.borderColor, borderWidth: s.borderWidth,
            boxShadow: s.boxShadow, opacity: s.opacity, transform: s.transform, outline: s.outline, outlineColor: s.outlineColor,
            textDecoration: s.textDecoration, transition: s.transition },
    };
}`;

const FOCUS_SCRIPT = "(id) => { const el = document.querySelector('[data-enigma-probe=\"' + id + '\"]'); if (el) el.focus({ preventScroll: true }); }";
const BLUR_SCRIPT = "() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }";

function diff(before: StyleSnapshot, after: StyleSnapshot): StyleDiff[] {
    const out: StyleDiff[] = [];
    for (const prop of TRACKED) {
        const from = before[prop] || "", to = after[prop] || "";
        if (from !== to && to !== "" && to !== "none" && to !== "normal") out.push({ property: prop, from, to });
    }
    return out;
}

/** Interactions of `page` (already loaded); screenshots go to `<skillDir>/screens/states`. */
export async function captureInteractions(page: Page, skillDir: string): Promise<InteractionRecord[]> {
    const statesDir = join(skillDir, "screens", "states");
    const records: InteractionRecord[] = [];
    const shoot = async (id: string, state: string): Promise<string | undefined> => {
        const target = await page.evaluate<Target | null>(TARGET_SCRIPT, id);
        if (!target || target.rect.width < 1 || target.rect.height < 1) return undefined;
        const file = `${id}-${state}.png`;
        writeFileSync(join(statesDir, file), await page.screenshot(target.rect));
        return `screens/states/${file}`;
    };

    for (const { type, selector } of TARGETS) {
        let probes: Probe[];
        try { probes = await page.evaluate<Probe[]>(TAG_SCRIPT, { selector, type, limit: PER_TYPE }); } catch { continue; }
        for (const [i, probe] of probes.entries()) {
            try {
                const base = await page.evaluate<Target | null>(TARGET_SCRIPT, probe.id);
                if (!base) continue;
                const shots: InteractionRecord["screenshots"] = { default: await shoot(probe.id, "default") };

                let hoverChanges: StyleDiff[] = [];
                try {
                    await page.mouseMove(base.center.x, base.center.y);
                    await page.wait(300);
                    const hovered = await page.evaluate<Target | null>(TARGET_SCRIPT, probe.id);
                    if (hovered) hoverChanges = diff(base.styles, hovered.styles);
                    shots.hover = await shoot(probe.id, "hover");
                    await page.mouseMove(0, 0);
                    await page.wait(200);
                } catch { /* hover unsupported on this element */ }

                let focusChanges: StyleDiff[] = [];
                try {
                    await page.evaluate(FOCUS_SCRIPT, probe.id);
                    await page.wait(300);
                    const focused = await page.evaluate<Target | null>(TARGET_SCRIPT, probe.id);
                    if (focused) focusChanges = diff(base.styles, focused.styles);
                    shots.focus = await shoot(probe.id, "focus");
                    await page.evaluate(BLUR_SCRIPT);
                    await page.wait(200);
                } catch { /* not focusable */ }

                records.push({
                    componentType: type, label: probe.label || type, selector: `${selector}:nth-of-type(${i + 1})`, index: i + 1,
                    screenshots: shots, hoverChanges, focusChanges, transitionValue: base.styles.transition,
                });
            } catch { /* element detached mid-run */ }
        }
    }
    return records;
}
