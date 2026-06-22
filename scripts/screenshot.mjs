/**
 * Render realistic previews of the dashboard for the README. Serves the REAL dashboard
 * assets (packages/dashboard/assets) from a tiny local server, stubs the /api/* endpoints
 * with impressive mock data, and screenshots BOTH the Savings view (dashboard.png) and the
 * Usage view (usage.png) with a headless browser.
 *
 * It renders the actual shipped UI, so the preview always matches the current dashboard
 * version - regenerate it whenever the dashboard package changes (see the screenshot
 * workflow). CI-only: Playwright is installed ephemerally, never a package dependency.
 *
 *   npm i --no-save playwright && npx playwright install chromium && node scripts/screenshot.mjs
 *
 * Output: docs/images/dashboard.png (Savings) and docs/images/usage.png (Usage).
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(ROOT, "packages", "dashboard", "assets");
const OUT = join(ROOT, "docs", "images", "dashboard.png");
const OUT_USAGE = join(ROOT, "docs", "images", "usage.png");
const DAY = 86400000;

// Wide-monitor capture (2558x1276, ~2:1). The dashboard now fills the width on its own
// (max-width 2200), so this frame shows it exactly as it looks on a wide monitor.
const VIEW = { width: 2558, height: 1276 };

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

/** The next Monday 11:00 (local), strictly after `now` - the weekly window reset. */
function nextMonday11(now) {
    const d = new Date(now);
    d.setHours(11, 0, 0, 0);
    while (d.getDay() !== 1 || d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
}

/** Rich mock for the Usage view: live windows, cost, per-account/model/project, sessions. */
function mockUsage() {
    const now = Date.now();
    const week = nextMonday11(now);
    const b = (input, output, cacheRead, messages, cost) => ({ input, output, cacheRead, cacheCreation: Math.round(cacheRead * 0.04), messages, cost });
    const sess = (mins, account, project, model, input, output, cost) => ({
        id: "sess", account, project, model, lastActive: now - mins * 60000, input, output, cacheRead: input * 180, cacheCreation: input * 8, messages: 40, cost,
    });
    return {
        pending: false, scannedFiles: 712, sessions: 643,
        input: 41_800_000, output: 12_400_000, cacheRead: 824_000_000, cacheCreation: 33_500_000, messages: 158300, cost: 6340,
        windows: {
            session: { label: "Current session", kind: "session", used: 61_740_000, cost: 34.61, limit: 0, pct: 62, resetsAt: now + (3 * 60 + 48) * 60000, live: true },
            weeklyAll: { label: "All models", kind: "weekly", used: 422_440_000, cost: 1820, limit: 0, pct: 41, resetsAt: week, live: true },
            weeklySonnet: { label: "Sonnet only", kind: "weekly", used: 38_000_000, cost: 210, limit: 0, pct: 9, resetsAt: week, live: true },
        },
        block: { active: true, startedAt: now - 72 * 60000, endsAt: now + 228 * 60000, tokens: 61_740_000, cost: 34.61, burnRatePerMin: 895800, projectedTokens: 266_280_000, projectedCost: 149.29 },
        byAccount: {
            "default": b(28_900_000, 9_100_000, 640_000_000, 110000, 4850),
            "ByteHide": b(12_900_000, 3_300_000, 184_000_000, 48300, 1490),
        },
        byModel: {
            "claude-opus-4-8": b(27_300_000, 8_100_000, 592_000_000, 96400, 5210),
            "claude-opus-4-7": b(2_900_000, 1_000_000, 84_000_000, 12000, 931),
            "claude-sonnet-4-6": b(10_200_000, 3_000_000, 184_000_000, 39800, 170),
            "claude-haiku-4-5": b(1_400_000, 300_000, 48_000_000, 22100, 34),
        },
        byProject: {
            "C--Users-admin-Documents-DEV-TPEOficial-cerberus": b(9_440_000, 11_010_000, 2_930_000_000, 11200, 1890),
            "C--Users-admin-Documents-DEV-FJRG2007-orphion": b(4_660_000, 6_050_000, 1_760_000_000, 6200, 1100),
            "C--Users-admin-Documents-DEV-FJRG2007-ai": b(5_050_000, 6_290_000, 1_200_000_000, 5000, 916),
            "C--Users-admin-Documents-DEV-ByteHide-ai-gateway": b(5_580_000, 4_780_000, 1_180_000_000, 4200, 788),
            "C--Users-admin-Documents-DEV-TPEOficial-dymo-api": b(2_490_000, 3_870_000, 945_000_000, 3000, 622),
        },
        providers: [
            { tool: "claude", label: "Claude Code", available: true, note: "2 accounts - local transcripts" },
            { tool: "codex", label: "Codex", available: false, note: "no local token-usage store" },
            { tool: "opencode", label: "OpenCode", available: false, note: "no local token-usage store" },
        ],
        recentSessions: [
            sess(3, "default", "C--Users-admin-Documents-DEV-FJRG2007-ai", "claude-opus-4-8", 16200, 338100, 72.30),
            sess(174, "default", "C--Users-admin-Documents-DEV-FJRG2007-ai", "claude-opus-4-8", 11500, 543300, 113.73),
            sess(201, "ByteHide", "C--Users-admin-Documents-DEV-ByteHide-ai-gateway", "claude-opus-4-8", 5200, 4700, 0.97),
            sess(320, "default", "C--Users-admin-Documents-DEV-TPEOficial-cerberus", "claude-opus-4-8", 39900, 478200, 75.63),
            sess(540, "ByteHide", "C--Users-admin-Documents-DEV-ByteHide-bytehide-monitor-python", "claude-sonnet-4-6", 8500, 110400, 9.24),
        ],
    };
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
    usage: mockUsage(),
};

const STATUS = {
    systems: {
        compress: true, usageStats: true, proxy: true,
        outputStyle: "full", minimalCode: "full", parallelSubagents: true, autoLint: true, commitEmoji: true,
        dashboard: "always", live: true,
        proxyStats: { calls: 9240, input: 96_000_000, output: 24_000_000, cacheRead: 412_000_000, cacheCreation: 18_500_000 },
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

        // Usage view (the cost/windows/breakdowns tab) - taller, captured top-down.
        const USAGE_H = 1760;
        await page.setViewportSize({ width: VIEW.width, height: USAGE_H });
        await page.click('a[data-view="usage"]');
        await page.waitForTimeout(1500); // let the usage panels + window bars render
        await page.screenshot({ path: OUT_USAGE, clip: { x: 0, y: 0, width: VIEW.width, height: USAGE_H } });
        console.log("wrote", OUT_USAGE);
    } finally {
        await browser.close();
        server.close();
    }
});
