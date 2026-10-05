/**
 * Normalization rules and packaging: color roles (names first, one color per role, variants
 * never take a role), the rendered type scale, the markdown escaping that keeps extracted
 * text inert, the ZIP writer, and argument validation.
 *
 * Run: bun test tests/design/profile.test.ts
 */
import { test, expect } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { normalize } from "../../src/design/normalize";
import { parseDesignArgs } from "../../src/design/cli";
import { pageLinks } from "../../src/design/extract/http";
import { skillName } from "../../src/design/write/skill-md";
import { emptyRawTokens } from "../../src/design/raw-tokens";
import { buildZip, crc32 } from "../../src/design/write/zip";
import { code, fenced, text } from "../../src/design/write/md";
import { preferredName, roleFromName } from "../../src/design/roles";

function profileOf(colors: Array<[string, string | undefined, number]>) {
    const raw = emptyRawTokens();
    raw.colors = colors.map(([value, name, frequency]) => ({ value, name, frequency, source: "css" as const }));
    return normalize("site", [], raw, []);
}

test("roles come from token names first, and a dark --bg makes the theme dark", () => {
    const p = profileOf([
        ["#ffffff", undefined, 50], ["#080a10", "bg", 6], ["#12161f", "surface", 5], ["#eceef2", "text", 5],
        ["#232a36", "border", 4], ["#e0a458", "accent", 4], ["#1a1206", "warning-bg", 9], ["#e3c14e", "warn", 1],
    ]);
    const role = (r: string) => p.colors.find((c) => c.role === r)?.hex;
    expect(role("background")).toBe("#080a10");
    expect(role("surface")).toBe("#12161f");
    expect(role("text-primary")).toBe("#eceef2");
    expect(role("border")).toBe("#232a36");
    expect(role("accent")).toBe("#e0a458");
    expect(role("warning")).toBe("#e3c14e");
    expect(p.designTraits.isDark).toBe(true);
    for (const r of ["background", "surface", "text-primary", "border", "accent", "warning"]) {
        expect(p.colors.filter((c) => c.role === r)).toHaveLength(1);
    }
});

test("variant names never claim a role; the outright role name wins a shared color", () => {
    expect(roleFromName("warning-bg")).toBeNull();
    expect(roleFromName("accent2")).toBeNull();
    expect(roleFromName("color-border")).toBe("border");
    expect(roleFromName("muted-foreground")).toBe("text-muted");
    expect(preferredName("info-bg", "bg")).toBe("bg");
    expect(preferredName("bg", "info-bg")).toBe("bg");
    expect(preferredName(undefined, "x")).toBe("x");
});

test("a measured type scale replaces frequency guesses", () => {
    const raw = emptyRawTokens();
    raw.fonts = [{ family: "Roboto", source: "css" }, { family: "Roboto", source: "css" }, { family: "Brand", source: "computed" }];
    raw.renderedType = [
        { tag: "h1", family: "Brand", size: "48px", weight: "300", lineHeight: "56px" },
        { tag: "p", family: "Brand", size: "16px", weight: "400", lineHeight: "24px" },
    ];
    const t = normalize("site", [], raw, []).typography;
    expect(t.map((x) => [x.role, x.fontFamily, x.fontSize, x.fontWeight])).toEqual([
        ["heading-1", "Brand", "48px", "300"],
        ["body", "Brand", "16px", "400"],
    ]);
});

test("spacing finds the base grid", () => {
    const raw = emptyRawTokens();
    raw.spacingValues = [8, 16, 24, 32, 48, 64, 8, 16];
    expect(normalize("x", [], raw, []).spacing.base).toBe(8);
});

test("extracted text cannot escape its markdown construct", () => {
    expect(code("a`b")).toBe("``a`b``");
    expect(code("x\n# Heading")).toBe("`x # Heading`");
    expect(text("# [link](http://x) *b*")).toBe("\\# \\[link\\](http://x) \\*b\\*");
    const block = fenced("html", "```\n# not a heading\n```");
    expect(block.startsWith("````html\n")).toBe(true);
    expect(block.trimEnd().endsWith("\n````")).toBe(true);
});

test("skill names are lowercase slugs", () => {
    expect(skillName("@enigmax/Web App")).toBe("enigmax-web-app-design");
    expect(skillName("!!!")).toBe("project-design");
});

test("crc32 matches the standard check value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
});

test("buildZip writes entries a reader can list and inflate", () => {
    const files = [
        { name: "pkg/SKILL.md", data: Buffer.from("# Skill\n".repeat(50)), modified: new Date(2026, 0, 2, 3, 4, 6) },
        { name: "pkg/x.png", data: Buffer.from([1, 2, 3]), modified: new Date(2026, 0, 2) },
    ];
    const zip = buildZip(files);
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2);
    let at = zip.readUInt32LE(eocd + 16);
    for (const f of files) {
        expect(zip.readUInt32LE(at)).toBe(0x02014b50);
        const method = zip.readUInt16LE(at + 10);
        const size = zip.readUInt32LE(at + 20);
        const nameLen = zip.readUInt16LE(at + 28);
        const local = zip.readUInt32LE(at + 42);
        expect(zip.subarray(at + 46, at + 46 + nameLen).toString()).toBe(f.name);
        expect(zip.readUInt32LE(at + 16)).toBe(crc32(f.data));
        const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const body = zip.subarray(dataStart, dataStart + size);
        expect(Buffer.compare(method === 8 ? inflateRawSync(body) : body, f.data)).toBe(0);
        at += 46 + nameLen;
    }
});

test("arguments are validated before anything runs", () => {
    expect(parseDesignArgs(["--url", "ftp://x"]).error).toContain("http(s)");
    expect(parseDesignArgs(["--repo", "--upload-pack=evil"]).error).toContain("missing value");
    expect(parseDesignArgs(["--repo", "-c core.sshCommand=x"]).error).toContain("missing value");
    expect(parseDesignArgs(["--screens", "50"]).error).toContain("1 to 20");
    expect(parseDesignArgs(["--format", "pdf"]).error).toContain("--format");
    expect(parseDesignArgs(["--agent", "nope"]).error).toContain("unknown agent");
    expect(parseDesignArgs(["https://a.test", "--dir", "."]).error).toContain("one source");
    expect(parseDesignArgs(["https://a.test", "--ultra", "--no-browser"]).error).toContain("--no-browser");
    const ok = parseDesignArgs(["https://site.test/x", "--ultra", "--screens", "3", "--no-install", "-a", "claude"]).options!;
    expect(ok).toMatchObject({ source: "url", target: "https://site.test/x", ultra: true, screens: 3, install: "none", agents: ["claude"] });
    expect(parseDesignArgs(["https://github.com/org/repo"]).options?.source).toBe("repo");
    expect(parseDesignArgs(["."]).options?.source).toBe("dir");
    expect(parseDesignArgs(["https://site.test"]).installChosen).toBe(false);
    expect(parseDesignArgs(["https://site.test", "-l"]).installChosen).toBe(true);
});

test("page links stay on the exact origin", () => {
    const html = `<a href="/about">a</a><a href="https://site.test.evil.test/x">b</a><a href="https://site.test:8443/y">c</a><a href="https://site.test/z.pdf">d</a>`;
    expect(pageLinks(html, "https://site.test/", "https://site.test")).toEqual(["https://site.test/about"]);
});
