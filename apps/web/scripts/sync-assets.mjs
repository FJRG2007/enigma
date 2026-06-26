// Mirror the repo's shared brand assets into public/ so Astro serves them, instead of
// duplicating the binaries inside the web app. Single source of truth: <repo>/assets and
// the @enigmax/dashboard package. Runs as predev/prebuild; the copied files are gitignored.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));   // apps/web/scripts
const repo = join(here, "..", "..", "..");              // repo root
const pub = join(here, "..", "public");                 // apps/web/public

mkdirSync(join(pub, "logos"), { recursive: true });
cpSync(join(repo, "assets", "logos"), join(pub, "logos"), { recursive: true });
cpSync(join(repo, "assets", "images", "dashboard.png"), join(pub, "dashboard.png"));

// Live demo: serve the REAL dashboard UI (no fork) with a mock data layer so it renders
// offline. We copy packages/dashboard/assets/{index.html,lib/chart.min.js} verbatim, then
// inject the fetch mock + a "static demo" banner. The dashboard stays the single source of
// truth; only this thin adapter (mock + banner + relative chart path) is added at build.
const dashAssets = join(repo, "packages", "dashboard", "assets");
const demoOut = join(pub, "demo");
mkdirSync(join(demoOut, "lib"), { recursive: true });
cpSync(join(dashAssets, "lib", "chart.min.js"), join(demoOut, "lib", "chart.min.js"));
cpSync(join(here, "demo-mock.js"), join(demoOut, "demo-mock.js"));

const BANNER_STYLE = "<style>.demo-banner{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:linear-gradient(135deg,var(--accent-weak),transparent 70%),var(--surface);border:1px solid rgba(224,164,88,.35);border-radius:var(--radius);padding:12px 16px;margin-bottom:22px;box-shadow:var(--shadow-1)}.demo-banner .demo-pill{font-family:var(--mono);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#1a1206;background:var(--accent);border-radius:999px;padding:3px 10px}.demo-banner .demo-msg{color:var(--muted);font-size:13px;flex:1;min-width:220px}.demo-banner .demo-links{display:flex;gap:8px;flex-wrap:wrap}.demo-banner .demo-links a{font-family:var(--mono);font-size:12px;color:var(--text);background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:7px 13px;text-decoration:none}.demo-banner .demo-links a.primary{color:#1a1206;background:var(--accent);border-color:var(--accent);font-weight:600}</style>";
const BANNER = '<div class="demo-banner"><span class="demo-pill">Static demo</span><span class="demo-msg">Mock data - nothing here is live. Install enigma and run <code>enigma dash</code> for the real, interactive control panel.</span><span class="demo-links"><a href="/enigma/">Back to site</a><a class="primary" href="/enigma/#install">Install Enigma</a></span></div>';

let html = readFileSync(join(dashAssets, "index.html"), "utf8");
// The mock must patch fetch before any dashboard script runs -> first child of <head>.
html = html.replace("<head>", `<head>\n    <script src="demo-mock.js"></script>\n    ${BANNER_STYLE}`);
// Chart lib is referenced as an absolute root path; rewrite it relative to /enigma/demo/.
html = html.replace('src="/lib/chart.min.js"', 'src="lib/chart.min.js"');
// Surface the "this is a demo" banner at the top of the page body.
html = html.replace("<body>", `<body>\n    ${BANNER}`);
writeFileSync(join(demoOut, "index.html"), html);

console.log("Synced logos/, dashboard.png and the demo dashboard into public/.");
