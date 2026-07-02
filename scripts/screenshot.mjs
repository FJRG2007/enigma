/**
 * Render a realistic preview of the dashboard for the README. Serves the REAL dashboard
 * assets (packages/dashboard/assets) from a tiny local server, stubs the /api/* endpoints
 * with fully synthetic mock data, and screenshots the Savings view (dashboard.png) with a
 * headless browser.
 *
 * It renders the actual shipped UI, so the preview always matches the current dashboard
 * version - regenerate it whenever the dashboard package changes (see the screenshot
 * workflow). CI-only: Playwright is installed ephemerally, never a package dependency.
 *
 * The Usage view is intentionally NOT screenshotted: it renders per-project / per-account
 * names, and any realistic mock for it risks embedding real, private project identifiers
 * in a public image. Keep all mock data here generic and non-identifying.
 *
 *   npm i --no-save playwright && npx playwright install chromium && node scripts/screenshot.mjs
 *
 * Output: assets/images/dashboard.png (Savings).
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(ROOT, "packages", "dashboard", "assets");
const OUT = join(ROOT, "assets", "images", "dashboard.png");
const DAY = 86400000;

// Capture frame sized to the dashboard's own max-width (1560) plus side margins, so the
// preview shows the centered, intentional layout - not a stretched ultrawide column.
const VIEW = { width: 1680, height: 1380 };

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
            const before = Math.round((1_250_000 + ramp * 2_050_000) * (0.85 + 0.3 * ((i % 3) / 3)));
            const after = Math.round(before * (0.18 + 0.05 * ((i % 2))));
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
        best: 3_120_000,
        bySource: { "claude-code": sourceBucket(0.62), "opencode": sourceBucket(0.26), "codex": sourceBucket(0.12) },
        byType: { json: sourceBucket(0.44), log: sourceBucket(0.3), code: sourceBucket(0.16), text: sourceBucket(0.1) },
    },
    history,
    cache: { count: 487, bytes: 268435456, cap: 500 },
    // No `usage` block: the Usage view renders per-project/account identifiers, so it is
    // never screenshotted (see the header note). The Savings view does not read usage.
    usage: null,
};

// Keep this in sync with SystemsStatus (dashboard-status.ts) so the preview renders every
// row the live "Enigma Systems" panel does - a missing field would silently show as off.
const STATUS = {
    systems: {
        compress: true, codeGraph: true, usageStats: true, proxy: true, usageApi: true,
        promptSecretGuard: true, promptSecretMode: "redact",
        outputStyle: "full", minimalCode: "full", parallelSubagents: true, autoLint: true, commitEmoji: true,
        dashboard: "always", live: true,
        proxyStats: {
            calls: 9240, input: 96_000_000, output: 24_000_000, cacheRead: 412_000_000, cacheCreation: 18_500_000,
            lastRequestAt: Date.now() - 4 * 60 * 1000, redacted: 12, rejected: 3, lastBlockedAt: Date.now() - 36 * 60 * 1000,
        },
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
        await page.waitForTimeout(2000); // let the chart resize/draw and the cards fill in
        mkdirSync(dirname(OUT), { recursive: true });
        await page.screenshot({ path: OUT, clip: { x: 0, y: 0, ...VIEW } });
        console.log("wrote", OUT);
    } finally {
        await browser.close();
        server.close();
    }
});
