/**
 * Full-page and per-section screenshots of up to N same-origin pages, crawled
 * breadth-first from the start URL.
 */

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { VIEWPORT } from "../browser/page";
import type { Browser } from "../browser/page";
import { LINKS_SCRIPT } from "../extract/computed";
import type { PageScreenshot, SectionScreenshot } from "../types";

const MAX_SECTIONS_PER_PAGE = 10;

/** Runs in the page: wide, tall section-like blocks in document coordinates, one per 50px band. */
const SECTIONS_SCRIPT = String.raw`() => {
    const SELECTORS = ["section", "article", "header", "footer", "nav", "main > div", "main > section", "[class*=section]",
        "[class*=hero]", "[class*=features]", "[class*=pricing]", "[class*=testimonial]", "[class*=faq]", "[class*=cta]"];
    const found = [];
    for (const sel of SELECTORS) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
            const r = el.getBoundingClientRect();
            if (r.width < window.innerWidth * 0.6 || r.height < 200) continue;
            found.push({ selector: sel, rect: { x: Math.max(0, r.left), y: Math.max(0, r.top + window.scrollY), width: Math.min(r.width, 1440), height: Math.min(r.height, 1200) } });
        }
    }
    const out = [];
    for (const c of found) if (!out.some((d) => Math.abs(d.rect.y - c.rect.y) < 50)) out.push(c);
    return out.slice(0, 10);
}`;

function normalizeUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`.replace(/\/$/, "");
    } catch { return url; }
}

/** `/docs/getting-started/` -> `docs--getting-started`; the root is `home`. */
export function urlToSlug(url: string): string {
    try {
        const rel = new URL(url).pathname.replace(/^\//, "").replace(/\/$/, "") || "home";
        return rel.replace(/[^a-zA-Z0-9/]/g, "-").replace(/\//g, "--").replace(/-{3,}/g, "--").slice(0, 60) || "home";
    } catch { return "home"; }
}

export async function capturePages(browser: Browser, startUrl: string, skillDir: string, maxPages: number): Promise<{ pages: PageScreenshot[]; sections: SectionScreenshot[]; }> {
    const pages: PageScreenshot[] = [];
    const sections: SectionScreenshot[] = [];
    const visited = new Set<string>();
    const usedSlugs = new Set<string>();
    const queue = [startUrl];
    // Redirects make two links one page; bound the attempts so a site of redirects cannot loop.
    let attempts = 0;

    while (queue.length > 0 && pages.length < maxPages && attempts < maxPages * 3) {
        const requested = queue.shift()!;
        if (visited.has(normalizeUrl(requested))) continue;
        visited.add(normalizeUrl(requested));
        attempts++;

        const page = await browser.newPage();
        try {
            await page.goto(requested);
            await page.wait(3000);
            // Name and dedupe by where the browser landed, not by the link that led there.
            const url = await page.evaluate<string>("() => location.href").catch(() => requested);
            if (pages.some((p) => normalizeUrl(p.url) === normalizeUrl(url))) continue;
            visited.add(normalizeUrl(url));
            let slug = urlToSlug(url);
            for (let n = 2; usedSlugs.has(slug); n++) slug = `${urlToSlug(url)}-${n}`;
            usedSlugs.add(slug);
            writeFileSync(join(skillDir, "screens", "pages", `${slug}.png`), await page.fullPageScreenshot());
            const title = (await page.title().catch(() => "")) || slug;
            pages.push({ url, slug, filePath: `screens/pages/${slug}.png`, title });

            const found = await page.evaluate<Array<{ selector: string; rect: { x: number; y: number; width: number; height: number; }; }>>(SECTIONS_SCRIPT);
            for (const [i, sec] of found.slice(0, MAX_SECTIONS_PER_PAGE).entries()) {
                const file = `${slug}-section-${i + 1}.png`;
                try {
                    writeFileSync(join(skillDir, "screens", "sections", file), await page.screenshot({ ...sec.rect, width: Math.min(sec.rect.width, VIEWPORT.width) }));
                    sections.push({ page: slug, index: i + 1, filePath: `screens/sections/${file}`, selector: sec.selector, height: Math.round(sec.rect.height), width: Math.round(sec.rect.width) });
                } catch { /* one failed clip does not void the page */ }
            }

            if (pages.length < maxPages) {
                const links = await page.evaluate<string[]>(LINKS_SCRIPT, url);
                for (const link of links.slice(0, 20)) if (!visited.has(normalizeUrl(link)) && !queue.includes(link)) queue.push(link);
            }
        } catch { /* a page that fails to load is skipped */ }
        finally { await page.close(); }
    }
    return { pages, sections };
}
