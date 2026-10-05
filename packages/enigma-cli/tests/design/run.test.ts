/**
 * `enigma design` end to end, offline: a fixture project and a site served from a local
 * HTTP server go through runDesign into a temp output folder, and the skill is installed
 * into a temp home. The browser case runs only where Chrome/Edge/Chromium/Brave exists.
 *
 * Home is redirected BEFORE the modules load: agents.ts resolves skill dirs at import.
 *
 * Run: bun test tests/design/run.test.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const root = mkdtempSync(join(tmpdir(), "enigma-design-test-"));
const home = join(root, "home");
mkdirSync(join(home, ".claude"), { recursive: true });
process.env.ENIGMA_CONFIG_HOME = home;

const { runDesign, MARKER_FILE } = await import("../../src/design/run");
const { findBrowser } = await import("../../src/design/browser/chrome");
type Options = Parameters<typeof runDesign>[0];

const quiet = { step: () => {}, done: () => {}, warn: () => {} };
const servers: Server[] = [];
afterAll(() => {
    for (const s of servers) s.close();
    rmSync(root, { recursive: true, force: true });
});

function writeTree(dir: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(dir, rel, ".."), { recursive: true });
        writeFileSync(join(dir, rel), content);
    }
}

function options(over: Partial<Options>): Options {
    return { source: "dir", target: "", out: join(root, "out"), format: "both", ultra: false, screens: 2, browser: null, install: "none", agents: [], fonts: false, siteFonts: false, force: false, ...over };
}

test("dir mode: tailwind config, stylesheets, <style> blocks and components become a skill installed for the agent", async () => {
    const project = join(root, "acme");
    writeTree(project, {
        "package.json": JSON.stringify({ name: "acme-web", dependencies: { react: "19.0.0", tailwindcss: "3.4.0", "lucide-react": "1.0.0" } }),
        "tailwind.config.js": "module.exports = { theme: { extend: { colors: { brand: '#ff5a1f' }, fontFamily: { display: ['Sora', 'sans-serif'] } } } };",
        "src/styles/app.css": ":root { --bg: #0f1115; --text: #f5f5f5; --border: #2a2f3a; } .card { border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,.3); padding: 16px; }",
        "src/components/Button.tsx": "export function Button({ variant, size }: Props) { return (\n<button className=\"rounded-lg bg-brand px-4 py-2 hover:scale-105 transition-all\">Go</button>\n); }",
        "src/components/Panel.vue": "<template><div class=\"panel\"/></template>\n<style scoped>.panel { background: #1a1d24; gap: 24px; }</style>",
    });
    const result = await runDesign(options({ target: project, install: "global", agents: ["claude"] }), quiet);

    expect(result.profile.projectName).toBe("acme-web");
    expect(result.profile.iconLibrary).toBe("Lucide");
    expect(result.profile.frameworks.map((f) => f.id)).toEqual(expect.arrayContaining(["react", "tailwind"]));
    const role = (r: string) => result.profile.colors.find((c) => c.role === r)?.hex;
    expect(role("background")).toBe("#0f1115");
    expect(role("text-primary")).toBe("#f5f5f5");
    expect(result.profile.colors.some((c) => c.hex === "#1a1d24")).toBe(true);
    expect(result.profile.components.map((c) => c.name)).toContain("Button");

    const dir = result.designDir;
    expect(dir.endsWith("acme-web-design")).toBe(true);
    for (const f of ["SKILL.md", "DESIGN.md", "references/DESIGN.md", "tokens/colors.json", "acme-web-design.skill", MARKER_FILE]) expect(existsSync(join(dir, f))).toBe(true);
    const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
    expect(skill.startsWith("---\nname: acme-web-design\n")).toBe(true);
    expect(skill.endsWith("\n") && !skill.endsWith("\n\n")).toBe(true);

    expect(result.installs).toEqual([{ agent: "claude", path: join(home, ".claude", "skills", "acme-web-design"), status: "installed" }]);
    const installed = readdirSync(join(home, ".claude", "skills", "acme-web-design"));
    expect(installed).toContain("SKILL.md");
    expect(installed).not.toContain("acme-web-design.skill");
    expect(installed).not.toContain("CLAUDE.md");

    // A re-run replaces its own folders; a foreign skill of the same name is left alone.
    const again = await runDesign(options({ target: project, install: "global", agents: ["claude"] }), quiet);
    expect(again.installs[0]!.status).toBe("installed");
    rmSync(join(home, ".claude", "skills", "acme-web-design", MARKER_FILE));
    const third = await runDesign(options({ target: project, install: "global", agents: ["claude"] }), quiet);
    expect(third.installs[0]!.status).toBe("skipped");
});

test("an output folder enigma did not create is never replaced without --force", async () => {
    const project = join(root, "plain");
    writeTree(project, { "package.json": JSON.stringify({ name: "plain" }), "a.css": "a { color: #123456; }" });
    const out = join(root, "out-foreign");
    writeTree(join(out, "plain-design"), { "notes.txt": "mine" });
    await expect(runDesign(options({ target: project, out }), quiet)).rejects.toThrow("--force");
    expect(readFileSync(join(out, "plain-design", "notes.txt"), "utf8")).toBe("mine");
});

function serve(pages: Record<string, [string, string]>): Promise<string> {
    return new Promise((resolve) => {
        const server = createServer((req, res) => {
            const page = pages[req.url ?? "/"];
            if (!page) { res.writeHead(404).end(); return; }
            res.writeHead(200, { "content-type": page[0] }).end(page[1]);
        });
        servers.push(server);
        server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number; }).port}/`));
    });
}

const SITE: Record<string, [string, string]> = {
    "/": ["text/html", `<!doctype html><html><head><title>Fixture &amp; Co</title><meta name="theme-color" content="#4f46e5">
        <link rel="stylesheet" href="/main.css"><link rel="icon" href="/favicon.png?v=2"></head>
        <body><nav class="nav"><a href="/about">About</a></nav><section class="hero"><h1>Build things</h1><p>Body copy here.</p>
        <button class="btn btn-primary">Start</button></section><footer>f</footer></body></html>`],
    "/about": ["text/html", "<html><body><h1>About</h1><p>x</p></body></html>"],
    "/main.css": ["text/css", `@import url("/extra.css");
        :root { --background: #ffffff; --foreground: #111827; --primary: #4f46e5; color-scheme: light; }
        body { font-family: "Inter", sans-serif; font-size: 16px; } h1 { font-size: 48px; font-weight: 700; } h2 { font-size: 32px; }
        .btn { transition: background-color 150ms ease-out; border-radius: 8px; }
        @keyframes pulse { 0% { opacity: 1 } 50% { opacity: .5 } 100% { opacity: 1 } }
        .btn:hover { animation: pulse 1s infinite; }`],
    "/extra.css": ["text/css", "@media (min-width: 768px) { .hero { padding: 64px 32px; } }"],
};

test("url mode without a browser: HTTP crawl, @import, meta, sections, components", async () => {
    const url = await serve(SITE);
    const result = await runDesign(options({ source: "url", target: url, useBrowser: false }), quiet);
    expect(result.browserUsed).toBe(false);
    const p = result.profile;
    expect(p.projectName).toBe("127");
    expect(p.siteUrl).toBe(url);
    expect(p.favicon).toBe("/favicon.png");
    expect(p.colors.find((c) => c.role === "accent")?.hex).toBe("#4f46e5");
    expect(p.breakpoints.map((b) => b.value)).toContain("768px");
    expect(p.pageSections.map((s) => s.type)).toEqual(expect.arrayContaining(["navigation", "hero", "footer"]));
    expect(p.components.map((c) => c.name)).toEqual(expect.arrayContaining(["Button", "Navigation", "Footer"]));
    expect(p.motionTokens.durations).toContain("150ms");
    expect(p.animations.some((a) => a.name === "pulse")).toBe(true);
});

const browser = findBrowser();
test.skipIf(!browser)("ultra mode with the local browser: screenshots, keyframes, layouts, states, and no leftover profile", async () => {
    const url = await serve(SITE);
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith("enigma-design-") && !d.startsWith("enigma-design-test-"));
    const result = await runDesign(options({ source: "url", target: url, ultra: true, screens: 2, out: join(root, "out-ultra") }), quiet);
    expect(result.browserUsed).toBe(true);
    const dir = result.designDir;
    expect(existsSync(join(dir, "screenshots", "homepage.png"))).toBe(true);
    expect(readdirSync(join(dir, "screens", "scroll")).filter((f) => f.startsWith("scroll-"))).toHaveLength(7);
    expect(readdirSync(join(dir, "screens", "pages")).length).toBeGreaterThanOrEqual(1);
    expect(result.animations!.keyframes.map((k) => k.name)).toContain("pulse");
    expect(readdirSync(join(dir, "screens", "states")).some((f) => f.startsWith("button-1-"))).toBe(true);
    for (const f of ["ANIMATIONS.md", "LAYOUT.md", "INTERACTIONS.md", "COMPONENTS.md", "VISUAL_GUIDE.md"]) expect(existsSync(join(dir, "references", f))).toBe(true);
    const type = result.profile.typography.find((t) => t.role === "heading-1");
    expect(type).toMatchObject({ fontSize: "48px", fontWeight: "700" });
    const after = readdirSync(tmpdir()).filter((d) => d.startsWith("enigma-design-") && !d.startsWith("enigma-design-test-"));
    expect(after.filter((d) => !before.includes(d))).toEqual([]);
}, 180_000);
