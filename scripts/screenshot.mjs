/**
 * Render a realistic preview of the dashboard for the README. Serves the REAL dashboard
 * assets (packages/dashboard/assets) from a tiny local server, stubs the /api/* endpoints
 * with impressive mock data, and screenshots the Savings view with a headless browser.
 *
 * It renders the actual shipped UI, so the preview always matches the current dashboard
 * version - regenerate it whenever the dashboard package changes (see the screenshot
 * workflow). CI-only: Playwright is installed ephemerally, never a package dependency.
 *
 *   npm i --no-save playwright && npx playwright install chromium && node scripts/screenshot.mjs
 *
 * Output: dashboard-preview.png in the repo root.
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(ROOT, "packages", "dashboard", "assets");
const OUT = join(ROOT, "docs", "images", "dashboard.png");
const DAY = 86400000;

// Wide-monitor capture (2558x1276, ~2:1). The dashboard is normally a 1040px centered
// column; for a full ultrawide "everything at once" shot we widen the container so the
// cards, systems panel and chart spread across and fill the frame.
const VIEW = { width: 2558, height: 1276 };
const WIDEN_CSS = "body{max-width:2440px!important;padding:26px 40px!important}";

// --- impressive mock data (shape matches the dashboard's /api responses) ---------------

const PRICE = 3; // $/1M tokens, matches the dashboard's claude default

/** ~60 days of rising daily savings so the chart shows a strong upward curve. */
function mockHistory() {
    const out = [];
    const sources = ["claude-code", "opencode", "codex"];
    const types = ["json", "log", "code", "text"];
    for (let d = 59; d >= 0; d--) {
        const t0 = Date.now() - d * DAY;
        const ramp = (60 - d) / 60; // 0..1 rising
        const perDay = 4 + ((60 - d) % 5);
        for (let i = 0; i < perDay; i++) {
            const before = Math.round((9000 + ramp * 26000) * (0.85 + 0.3 * ((i % 3) / 3)));
            const after = Math.round(before * (0.21 + 0.06 * ((i % 2))));
            out.push({ t: t0 + i * 90000, b: before, a: after, s: sources[i % sources.length], c: types[i % types.length] });
        }
    }
    return out;
}

const history = mockHistory();
const totalBefore = history.reduce((s, p) => s + p.b, 0);
const totalAfter = history.reduce((s, p) => s + p.a, 0);
const totalSaved = totalBefore - totalAfter;

function sourceBucket(frac) {
    const saved = Math.round(totalSaved * frac);
    const before = Math.round(totalBefore * frac);
    return { calls: Math.round(history.length * frac), tokensBefore: before, tokensAfter: before - saved, tokensSaved: saved };
}

const STATS = {
    version: "0.1.x",
    generatedAt: Date.now(),
    priceOverride: 0,
    speedOverride: 0,
    stats: {
        calls: history.length,
        tokensBefore: totalBefore,
        tokensAfter: totalAfter,
        tokensSaved: totalSaved,
        best: 312000,
        bySource: { "claude-code": sourceBucket(0.62), "opencode": sourceBucket(0.26), "codex": sourceBucket(0.12) },
        byType: { json: sourceBucket(0.44), log: sourceBucket(0.3), code: sourceBucket(0.16), text: sourceBucket(0.1) },
    },
    history,
    cache: { count: 487, bytes: 268435456, cap: 500 },
    usage: {
        pending: false, scannedFiles: 412, sessions: 358,
        input: 9_400_000, output: 2_600_000, cacheRead: 184_000_000, cacheCreation: 7_300_000,
        byModel: {
            "claude-opus-4-8": { input: 6_100_000, output: 1_700_000, cacheRead: 132_000_000, messages: 21400 },
            "claude-sonnet-4-6": { input: 2_300_000, output: 640_000, cacheRead: 41_000_000, messages: 8800 },
            "claude-haiku-4-5": { input: 1_000_000, output: 260_000, cacheRead: 11_000_000, messages: 5200 },
        },
    },
};

const STATUS = {
    systems: {
        compress: true, usageStats: true, proxy: true,
        outputStyle: "full", minimalCode: "full", parallelSubagents: true, autoLint: true, commitEmoji: true,
        dashboard: "always",
        proxyStats: { calls: 1840, input: 12_700_000, output: 3_100_000, cacheRead: 58_000_000, cacheCreation: 2_400_000 },
        security: {
            permissionBypass: true, bypassDisabled: [],
            guardProtects: ["Block committed secrets", "Block .env files", "Block dependency/cache dirs", "Warn on generated dirs", "Warn on log / OS junk files", "Warn on files over 5 MB"],
        },
        skills: { total: 19, enigma: 17, external: 2, disabled: 0 },
    },
};

const SKILLS = { skills: [] };

const ROUTES = {
    "/api/stats": STATS,
    "/api/status": STATUS,
    "/api/skills": SKILLS,
};

// --- serve assets + mock API, then screenshot ------------------------------------------

function serve(file, type) { return { type, body: readFileSync(join(ASSETS, file)) }; }

const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    try {
        if (url === "/" || url === "/index.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(serve("index.html").body); return; }
        if (url === "/lib/chart.min.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(serve("lib/chart.min.js").body); return; }
        if (ROUTES[url]) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(ROUTES[url])); return; }
    } catch { /* fall through to 404 */ }
    res.writeHead(404).end();
});

server.listen(0, "127.0.0.1", async () => {
    const port = (server.address()).port;
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2 });
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
        await page.addStyleTag({ content: WIDEN_CSS });
        await page.waitForTimeout(2000); // let the chart resize/draw and the cards fill in
        mkdirSync(dirname(OUT), { recursive: true });
        await page.screenshot({ path: OUT, clip: { x: 0, y: 0, ...VIEW } });
        console.log("wrote", OUT);
    } finally {
        await browser.close();
        server.close();
    }
});
