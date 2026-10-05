/**
 * URL mode without a browser: crawl a site's same-origin pages, download each page's
 * linked stylesheets (following `@import`), and fold HTML and CSS into one RawTokens plus
 * the components the markup shows. Works on any machine; the browser pass in computed.ts
 * only adds to it.
 */

import { emptyRawTokens } from "../raw-tokens";
import type { ComponentInfo, RawTokens } from "../types";
import { detectHtmlComponents } from "./html-components";
import { extractCssTokens, importUrls } from "./css-tokens";
import { decodeInlineModules, detectPageSections, extractFontLinks, extractInlineColors, extractInlineModules, extractMeta } from "./html";

const FETCH_TIMEOUT_MS = 15_000;
/** A page or stylesheet past this is not design source; reading it would only cost memory. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const CSS_CONCURRENCY = 6;
const USER_AGENT = "Mozilla/5.0 (compatible; enigma-design; +https://github.com/FJRG2007/enigma)";

export interface HttpExtraction {
    tokens: RawTokens;
    components: ComponentInfo[];
    pages: string[];
}

/** GET `url` as text, or null on any failure (non-2xx, timeout, oversize, non-HTTP scheme). */
export async function fetchText(url: string): Promise<string | null> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    try {
        const res = await fetch(parsed, {
            headers: { "User-Agent": USER_AGENT, "Accept": "text/html,text/css,application/xhtml+xml,*/*" },
            redirect: "follow",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok || !res.body) return null;
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (declared > MAX_RESPONSE_BYTES) { await res.body.cancel(); return null; }
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return null; }
            chunks.push(value);
        }
        return Buffer.concat(chunks).toString("utf8");
    } catch {
        return null;
    }
}

function resolveUrl(href: string, base: string): string | null {
    try { return new URL(href, base).href; } catch { return null; }
}

function stylesheetUrls(html: string, base: string): string[] {
    const urls = new Set<string>();
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
        if (!/rel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) continue;
        const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
        const url = href ? resolveUrl(href, base) : null;
        if (url) urls.add(url);
    }
    return [...urls];
}

function inlineStyles(html: string): string[] {
    return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!).filter((s) => s.trim());
}

/** Same-origin page links (no fragments, no obvious asset files), in document order. */
export function pageLinks(html: string, base: string, origin: string): string[] {
    const links: string[] = [];
    for (const m of html.matchAll(/<a[^>]+href\s*=\s*["']([^"'#]+)["']/gi)) {
        const url = resolveUrl(m[1]!, base);
        if (!url || !url.startsWith(origin) || links.includes(url)) continue;
        if (/\.(pdf|zip|png|jpe?g|gif|svg|ico|css|js|xml|json|txt|mp4|webm)$/i.test(new URL(url).pathname)) continue;
        links.push(url);
    }
    return links;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]!);
        }
    });
    await Promise.all(workers);
    return out;
}

export async function extractHttpTokens(url: string, maxPages: number): Promise<HttpExtraction> {
    const tokens = emptyRawTokens();
    const origin = new URL(url).origin;
    const visited = new Set<string>();
    const queue = [url];
    const fetchedCss = new Set<string>();
    const allHtml: string[] = [];
    const allCss: string[] = [];

    while (queue.length > 0 && visited.size < maxPages) {
        const pageUrl = queue.shift()!;
        if (visited.has(pageUrl)) continue;
        visited.add(pageUrl);
        const html = await fetchText(pageUrl);
        if (!html) continue;
        allHtml.push(html);

        extractInlineColors(html, tokens);
        extractMeta(html, tokens);
        extractFontLinks(html, tokens);
        detectPageSections(html, tokens);
        allCss.push(...extractInlineModules(html, tokens));

        const styles = inlineStyles(html);
        const pending = stylesheetUrls(html, pageUrl);
        for (const style of styles) pending.push(...importUrls(style, pageUrl));

        // Breadth-first over stylesheets, so `@import` chains are followed without recursion.
        while (pending.length > 0) {
            const batch = pending.splice(0).filter((u) => !fetchedCss.has(u));
            for (const u of batch) fetchedCss.add(u);
            const bodies = await mapLimit(batch, CSS_CONCURRENCY, fetchText);
            bodies.forEach((css, i) => {
                if (!css) return;
                allCss.push(css);
                extractCssTokens(css, tokens, { baseUrl: batch[i] });
                for (const nested of importUrls(css, batch[i]!)) if (!fetchedCss.has(nested)) pending.push(nested);
            });
        }
        for (const style of styles) {
            allCss.push(style);
            extractCssTokens(style, tokens, { baseUrl: pageUrl });
        }

        if (visited.size < maxPages) {
            for (const link of pageLinks(html, pageUrl, origin).slice(0, 5)) if (!visited.has(link)) queue.push(link);
        }
    }

    const combinedHtml = allHtml.join("\n");
    const decodedJs = allHtml.flatMap(decodeInlineModules).join("\n");
    const components = detectHtmlComponents(`${combinedHtml}\n${decodedJs}`, allCss.join("\n"));
    return { tokens, components, pages: [...visited] };
}
