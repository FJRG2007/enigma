/**
 * Bundle the design's typefaces into the skill's `fonts/` folder so a build from it does
 * not depend on a font CDN.
 *
 * Families published on Google Fonts (open licenses) are fetched through the public CSS2
 * endpoint - the same request a browser makes, no API key - keeping the Latin subset,
 * one variable file when the family has a weight axis, else one file per weight.
 * Fonts a site self-hosts are usually licensed for that site only, so they are copied
 * only with `--bundle-site-fonts`; otherwise their original URLs stay in the output.
 */

import { join } from "node:path";
import type { FontSource } from "./types";
import { isIconFont, isSystemFont } from "./font-names";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const CSS2 = "https://fonts.googleapis.com/css2";
/** CSS2 serves woff2 only to a browser that says it supports it. */
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20_000;
const MAX_FONT_BYTES = 5 * 1024 * 1024;
const WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"];
const WEIGHT_LABELS: Record<string, string> = {
    "100": "Thin", "200": "ExtraLight", "300": "Light", "400": "Regular", "500": "Medium",
    "600": "SemiBold", "700": "Bold", "800": "ExtraBold", "900": "Black", "variable": "Variable",
};
/** TTF (0x00010000, 'true'), OTF ('OTTO'), WOFF2 ('wOF2'), WOFF ('wOFF'). */
const FONT_MAGIC = [0x00010000, 0x74727565, 0x4f54544f, 0x774f4632, 0x774f4646];

export interface FontBundleOptions {
    /** Also copy fonts the site self-hosts (their license may not allow it). */
    siteFonts: boolean;
}

export interface FontBundle {
    sources: FontSource[];
    bundled: number;
}

/** Generic, system and icon faces: nothing to download. */
function isSkippable(family: string): boolean {
    if (!family) return true;
    if (/^(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|inherit|initial|unset)$/i.test(family)) return true;
    if (/^(helvetica\s*neue|helvetica|arial|sf\s*(pro|compact))/i.test(family)) return true;
    return isSystemFont(family) || isIconFont(family);
}

async function get(url: string, accept: string): Promise<Response | null> {
    try {
        const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, "Accept": accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        return res.ok ? res : null;
    } catch { return null; }
}

async function downloadFont(url: string): Promise<Buffer | null> {
    const res = await get(url, "*/*");
    if (!res) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_FONT_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 4 || buf.length > MAX_FONT_BYTES || !FONT_MAGIC.includes(buf.readUInt32BE(0))) return null;
    return buf;
}

function formatOf(buf: Buffer): string {
    const magic = buf.readUInt32BE(0);
    if (magic === 0x774f4632) return "woff2";
    if (magic === 0x774f4646) return "woff";
    if (magic === 0x4f54544f) return "opentype";
    return "truetype";
}

function extensionOf(format: string): string {
    return format === "woff2" ? "woff2" : format === "woff" ? "woff" : format === "opentype" ? "otf" : "ttf";
}

function fileStem(family: string, weight: string): string {
    return `${family.replace(/[^A-Za-z0-9]+/g, "")}-${WEIGHT_LABELS[weight] ?? weight.replace(/\D+/g, "")}`;
}

/** `{ weight, url }` per latin `@font-face` block of a CSS2 response. */
function latinFaces(css: string): Array<{ weight: string; url: string; }> {
    const faces: Array<{ subset: string; weight: string; url: string; }> = [];
    for (const m of css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]+)\}/g)) {
        const url = m[2]!.match(/url\(([^)]+)\)/)?.[1]?.replace(/["']/g, "");
        const weight = m[2]!.match(/font-weight:\s*([\d\s]+);/)?.[1]?.trim();
        if (url && weight) faces.push({ subset: m[1] ?? "", weight: /\s/.test(weight) ? "variable" : weight, url });
    }
    const latin = faces.filter((f) => f.subset === "latin");
    return (latin.length > 0 ? latin : faces).map(({ weight, url }) => ({ weight, url }));
}

async function googleFaces(family: string): Promise<Array<{ weight: string; url: string; }>> {
    const name = encodeURIComponent(family).replace(/%20/g, "+");
    // A variable family answers a weight range; a static one rejects it, so ask weight by weight.
    const variable = await get(`${CSS2}?family=${name}:wght@100..900&display=swap`, "text/css");
    if (variable) return latinFaces(await variable.text());
    const perWeight = await Promise.all(WEIGHTS.map(async (w) => {
        const res = await get(`${CSS2}?family=${name}:wght@${w}&display=swap`, "text/css");
        return res ? latinFaces(await res.text()) : [];
    }));
    const faces = perWeight.flat();
    if (faces.length > 0) return faces;
    const plain = await get(`${CSS2}?family=${name}&display=swap`, "text/css");
    return plain ? latinFaces(await plain.text()) : [];
}

async function saveFont(dir: string, family: string, weight: string, buf: Buffer): Promise<FontSource> {
    const format = formatOf(buf);
    const file = `${fileStem(family, weight)}.${extensionOf(format)}`;
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, file))) writeFileSync(join(dir, file), buf);
    return { family, src: `fonts/${file}`, format, weight };
}

export async function bundleFonts(fontSources: FontSource[], families: string[], skillDir: string, options: FontBundleOptions): Promise<FontBundle> {
    const dir = join(skillDir, "fonts");
    const sources: FontSource[] = [];
    const bundledFamilies = new Set<string>();
    let bundled = 0;
    const wanted = [...new Set([...fontSources.map((s) => s.family), ...families])].filter((f) => !isSkippable(f));

    for (const family of wanted) {
        const faces = await googleFaces(family);
        for (const face of faces) {
            const buf = await downloadFont(face.url);
            if (!buf) continue;
            sources.push(await saveFont(dir, family, face.weight, buf));
            bundled++;
            bundledFamilies.add(family);
        }
        if (bundledFamilies.has(family) || !options.siteFonts) continue;
        for (const src of fontSources.filter((s) => s.family === family && /^https?:/i.test(s.src))) {
            const buf = await downloadFont(src.src);
            if (!buf) continue;
            sources.push(await saveFont(dir, family, src.weight ?? "400", buf));
            bundled++;
            bundledFamilies.add(family);
        }
    }
    // Families nothing was downloaded for keep their original sources.
    for (const src of fontSources) if (!bundledFamilies.has(src.family)) sources.push(src);
    return { sources, bundled };
}
