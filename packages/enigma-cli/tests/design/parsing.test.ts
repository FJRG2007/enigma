/**
 * The design extractor's parsers: the tolerant CSS walker, the static config reader (which
 * must never execute the file it reads), keyframes read from stylesheet text, and the
 * stylesheet -> token pass.
 *
 * Run: bun test tests/design/parsing.test.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { walkCss } from "../../src/design/css-parse";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { emptyRawTokens } from "../../src/design/raw-tokens";
import { extractCssTokens } from "../../src/design/extract/css-tokens";
import { keyframesInCss, keyframeUsage } from "../../src/design/ultra/keyframes";
import { readExportedObject, readTopLevelLiterals } from "../../src/design/object-literal";

function declarations(css: string, lineComments = false): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    walkCss(css, { declaration: (p, v) => out.push([p, v]) }, { lineComments });
    return out;
}

test("walkCss keeps semicolons inside strings and url() in one declaration", () => {
    const decls = declarations(".a { background: url(\"data:image/svg+xml;utf8,<svg>;</svg>\"); font-family: \"A;B\", serif }");
    expect(decls).toEqual([
        ["background", "url(\"data:image/svg+xml;utf8,<svg>;</svg>\")"],
        ["font-family", "\"A;B\", serif"],
    ]);
});

test("walkCss reads nested media blocks, drops !important and comments, reports at-rules", () => {
    const at: Array<[string, string]> = [];
    const decls: Array<[string, string]> = [];
    walkCss("/* c: d; */ @media (min-width: 768px) { .a { color: #fff !important; } } @import url(x.css);", {
        declaration: (p, v) => decls.push([p, v]),
        atRule: (n, p) => at.push([n, p]),
    });
    expect(decls).toEqual([["color", "#fff"]]);
    expect(at).toEqual([["media", "(min-width: 768px)"], ["import", "url(x.css)"]]);
});

test("walkCss treats // as a comment only when asked (SCSS), never inside url()", () => {
    const scss = "$brand: #123456; // the brand\n.a { b: url(http://x.y/z.png); }";
    expect(declarations(scss, true)).toEqual([["$brand", "#123456"], ["b", "url(http://x.y/z.png)"]]);
});

test("walkCss never throws on malformed input", () => {
    expect(() => declarations("}}} a { b: ; { c: d")).not.toThrow();
});

test("readExportedObject reads literals and resolves top-level consts, without running the file", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "enigma-design-exec-")), "ran");
    const src = `
        const fs = require("fs");
        fs.writeFileSync(${JSON.stringify(marker)}, "x");
        const brand = { 500: "#6366f1", DEFAULT: "#4f46e5" };
        module.exports = {
            content: ["./src/**/*.tsx"],
            theme: {
                extend: {
                    colors: { brand, accent: "rgb(255, 0, 0)", computed: require("x").blue, ...spread },
                    fontFamily: { sans: ["Inter", ...defaultTheme.fontFamily.sans] },
                    spacing: { 18: "4.5rem" },
                },
            },
            plugins: [require("@tailwindcss/forms")],
        } satisfies Config;
    `;
    const config = readExportedObject(src);
    expect(existsSync(marker)).toBe(false);
    expect(config).toEqual({
        content: ["./src/**/*.tsx"],
        theme: { extend: {
            colors: { brand: { 500: "#6366f1", DEFAULT: "#4f46e5" }, accent: "rgb(255, 0, 0)" },
            fontFamily: { sans: ["Inter"] },
            spacing: { 18: "4.5rem" },
        } },
        plugins: [],
    });
    rmSync(join(marker, ".."), { recursive: true, force: true });
});

test("readExportedObject handles export default, defineConfig() and a named default", () => {
    expect(readExportedObject("export default { a: 1 }")).toEqual({ a: 1 });
    expect(readExportedObject("export default defineConfig({ a: 'b' })")).toEqual({ a: "b" });
    expect(readExportedObject("const config: Config = { a: true }; export default config;")).toEqual({ a: true });
    expect(readExportedObject("export const x = 1;")).toBeNull();
    expect(readTopLevelLiterals("export const colors = { red: '#f00' };")).toEqual({ colors: { red: "#f00" } });
});

test("template literals with interpolation are dropped, plain ones kept", () => {
    expect(readExportedObject("export default { a: `x${y}`, b: `plain` }")).toEqual({ b: "plain" });
});

test("extractCssTokens: named color variables, dark-mode pairs, variable font faces, breakpoints", () => {
    const tokens = emptyRawTokens();
    extractCssTokens(`
        :root { --bg: #ffffff; --text: #111111; --accent: hsl(240 80% 60%); }
        .dark { --bg: #0b0b0b; }
        @font-face { font-family: "Brand"; src: url(/f/brand.woff2) format("woff2"); font-weight: 100 900; }
        @media (min-width: 640px) { .x { padding: 1rem 24px; } }
    `, tokens, { baseUrl: "https://site.test/css/main.css" });
    expect(tokens.colors.find((c) => c.value === "#ffffff")?.name).toBe("bg");
    expect(tokens.darkModeVars).toEqual([{ variable: "--bg", lightValue: "#ffffff", darkValue: "#0b0b0b" }]);
    expect(tokens.fontSources).toEqual([{ family: "Brand", src: "https://site.test/f/brand.woff2", format: "woff2", weight: "variable" }]);
    expect(tokens.breakpoints.map((b) => b.value)).toEqual(["640px"]);
    expect(tokens.spacingValues).toEqual([16, 24]);
});

test("keyframesInCss and keyframeUsage read cross-origin sheet text", () => {
    const css = `
        @keyframes fade { from { opacity: 0 } to { opacity: 1; transform: none } }
        @-webkit-keyframes spin { 100% { transform: rotate(360deg) } }
        .card { animation: fade .3s ease-out forwards; }
        @media (min-width: 1px) { .spinner { animation-name: spin; animation-duration: 1s; } }
        .x { content: "}"; }
    `;
    const frames = keyframesInCss(css);
    expect(frames.map((f) => f.name)).toEqual(["fade", "spin"]);
    expect(frames[0]!.stops).toEqual([
        { stop: "from", properties: { opacity: "0" } },
        { stop: "to", properties: { opacity: "1", transform: "none" } },
    ]);
    const usage = keyframeUsage(css, new Set(["fade", "spin"]));
    expect(usage.get("fade")).toMatchObject({ usedBy: [".card"], animDuration: ".3s", animEasing: "ease-out", animFillMode: "forwards" });
    expect(usage.get("spin")).toMatchObject({ usedBy: [".spinner"], animDuration: "1s" });
});
