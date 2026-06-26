/*
 * Demo data layer for the public dashboard preview.
 *
 * The page served at /enigma/demo/ is the REAL dashboard UI (packages/dashboard/assets/
 * index.html, copied verbatim at build time - no fork). There is no enigma server behind
 * it, so this script overrides window.fetch to answer the dashboard's own /api/* calls with
 * static, internally-consistent mock data. Everything is synthetic; nothing is sent anywhere.
 *
 * It is injected as the first <script> in <head> so it patches fetch before any dashboard
 * script runs. External calls (GitHub version check, status pages) are stubbed empty so the
 * preview stays self-contained and offline.
 */
(function () {
    "use strict";
    var DAY = 86400000;
    var now = Date.now();
    // Real fixtures injected by the build (sync-assets.mjs): all skills from the catalog, the
    // full settings registry, and a real-shaped usage report. Absent in dev -> inline defaults.
    var FX = (typeof window !== "undefined" && window.__DEMO_FIXTURES__) || {};

    // Per-day savings history. Generated so the chart, "recent" and "history" panels all
    // have realistic, varied data without a giant literal. saved = before - after.
    var SRCS = ["claude-code", "opencode", "codex", "cli"];
    var TYPES = ["json", "log", "text", "diff", "code", "markdown"];
    var history = [];
    for (var d = 29; d >= 0; d--) {
        var pts = d % 3 === 0 ? 2 : 1;
        for (var k = 0; k < pts; k++) {
            var before = 8000 + ((d * 7 + k * 13) % 50) * 1800;
            var after = Math.round(before * (0.45 + ((d + k) % 5) * 0.03));
            history.push({ t: now - d * DAY - k * 3600000, b: before, a: after, s: SRCS[(d + k) % 4], c: TYPES[(d * 2 + k) % 6] });
        }
    }

    var STATS = {
        version: "1.21.0", generatedAt: now, boot: 1, ui: "0.1.39",
        priceOverride: 0, speedOverride: 0,
        stats: {
            calls: 1284, tokensBefore: 32700000, tokensAfter: 19300000, tokensSaved: 13400000, best: 214300,
            bySource: {
                "claude-code": { calls: 742, tokensBefore: 20100000, tokensAfter: 11500000, tokensSaved: 8600000 },
                "opencode": { calls: 318, tokensBefore: 7600000, tokensAfter: 4500000, tokensSaved: 3100000 },
                "codex": { calls: 156, tokensBefore: 3200000, tokensAfter: 2000000, tokensSaved: 1200000 },
                "cli": { calls: 68, tokensBefore: 1800000, tokensAfter: 1300000, tokensSaved: 500000 }
            },
            byType: {
                "json": { calls: 520, tokensBefore: 15000000, tokensAfter: 8800000, tokensSaved: 6200000 },
                "log": { calls: 410, tokensBefore: 9200000, tokensAfter: 5400000, tokensSaved: 3800000 },
                "text": { calls: 210, tokensBefore: 4600000, tokensAfter: 2700000, tokensSaved: 1900000 },
                "diff": { calls: 90, tokensBefore: 2200000, tokensAfter: 1300000, tokensSaved: 900000 },
                "code": { calls: 38, tokensBefore: 1100000, tokensAfter: 700000, tokensSaved: 400000 },
                "markdown": { calls: 16, tokensBefore: 600000, tokensAfter: 400000, tokensSaved: 200000 }
            }
        },
        usage: FX.usage || null,
        history: history,
        cache: { count: 487, bytes: 12865000, max: 500 }
    };

    var STATUS = {
        systems: {
            compress: true, outputStyle: "full", minimalCode: "full", parallelSubagents: false,
            autoLint: true, usageStats: !!FX.usage, dashboard: "on-demand", commitEmoji: true,
            proxy: false, usageApi: false, promptSecretGuard: false, promptSecretMode: "redact", live: true,
            proxyStats: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, lastRequestAt: 0, redacted: 0, rejected: 0, lastBlockedAt: 0 },
            security: { permissionBypass: true, bypassDisabled: [], guardProtects: ["API keys", ".pem files", ".env files", "node_modules"] },
            skills: { total: 17, enigma: 15, external: 2, disabled: 0 },
            tools: [
                { name: "claude", label: "Claude Code", status: "ok" },
                { name: "codex", label: "Codex", status: "ok" },
                { name: "opencode", label: "opencode", status: "ok" }
            ]
        }
    };

    function setting(key, label, hint, opts) {
        opts = opts || {};
        return {
            key: key, label: label, hint: hint, globalOnly: !!opts.globalOnly, affectsMemory: !!opts.affectsMemory,
            value: opts.choices ? opts.choice !== (opts.offChoice || "off") : !!opts.value,
            choices: opts.choices || null, choice: opts.choices ? opts.choice : null,
            offChoice: opts.offChoice || "off", kind: opts.kind || null,
            items: opts.kind === "list" ? (opts.items || []) : null,
            itemHint: opts.kind === "list" ? (opts.itemHint || null) : null
        };
    }
    var SETTINGS = FX.settings || {
        dashboardPort: 0, runningPort: 80,
        categories: [
            {
                title: "Behavior", blurb: "How the agent writes and reasons.", settings: [
                    setting("minimal-code", "Minimal code", "Laziest solution that works; opt out with off.", { choices: ["off", "lite", "full", "ultra"], choice: "full", affectsMemory: true }),
                    setting("output-style", "Token-efficient output", "Compress chat prose - lite, full or ultra.", { choices: ["off", "lite", "full", "ultra"], choice: "full", affectsMemory: true }),
                    setting("parallel-subagents", "Parallel subagents", "Let the agent fan work out to subagents.", { value: false, affectsMemory: true })
                ]
            },
            {
                title: "Skills", blurb: "Deployment and updates.", settings: [
                    setting("remote-skills", "Remote skill updates", "Pull newer skills from GitHub without an npm release.", { value: true, globalOnly: true }),
                    setting("auto-sync", "Auto-sync on launch", "Refresh skills and memory before launching a tool.", { value: true }),
                    setting("skill-update-policy", "On a local edit", "Overwrite edited skills on sync, or keep your edits.", { choices: ["overwrite", "keep"], choice: "overwrite" })
                ]
            },
            {
                title: "Privacy & security", blurb: "Defaults applied at install.", settings: [
                    setting("permission-bypass", "Skip approval prompts", "The agent acts without asking. A deliberate trade-off.", { value: true }),
                    setting("gh-telemetry", "GitHub CLI telemetry", "Off by default; nothing phones home.", { value: false, globalOnly: true }),
                    setting("prompt-secret-guard", "Prompt secret guard", "Scan outgoing prompts for secrets before they leave.", { value: false, globalOnly: true })
                ]
            },
            {
                title: "Local dashboard", blurb: "This control panel.", settings: [
                    setting("dashboard", "Dashboard", "Off, on-demand, or a background daemon.", { choices: ["off", "on-demand", "always"], choice: "on-demand", globalOnly: true }),
                    setting("compress", "Context compression", "Register the compression MCP in your agents.", { value: true, globalOnly: true }),
                    setting("usage-stats", "Real tool-usage stats", "Read your own Claude Code transcripts (opt-in).", { value: false, globalOnly: true })
                ]
            }
        ]
    };

    var ACCOUNTS = {
        tools: [{ name: "claude", label: "Claude Code" }, { name: "codex", label: "Codex" }, { name: "opencode", label: "opencode" }],
        accounts: [
            { tool: "claude", toolLabel: "Claude Code", name: "default", dir: "~/.claude", email: "you@example.com", active: true, removable: false, loggedIn: true },
            { tool: "claude", toolLabel: "Claude Code", name: "work", dir: "~/.enigma/claude/work", email: "work@company.com", active: false, removable: true, loggedIn: true },
            { tool: "codex", toolLabel: "Codex", name: "default", dir: "~/.codex", email: "", active: true, removable: false, loggedIn: false },
            { tool: "opencode", toolLabel: "opencode", name: "default", dir: "~/.config/opencode", email: "", active: true, removable: false, loggedIn: false }
        ],
        profiles: [
            { name: "daily", active: true, accounts: { claude: "default" } },
            { name: "client-x", active: false, accounts: { claude: "work" } }
        ]
    };

    function skill(name, description, version, source, agents) {
        return {
            name: name, description: description, version: version, source: source, discarded: false,
            update: "current", updated: new Date(now - 6 * DAY).toISOString().slice(0, 10),
            agents: agents, deployed: agents,
            agentStates: [
                { name: "claude", label: "Claude Code", deployed: true, off: false },
                { name: "codex", label: "Codex", deployed: true, off: false },
                { name: "opencode", label: "opencode", deployed: true, off: false }
            ]
        };
    }
    var ALL_AGENTS = ["Claude Code", "Codex", "opencode"];
    var SKILLS = {
        skills: FX.skills || [
            skill("core-engineering-policy", "Highest-authority engineering rules - priority hierarchy, architecture, reuse and the harness map.", "1.21.0", "enigma", ALL_AGENTS),
            skill("security-policy", "Application and AI-agent security - secrets, auth, OWASP, transport/crypto and tool-use safety.", "1.10.0", "enigma", ALL_AGENTS),
            skill("ciphera-style-policy", "Code style conventions - naming, quotes, imports, indentation and code-level anti-patterns.", "1.8.0", "enigma", ALL_AGENTS),
            skill("git-policy", "Commit, branch and pull request standards - conventional commits, atomic changes, PR quality.", "1.6.0", "enigma", ALL_AGENTS),
            skill("testing-policy", "Test strategy, coverage gates, deterministic tests and test-suite layout.", "1.4.0", "enigma", ALL_AGENTS),
            skill("frontend-design", "Distinctive, intentional visual design for new or reshaped UI.", "1.0.0", "external", ALL_AGENTS)
        ]
    };

    var RESOURCES = {
        platform: "win32", totalMem: 34359738368, freeMem: 9663676416,
        wslAvailable: true, vmmemRunning: true, dockerRunning: true,
        topProcesses: [
            { pid: 5120, name: "vmmemWSL", memKB: 4612000 },
            { pid: 8412, name: "Docker Desktop.exe", memKB: 1820000 },
            { pid: 2204, name: "node.exe", memKB: 612000 },
            { pid: 9988, name: "chrome.exe", memKB: 540000 }
        ],
        ports: [
            { port: 3000, pid: 2204, name: "node.exe", proto: "tcp" },
            { port: 5173, pid: 2204, name: "node.exe", proto: "tcp" },
            { port: 8080, pid: 8412, name: "com.docker.backend.exe", proto: "tcp" }
        ]
    };

    function json(obj, status) {
        return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
    }
    function findSetting(key) {
        for (var i = 0; i < SETTINGS.categories.length; i++) {
            var s = SETTINGS.categories[i].settings;
            for (var j = 0; j < s.length; j++) if (s[j].key === key) return s[j];
        }
        return null;
    }
    function applySettingPost(body) {
        var s = body && findSetting(body.key);
        if (!s) return { ok: false, error: `unknown setting: ${body && body.key}` };
        var v = body.value;
        if (v && typeof v === "object" && v.op) {
            s.items = s.items || [];
            if (v.op === "add" && v.item && s.items.indexOf(v.item) === -1) s.items.push(v.item);
            if (v.op === "remove") s.items = s.items.filter(function (x) { return x !== v.item; });
        } else if (s.choices) {
            s.choice = String(v); s.value = s.choice !== s.offChoice;
        } else {
            s.value = v === true || v === 1;
        }
        return { ok: true, key: s.key, setting: s };
    }

    // Skills tab: viewing is read-only and toggles reset on reload (no persistence) - the
    // user asked for "looks real, edits do nothing". Enable/disable and per-app toggles mutate
    // the in-memory list so the row re-renders; a page reload restores the originals.
    function applySkillPost(body) {
        var sk = body && SKILLS.skills.filter(function (x) { return x.name === body.name; })[0];
        var action = body && body.action;
        if (action === "read") {
            var text = `---\nname: ${body.name}\ndescription: ${(sk && sk.description) || ""}\n---\n\nThis is a static demo - the full SKILL.md lives in the repo and editing here does nothing.\n`;
            return { ok: true, content: text };
        }
        if (action === "save") return { ok: true, note: "Demo - edits are not saved." };
        if (!sk) return { ok: true, skills: SKILLS.skills };
        if (action === "disable") sk.discarded = true;
        if (action === "enable") sk.discarded = false;
        if (action === "agent-toggle" && body.content) {
            var a = (sk.agentStates || []).filter(function (x) { return x.name === body.content.agent; })[0];
            if (a) { a.off = !!body.content.off; a.deployed = !a.off; }
        }
        return { ok: true, skills: SKILLS.skills };
    }

    function route(path, method, body) {
        if (path.indexOf("/api/stats") !== -1) { STATS.generatedAt = Date.now(); return STATS; }
        if (path.indexOf("/api/status") !== -1) return STATUS;
        if (path.indexOf("/api/settings") !== -1) return method === "POST" ? applySettingPost(body) : SETTINGS;
        if (path.indexOf("/api/accounts") !== -1) return method === "POST" ? { ok: true, data: ACCOUNTS } : ACCOUNTS;
        if (path.indexOf("/api/skills") !== -1) return method === "POST" ? applySkillPost(body) : SKILLS;
        if (path.indexOf("/api/resources") !== -1) return method === "POST" ? { ok: true, message: "Demo - no action taken.", status: RESOURCES } : RESOURCES;
        if (path.indexOf("/api/update") !== -1) return { ok: true, changed: false, version: STATS.version, note: "This is a static demo." };
        if (path.indexOf("/api/fix-path") !== -1) return { ok: true, message: "Demo - nothing to fix." };
        if (path.indexOf("/api/plan") !== -1) return { ok: true };
        if (path.indexOf("/api/dashboard-port") !== -1) return { ok: true };
        if (path.indexOf("/api/config-export") !== -1) return { config: {}, guard: {}, accounts: [], profiles: [] };
        if (path.indexOf("/api/config-import") !== -1) return { ok: true };
        return { ok: true };
    }

    var realFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
    window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        var path = url;
        try { path = new URL(url, location.href).pathname; } catch (e) { /* keep raw */ }
        var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        if (path.indexOf("/api/") !== -1) {
            var body = null;
            if (init && typeof init.body === "string") { try { body = JSON.parse(init.body); } catch (e) { /* ignore */ } }
            return Promise.resolve(json(route(path, method, body)));
        }
        // Outbound calls the dashboard makes (version check, status pages): stub empty so the
        // preview never depends on the network. The UI tolerates these returning nothing.
        if (/githubusercontent|api\.github|statuspage|status\.|\/api\/v2\/status/i.test(url)) {
            return Promise.resolve(json({}));
        }
        return realFetch ? realFetch(input, init) : Promise.resolve(json({}));
    };
})();
