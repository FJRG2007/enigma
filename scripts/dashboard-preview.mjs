/**
 * Preview the dashboard UI locally before publishing it.
 *
 * Two modes, one command:
 *   node scripts/dashboard-preview.mjs            # MOCK data (default) - like the public web demo
 *   node scripts/dashboard-preview.mjs --real     # REAL data - hands off to `enigma dashboard`
 *   node scripts/dashboard-preview.mjs --port 8080 [--no-open]
 *
 * Mock mode serves the REAL, currently-edited dashboard assets (packages/dashboard/assets) and
 * injects the web demo's fetch shim (apps/web/scripts/demo-mock.js) as the first <head> script,
 * so every /api/* call is answered client-side with internally-consistent synthetic data. Nothing
 * is read from ~/.enigma and nothing leaves the machine - it is the fastest way to see how the UI
 * looks (all panels and selectors populated) with your changes, before bumping the version.
 *
 * Real mode is a thin convenience: it spawns the actual CLI dashboard (your real savings/usage),
 * which in this workspace serves these same assets - so the same edits show up against live data.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { dirname, join, extname } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS = join(ROOT, "packages", "dashboard", "assets");
const MOCK = join(ROOT, "apps", "web", "scripts", "demo-mock.js");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flagVal = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : undefined; };

if (has("--real")) {
    // Real data: defer to the actual dashboard server (reads ~/.enigma; serves these assets in dev).
    console.log("Launching the real dashboard (live data) via `enigma dashboard`...");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npm, ["run", "enigma", "--", "dashboard"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => process.exit(code ?? 0));
} else {
    const port = Number(flagVal("--port")) || 7575;
    const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
    // Inject the demo fetch shim as the first thing inside <head> so it patches window.fetch
    // before any dashboard script runs.
    const injectMock = (html) => html.replace(/<head([^>]*)>/i, `<head$1>\n    <script src="/__preview/demo-mock.js"></script>`);

    const send = (res, status, body, type) => { res.writeHead(status, { "Content-Type": type || "text/plain", "Cache-Control": "no-store" }); res.end(body); };
    const file = (res, path) => { try { send(res, 200, readFileSync(path), TYPES[extname(path)] || "application/octet-stream"); } catch { send(res, 404, "not found"); } };

    const server = createServer((req, res) => {
        const url = (req.url || "/").split("?")[0];
        if (url === "/" || url === "/index.html") return send(res, 200, injectMock(readFileSync(join(ASSETS, "index.html"), "utf8")), TYPES[".html"]);
        if (url === "/__preview/demo-mock.js") return file(res, MOCK);
        if (url === "/lib/chart.min.js") return file(res, join(ASSETS, "lib", "chart.min.js"));
        // Any /api/* request only reaches the network if the shim missed one - report it loudly
        // instead of hanging, so a new endpoint that needs a mock is obvious.
        if (url.startsWith("/api/")) { console.warn("unmocked API call:", url); return send(res, 200, "{}", TYPES[".json"]); }
        return send(res, 404, "not found");
    });
    server.listen(port, "127.0.0.1", () => {
        const target = `http://localhost:${port}`;
        console.log(`Dashboard preview (mock data) -> ${target}`);
        console.log("Mock data only - nothing is read from ~/.enigma. Use --real for live data. Ctrl+C to stop.");
        if (!has("--no-open")) {
            const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
            // The error listener is required: a missing opener surfaces as an async
            // `error` event, which an EventEmitter with no listener would rethrow.
            try {
                const child = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true });
                child.on("error", () => { /* user opens it manually */ });
                child.unref();
            } catch { /* user opens it manually */ }
        }
    });
}
