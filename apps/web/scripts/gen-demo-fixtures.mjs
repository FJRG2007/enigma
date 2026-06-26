/*
 * Generates the demo dashboard's Settings and Usage fixtures from the REAL enigma-cli code,
 * so the static demo matches the product exactly (same shapes, same defaults) instead of
 * hand-authored guesses. Run from the repo root with tsx whenever those shapes change:
 *
 *   npx tsx apps/web/scripts/gen-demo-fixtures.mjs
 *
 * Output (committed, read at build by sync-assets.mjs):
 *   apps/web/scripts/demo-settings.json  - serializeSettings("global") at default config
 *   apps/web/scripts/demo-usage.json     - buildUsage() over synthetic Claude transcripts
 *
 * All inputs are synthetic and written to a throwaway HOME; no real user data is read.
 */
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

// Isolate everything the enigma code reads to a throwaway HOME (set BEFORE importing the
// modules, which resolve these lazily). Defaults apply -> a clean first-install view.
const HOME = mkdtempSync(join(tmpdir(), "enigma-demo-fixtures-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CLAUDE_PROJECTS = join(HOME, ".claude", "projects");
process.env.ENIGMA_PROXY_DIR = join(HOME, ".enigma", "proxy");

const MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
const PROJECTS = ["enigma", "web-app", "infra-scripts"];
const DAY = 86400000;
const now = Date.now();
let idN = 0;

function assistant(tsMs, model, u) {
    return JSON.stringify({
        type: "assistant", timestamp: new Date(tsMs).toISOString(),
        message: { id: `msg_${++idN}`, model, role: "assistant", usage: u }
    });
}
// Deterministic-but-varied token counts (no Math.random so reruns are stable).
function usageFor(d, k) {
    const inp = 400 + ((d * 13 + k * 37) % 30) * 220;
    const out = 120 + ((d * 7 + k * 11) % 20) * 60;
    const cacheRead = 2000 + ((d * 5 + k * 23) % 40) * 900;
    const cacheCreation = ((d + k) % 4 === 0) ? 800 + (d % 6) * 150 : 0;
    return { input_tokens: inp, output_tokens: out, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation };
}

/** Write a spread of session transcripts under a projects root for one account. */
function seedAccount(projectsRoot, days, projects) {
    for (let d = days - 1; d >= 0; d--) {
        // The most recent day's messages land in the last ~2h so the 5-hour block is active.
        const base = d === 0 ? now - 90 * 60 * 1000 : now - d * DAY - 11 * 3600000;
        const proj = projects[d % projects.length];
        const dir = join(projectsRoot, proj);
        mkdirSync(dir, { recursive: true });
        const msgs = 2 + (d % 3);
        const lines = [];
        for (let k = 0; k < msgs; k++) {
            lines.push(assistant(base + k * 4 * 60 * 1000, MODELS[(d + k) % MODELS.length], usageFor(d, k)));
        }
        writeFileSync(join(dir, `session-${d}.jsonl`), `${lines.join("\n")}\n`);
    }
}

// Default login: 30 days of activity. A second managed account so "By Account" has >1 row.
seedAccount(process.env.ENIGMA_CLAUDE_PROJECTS, 30, PROJECTS);
seedAccount(join(HOME, ".enigma", "claude", "work", "projects"), 12, ["client-x", "client-y"]);

const importTs = (rel) => import(pathToFileURL(join(repo, rel)).href);
const { buildUsage } = await importTs("packages/enigma-cli/src/usage.ts");
const { serializeSettings } = await importTs("packages/enigma-cli/src/dashboard-settings.ts");

const usage = buildUsage();
const settings = serializeSettings("global");

// The registry is read at a clean HOME, so a few values reflect the PRE-enigma state instead
// of what enigma actually applies. Override them to the real enigma defaults / a representative
// demo state (the install-time effects the generator does not run):
//  - claude-attribution / claude-survey: enigma turns these OFF at install (privacy defaults).
//  - bypass-*: permission-bypass is on by default, so every supported agent is bypassed.
//  - dashboard: show it running ("always") so the preview demonstrates the live dashboard.
const DEMO_OVERRIDES = {
    "claude-attribution": { value: false },
    "claude-survey": { value: false },
    "bypass-claude": { value: true },
    "bypass-codex": { value: true },
    "bypass-opencode": { value: true },
    "dashboard": { value: true, choice: "always" },
};
for (const cat of settings) {
    for (const s of cat.settings) {
        if (DEMO_OVERRIDES[s.key]) Object.assign(s, DEMO_OVERRIDES[s.key]);
    }
}

writeFileSync(join(here, "demo-usage.json"), JSON.stringify(usage));
writeFileSync(join(here, "demo-settings.json"), JSON.stringify(settings));

rmSync(HOME, { recursive: true, force: true });
console.log(`Wrote demo-settings.json (${settings.length} categories) and demo-usage.json (${usage.sessions} sessions, ${usage.messages} messages).`);
process.exit(0);
