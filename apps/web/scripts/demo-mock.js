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
            compress: true, codeGraph: true, outputStyle: "full", minimalCode: "full", parallelSubagents: false,
            autoLint: true, usageStats: !!FX.usage, dashboard: "always", commitEmoji: true,
            proxy: false, usageApi: false, promptSecretGuard: false, promptSecretMode: "redact", live: true,
            proxyStats: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, lastRequestAt: 0, redacted: 0, rejected: 0, lastBlockedAt: 0 },
            security: { permissionBypass: true, bypassDisabled: [], guardProtects: ["Block committed secrets", "Block .env files", "Block dependency/cache dirs", "Warn on generated dirs", "Warn on log / OS junk files", "Warn on files over 5 MB"] },
            skills: { total: 17, enigma: 15, external: 2, disabled: 0 },
            tools: [
                { name: "claude", label: "Claude Code", status: "ok" },
                { name: "codex", label: "Codex", status: "ok" },
                { name: "opencode", label: "opencode", status: "ok" }
            ],
            api: { port: 8000, agents: ["claude", "codex", "opencode"] }
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
                    setting("dashboard", "Dashboard", "Off, on-demand, or a background daemon.", { choices: ["off", "on-demand", "always"], choice: "always", globalOnly: true }),
                    setting("compress", "Context compression", "Register the compression MCP in your agents.", { value: true, globalOnly: true }),
                    setting("usage-stats", "Real tool-usage stats", "Read your own Claude Code transcripts (opt-in).", { value: false, globalOnly: true })
                ]
            }
        ]
    };

    var ACCOUNTS = {
        tools: [{ name: "claude", label: "Claude Code" }, { name: "codex", label: "Codex" }, { name: "opencode", label: "opencode" }],
        accounts: [
            { tool: "claude", toolLabel: "Claude Code", name: "default", dir: "~/.claude", email: "you@example.com", active: true, removable: false, loggedIn: true, loginState: "ok", supportsProvider: true, provider: null },
            { tool: "claude", toolLabel: "Claude Code", name: "work", dir: "~/.enigma/claude/work", email: "work@company.com", active: false, removable: true, loggedIn: false, loginState: "empty", supportsProvider: true, provider: null },
            { tool: "claude", toolLabel: "Claude Code", name: "minimax", dir: "~/.enigma/claude/minimax", email: "", active: false, removable: true, loggedIn: false, loginState: "absent", supportsProvider: true, provider: { baseUrl: "https://api.minimax.io/anthropic", model: "MiniMax-M3[1m]", preset: "minimax", hasToken: true } },
            { tool: "codex", toolLabel: "Codex", name: "default", dir: "~/.codex", email: "", active: true, removable: false, loggedIn: false, supportsProvider: false, provider: null },
            { tool: "opencode", toolLabel: "opencode", name: "default", dir: "~/.config/opencode", email: "", active: true, removable: false, loggedIn: false, supportsProvider: false, provider: null }
        ],
        profiles: [
            { name: "daily", active: true, accounts: { claude: "default" } },
            { name: "client-x", active: false, accounts: { claude: "work" } }
        ],
        presets: [
            { id: "minimax", label: "MiniMax (International)", tool: "claude", baseUrl: "https://api.minimax.io/anthropic", model: "MiniMax-M3[1m]", tokenUrl: "https://platform.minimax.io/user-center/payment/token-plan" },
            { id: "minimax-cn", label: "MiniMax (China)", tool: "claude", baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3[1m]", tokenUrl: "https://platform.minimaxi.com/user-center/payment/token-plan" }
        ],
        sessionSources: [
            { id: "account:default", kind: "account", tool: "claude", label: "default", email: "you@example.com", state: "ok", usable: true },
            { id: "account:work", kind: "account", tool: "claude", label: "work", email: "work@company.com", state: "empty", usable: false },
            { id: "pack:helio", kind: "pack", tool: "claude", label: "pack: Helio", email: "you@example.com", state: "ok", usable: true }
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

    var PACKS = [
        {
            id: "helio", label: "Helio",
            description: "Bug-bounty and offensive-security harness: recon, vuln hunting, web2/web3 audit, AD, cloud, triage and report writing. Runs in an isolated agent context so it never loads into your normal coding agent.",
            tags: ["bug-bounty", "security", "pentest", "web3"], homepage: "https://www.npmjs.com/package/@enigmax/helio",
            installed: true, enabled: true, version: "0.1.0",
            tool: "claude", defaultAccount: null, resolvedAccount: "default", resolvedState: "ok", contextReady: true,
            accounts: [{ name: "default", label: "you@example.com", state: "ok" }, { name: "work", label: "pentest@acme.com", state: "ok" }]
        }
    ];

    var SSH = [
        { alias: "server1", host: "203.0.113.10", user: "root", port: 22, identityFile: "~/.ssh/id_ed25519", hasPassword: false, target: "root@203.0.113.10", forwardLabels: ["pg: local 9090 -> localhost:5432"], forwards: [{ type: "local", bind: "9090", host: "localhost", hostPort: 5432, name: "pg" }] },
        { alias: "db", host: "db.internal", user: "deploy", proxyJump: "root@203.0.113.10", hasPassword: true, target: "deploy@db.internal", forwardLabels: [], forwards: [] }
    ];

    var RECALL = {
        available: true, enabled: true,
        stats: { observations: 128, summaries: 22, sessions: 22, projects: 3, byType: { change: 41, discovery: 33, feature: 28, bugfix: 14, refactor: 8, decision: 3, security: 1 }, dbBytes: 196608, lastObservationAt: Date.now() },
        lastSync: Date.now() - 3600000,
        projects: ["enigma", "ai-gateway", "cerberus"],
        provider: { provider: "claude-local", model: "", base: "", hasKey: false, keyFromEnv: false, llm: true, providers: ["claude-local", "anthropic", "openai"] },
        query: "",
        items: [
            { id: 128, type: "feature", title: "Add recall session-memory store", project: "enigma", source: "claude", files: ["src/recall/db.ts", "src/recall/store.ts"], filesRead: ["src/usage.ts"], facts: ["Modified 2 files", "Added FTS5 + vectors"], concepts: ["recall", "sqlite"], narrative: "Wired a bun:sqlite + FTS5 store with a native vector half for hybrid search.", createdAt: Date.now() - 3600000 },
            { id: 127, type: "bugfix", title: "Fix token refresh in auth flow", project: "ai-gateway", source: "codex", files: ["src/auth.ts"], filesRead: [], facts: ["root cause: TTL was 0"], concepts: ["auth"], narrative: "The token TTL was zero so sessions expired instantly.", createdAt: Date.now() - 7200000 },
            { id: 126, type: "discovery", title: "Map the transcript extraction pipeline", project: "enigma", source: "opencode", files: [], filesRead: ["src/recall/extract.ts"], facts: [], concepts: ["extraction"], narrative: "Observations are derived per user turn.", createdAt: Date.now() - 9000000 }
        ]
    };

    var CODEGRAPH = {
        enabled: true, available: true,
        projects: [
            { id: "a1b2c3d4e5f6", name: "enigma", root: "/home/you/dev/enigma", indexedAt: now - 3600000, files: 214, symbols: 3312 },
            { id: "f6e5d4c3b2a1", name: "ai-gateway", root: "/home/you/dev/ai-gateway", indexedAt: now - 86400000, files: 96, symbols: 1408 }
        ],
        selected: "enigma",
        architecture: {
            project: "enigma", files: 214, symbols: 3312, importEdges: 1204,
            languages: { ts: 188, js: 14, python: 3, c: 9 },
            entryPoints: ["src/bin/enigma.ts", "src/mcp.ts", "src/cli.ts"],
            hotspots: [{ name: "readConfig", refs: 61 }, { name: "resolveBin", refs: 34 }, { name: "syncTarget", refs: 22 }],
            packages: { src: 176, tests: 30, scripts: 8 },
            externalModules: [{ name: "node:fs", count: 84 }, { name: "node:path", count: 71 }, { name: "node:os", count: 40 }]
        },
        schema: { nodes: { File: 214, Function: 2841, Class: 214, Interface: 187, Type: 70 }, edges: { IMPORTS: 1204, REFERENCES: 5220 } }
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

    // Per-project scope demo. Projects live in memory so add/remove/toggle behave within a
    // session (a reload restores these defaults). The detail view derives project config from
    // the same SETTINGS registry subset the real server exposes, and skills from SKILLS.
    var PROJECT_CFG_KEYS = ["gate", "auto-sync", "compress", "output-style", "minimal-code", "parallel-subagents", "skill-update-policy"];
    var PROJECTS = [
        { path: "/home/you/api-server", label: "api-server", description: "REST API + workers", exists: true, isGitRepo: true, hooks: true, gate: false, skillsOn: ["git-policy", "backend-policy", "security-policy"], cfg: { gate: true } },
        { path: "/home/you/web-app", label: "web-app", description: "", exists: true, isGitRepo: true, hooks: false, gate: true, skillsOn: ["frontend-policy", "ciphera-style-policy"], cfg: {} }
    ];
    function projFind(p) { return PROJECTS.filter(function (x) { return x.path === p; })[0]; }
    function projStatus(x) {
        return { path: x.path, label: x.label, description: x.description || undefined, exists: x.exists !== false, isGitRepo: !!x.isGitRepo, skills: (x.skillsOn || []).length, hasLocalConfig: !!(x.cfg && Object.keys(x.cfg).length), hooks: !!x.hooks, gate: !!x.gate };
    }
    function projList() { return { projects: PROJECTS.map(projStatus) }; }
    function projDetail(x) {
        x.cfg = x.cfg || {};
        var config = PROJECT_CFG_KEYS.map(function (k) {
            var s = findSetting(k); if (!s) return null;
            var has = Object.prototype.hasOwnProperty.call(x.cfg, k);
            var val = has ? x.cfg[k] : (s.choices ? s.choice : s.value);
            return {
                key: k, label: s.label, hint: s.hint, choices: s.choices || undefined, offChoice: s.choices ? s.offChoice : undefined,
                value: s.choices ? String(val) !== s.offChoice : !!val, choice: s.choices ? String(val) : undefined, overridden: has
            };
        }).filter(Boolean);
        var available = SKILLS.skills.map(function (s) { return { name: s.name, description: s.description }; });
        var agents = [
            { name: "claude", label: "Claude Code", installed: true, deployed: (x.skillsOn || []).slice() },
            { name: "codex", label: "Codex", installed: false, deployed: [] },
            { name: "opencode", label: "OpenCode", installed: false, deployed: [] }
        ];
        var st = projStatus(x);
        st.agents = agents; st.available = available; st.config = config;
        return st;
    }
    function projBase(p) { return String(p || "").trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || ""; }
    // Mirrors the server's checkProject. The static demo has no filesystem, so an absolute path
    // is assumed to exist; the real dashboard verifies the folder on disk.
    function projCheck(path, name, exceptPath) {
        var raw = String(path || "").trim(), pathError = null, nameError = null;
        if (exceptPath === undefined) {
            if (!raw) pathError = "Enter a path.";
            else if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(raw)) pathError = "Enter an absolute path (e.g. /home/you/app or C:\\path).";
            else if (PROJECTS.some(function (p) { return p.path === raw; })) pathError = "This folder is already an enigma project.";
        }
        var nm = String(name || "").trim();
        if (!nm) nameError = "Enter a name.";
        else if (PROJECTS.some(function (p) { return p.path !== exceptPath && p.label.toLowerCase() === nm.toLowerCase(); })) nameError = "A project with this name already exists.";
        return { pathError: pathError, nameError: nameError };
    }
    function applyProjectsPost(body) {
        if (body.op === "validate") { var c = projCheck(body.path, body.name || ""); return { ok: true, pathError: c.pathError, nameError: c.nameError }; }
        if (body.op === "add") {
            var nm = String(body.name || "").trim() || projBase(body.path);
            var v = projCheck(body.path, nm);
            if (v.pathError || v.nameError) return { ok: false, error: v.pathError || v.nameError, projects: projList().projects };
            PROJECTS.push({ path: String(body.path).trim(), label: nm, description: String(body.description || "").trim() || undefined, exists: true, isGitRepo: true, hooks: false, gate: false, skillsOn: [], cfg: {} });
            return { ok: true, projects: projList().projects };
        }
        if (body.op === "update") {
            var x = projFind(body.path); if (!x) return { ok: false, error: "Project is not registered.", projects: projList().projects };
            if (body.name !== undefined) {
                var nv = projCheck(body.path, body.name, body.path);
                if (nv.nameError) return { ok: false, error: nv.nameError, projects: projList().projects };
                x.label = String(body.name).trim();
            }
            if (body.description !== undefined) x.description = String(body.description).trim() || undefined;
            return { ok: true, projects: projList().projects };
        }
        if (body.op === "remove") { PROJECTS = PROJECTS.filter(function (x) { return x.path !== body.path; }); return { ok: true, projects: projList().projects }; }
        return { ok: false, error: "unknown op", projects: projList().projects };
    }
    function applyProjectActionPost(body) {
        var x = projFind(body.path); if (!x) return { ok: false, error: "Project is not registered." };
        x.cfg = x.cfg || {}; x.skillsOn = x.skillsOn || [];
        var note;
        if (body.op === "config-set") x.cfg[body.key] = body.value;
        else if (body.op === "config-unset") delete x.cfg[body.key];
        else if (body.op === "skill") { if (body.on) { if (x.skillsOn.indexOf(body.name) === -1) x.skillsOn.push(body.name); } else x.skillsOn = x.skillsOn.filter(function (n) { return n !== body.name; }); }
        else if (body.op === "autoskills-detect") {
            return {
                ok: true, detected: "React, Next.js, Prisma, Tailwind CSS",
                skills: [
                    { ref: "midudev/skills/react", name: "react", sources: ["React"] },
                    { ref: "midudev/skills/nextjs", name: "nextjs", sources: ["Next.js"] },
                    { ref: "midudev/skills/prisma", name: "prisma", sources: ["Prisma"] },
                    { ref: "midudev/skills/tailwindcss", name: "tailwindcss", sources: ["Tailwind CSS", "Frontend"] }
                ]
            };
        }
        else if (body.op === "autoskills-install") { note = `Demo - would install ${(body.skills || []).length} community skill(s) (nothing written).`; }
        else if (body.op === "hooks") { x.hooks = true; note = "Demo - git hooks marked installed."; }
        else if (body.op === "gate") { x.gate = body.gateOp !== "eject"; note = `Demo - gate ${x.gate ? "initialized" : "ejected"}.`; }
        return { ok: true, note: note, detail: projDetail(x) };
    }
    function qparam(path, key) { var m = path.match(new RegExp(`[?&]${key}=([^&]+)`)); return m ? decodeURIComponent(m[1]) : ""; }

    // Agent memory editor (CLAUDE.md / AGENTS.md): the same demo groups for global and project.
    var MEMORY_GROUPS = [
        { id: "claude", file: "CLAUDE.md", agents: [{ name: "claude", label: "Claude Code" }], deployed: true, edited: false, managed: true },
        { id: "codex", file: "AGENTS.md", agents: [{ name: "codex", label: "Codex" }, { name: "opencode", label: "OpenCode" }], deployed: true, edited: false, managed: true }
    ];
    var MEMORY_CONTENT = "# Engineering memory (demo)\n\nMock content for the static demo. The real dashboard reads and writes your agents' CLAUDE.md / AGENTS.md here, and your edits follow the overwrite/keep policy on the next sync.\n";
    function applyMemoryPost(body) {
        if (body.action === "read") return { ok: true, content: MEMORY_CONTENT };
        if (body.action === "save") return { ok: true, note: "Demo - not saved.", groups: MEMORY_GROUPS };
        if (body.action === "reset") return { ok: true, note: "Demo - not changed.", groups: MEMORY_GROUPS };
        return { ok: false, error: "unknown action" };
    }

    function route(path, method, body) {
        if (path.indexOf("/api/stats") !== -1) { STATS.generatedAt = Date.now(); return STATS; }
        // Provider status pill: report everything operational (the real server proxies the
        // upstream statuspage; here it is mocked so the preview always reads green/offline).
        if (path.indexOf("/api/provider-status") !== -1) return { indicator: "none", description: "All Systems Operational" };
        if (path.indexOf("/api/status") !== -1) return STATUS;
        if (path.indexOf("/api/settings") !== -1) return method === "POST" ? applySettingPost(body) : SETTINGS;
        if (path.indexOf("/api/accounts") !== -1) {
            if (method !== "POST") return ACCOUNTS;
            if (body && body.op === "account.login") return { ok: true, note: "Demo - this would open a terminal to log in.", data: ACCOUNTS };
            return { ok: true, data: ACCOUNTS };
        }
        if (path.indexOf("/api/skills") !== -1) return method === "POST" ? applySkillPost(body) : SKILLS;
        if (path.indexOf("/api/memory") !== -1) return method === "POST" ? applyMemoryPost(body) : { groups: MEMORY_GROUPS, project: qparam(path, "path") || null };
        if (path.indexOf("/api/projects/detail") !== -1) { var pd = projFind(qparam(path, "path")); return pd ? projDetail(pd) : { error: "Project is not registered." }; }
        if (path.indexOf("/api/projects/action") !== -1) return applyProjectActionPost(body);
        if (path.indexOf("/api/projects") !== -1) return method === "POST" ? applyProjectsPost(body) : projList();
        if (path.indexOf("/api/resources") !== -1) return method === "POST" ? { ok: true, message: "Demo - no action taken.", status: RESOURCES } : RESOURCES;
        if (path.indexOf("/api/recall") !== -1) {
            if (method !== "POST" && path.indexOf("timeline=") !== -1) return { items: RECALL.items };
            return method === "POST" ? { ok: true, view: RECALL } : RECALL;
        }
        if (path.indexOf("/api/codegraph") !== -1) {
            if (method === "POST") {
                if (body && body.op === "toggle" && typeof body.on === "boolean") CODEGRAPH.enabled = body.on;
                if (body && body.op === "index") return { ok: true, note: "Demo - indexing is disabled in the preview.", view: CODEGRAPH };
                return { ok: true, view: CODEGRAPH };
            }
            return CODEGRAPH;
        }
        if (path.indexOf("/api/playground") !== -1) {
            if (method !== "POST") return { agents: ["claude", "codex", "opencode"], models: [{ tool: "claude", models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"] }, { tool: "codex", models: ["codex"] }, { tool: "opencode", models: ["opencode"] }], accounts: [{ tool: "claude", name: "default" }, { tool: "claude", name: "work" }], profiles: ["work"], packs: [{ id: "helio", label: "Helio", installed: true }], apiPort: 8000, defaults: { account: "", profile: "", pack: "" } };
            var pg = body || {};
            if (pg.op === "set-defaults") return { ok: true, defaults: { account: pg.account || "", profile: pg.profile || "", pack: pg.pack || "" } };
            var anth = pg.format === "anthropic";
            var demoText = "playground-ok (demo response - run the dashboard via the enigma app to drive a real agent)";
            var resp = anth
                ? { id: "msg_demo", type: "message", role: "assistant", model: pg.model || "claude", content: [{ type: "text", text: demoText }], stop_reason: "end_turn", usage: { input_tokens: 8, output_tokens: 14 } }
                : { id: "chatcmpl-demo", object: "chat.completion", model: pg.model || "claude", choices: [{ index: 0, message: { role: "assistant", content: demoText }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 14, total_tokens: 22 } };
            var curlPath = anth ? "/v1/messages" : "/v1/chat/completions";
            return { ok: true, mode: pg.mode || "inproc", format: pg.format || "openai", tool: "claude", text: demoText, response: resp, usage: { input: 8, output: 14 }, curl: `curl http://127.0.0.1:8000${curlPath} \\\n  -H 'Content-Type: application/json' \\\n  -d '...'` };
        }
        if (path.indexOf("/api/packs") !== -1) {
            if (method !== "POST") return { packs: PACKS };
            var pb = body || {};
            if (pb.action === "launch") return { ok: true, command: `enigma ${pb.id || "helio"}`, note: "Run this in a terminal to launch the isolated agent." };
            if (pb.action === "set-account") { PACKS[0].defaultAccount = pb.value || null; PACKS[0].resolvedAccount = pb.value || "default"; return { ok: true, note: "Demo - account preference saved.", packs: PACKS }; }
            return { ok: true, note: "Demo - no action taken.", packs: PACKS };
        }
        if (path.indexOf("/api/ssh") !== -1) {
            if (method !== "POST") return { connections: SSH };
            var sb = body || {};
            if (sb.action === "connect") return { ok: true, command: `enigma ssh ${sb.alias || "server1"}`, note: "Run this in a terminal to connect." };
            if (sb.action === "tunnel") return { ok: true, command: `enigma ssh tunnel ${sb.alias || "server1"}`, note: "Run this in a terminal to open the tunnel." };
            return { ok: true, note: "Demo - no change made.", connections: SSH };
        }
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
        try { var u = new URL(url, location.href); path = u.pathname + u.search; } catch (e) { /* keep raw */ }
        var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
        if (path.indexOf("/api/") !== -1) {
            var body = null;
            if (init && typeof init.body === "string") { try { body = JSON.parse(init.body); } catch (e) { /* ignore */ } }
            return Promise.resolve(json(route(path, method, body)));
        }
        // Outbound calls the dashboard makes: stub them so the preview never depends on the
        // network. Statuspages report operational (direct-fetch fallback for the pill); the
        // version/incident checks return nothing so they degrade quietly.
        if (/statuspage|status\.|\/api\/v2\/status/i.test(url)) {
            return Promise.resolve(json({ status: { indicator: "none", description: "All Systems Operational" } }));
        }
        if (/githubusercontent|api\.github/i.test(url)) {
            return Promise.resolve(json({}));
        }
        return realFetch ? realFetch(input, init) : Promise.resolve(json({}));
    };

    // --- Usage view: synthesize Codex/OpenCode data for the preview --------------------------
    // The real dashboard only reads Claude Code transcripts, so it honestly shows an "unavailable"
    // panel for the other providers. In this static demo everything is mock, so we feed each
    // provider a scaled copy of the Claude report through the dashboard's own render path (it is a
    // classic script - its top-level functions/lets share this realm's globals and are writable).
    function installUsageProviderDemo() {
        if (typeof window.applyUsageView !== "function") return;
        var orig = window.applyUsageView;
        var FACTOR = { codex: 0.43, opencode: 0.71 };
        var PROVIDER_MODELS = {
            codex: ["gpt-5-codex", "gpt-5", "o4-mini"],
            opencode: ["claude-sonnet-4-6", "gpt-5", "qwen2.5-coder:32b"]
        };
        // Keys that are timestamps or non-token attributes and must survive scaling untouched.
        var TIME_KEYS = { resetsAt: 1, startedAt: 1, endsAt: 1, lastActive: 1, generatedAt: 1, t: 1, at: 1 };
        var KEEP_KEYS = { pct: 1, limit: 1, live: 1, active: 1, available: 1 };
        function scaleDeep(obj, f) {
            if (Array.isArray(obj)) return obj.map(function (x) { return scaleDeep(x, f); });
            if (obj && typeof obj === "object") {
                var o = {};
                for (var k in obj) {
                    var v = obj[k];
                    if (v && typeof v === "object") o[k] = scaleDeep(v, f);
                    else if (typeof v === "number" && !TIME_KEYS[k] && !KEEP_KEYS[k]) o[k] = /cost/i.test(k) ? +(v * f).toFixed(2) : Math.round(v * f);
                    else o[k] = v;
                }
                return o;
            }
            return obj;
        }
        // Rename the model keys, drop the Claude-specific weekly windows, and clear cross-account
        // bits that only make sense for the real Claude report.
        function relabel(r, models) {
            if (r.byModel) {
                var nm = {};
                Object.keys(r.byModel).forEach(function (k, i) { nm[models[i % models.length] || k] = r.byModel[k]; });
                r.byModel = nm;
            }
            (r.recentSessions || []).forEach(function (s, i) { if (s.model) s.model = models[i % models.length]; if (s.account) s.account = "default"; });
            if (r.windows) {
                var w = {};
                if (r.windows.session) { w.session = r.windows.session; w.session.live = false; }
                if (r.windows.weeklyAll) { w.weeklyAll = r.windows.weeklyAll; w.weeklyAll.live = false; }
                r.windows = w;
            }
            r.byAccount = null; r.accounts = null; r.pending = false;
            return r;
        }
        var cache = {};
        function providerUsage(prov) {
            // `usageData` is a top-level `let` in the dashboard script: a shared global-lexical
            // binding (not a window property), reachable here as a bare identifier.
            if (!usageData) return null;
            if (cache[prov] && cache[prov].base === usageData) return cache[prov].report;
            var report = relabel(scaleDeep(usageData, FACTOR[prov] || 0.5), PROVIDER_MODELS[prov] || ["model"]);
            cache[prov] = { base: usageData, report: report };
            return report;
        }
        window.applyUsageView = function () {
            var prov = usageProvider;
            if (prov === "claude") return orig();
            var data = providerUsage(prov);
            if (!data) return orig();
            // Render through the real claude path with the scaled report, then fix the header.
            var savedData = usageData;
            usageProvider = "claude"; usageData = data;
            try { orig(); } finally { usageProvider = prov; usageData = savedData; }
            var p = USAGE_PROVIDERS[prov] || USAGE_PROVIDERS.claude;
            document.getElementById("usageTitle").textContent = `${p.label} Usage`;
            var link = document.getElementById("usageViewLink");
            link.href = p.viewHref; link.textContent = `${p.viewLabel} ->`;
            document.getElementById("uAccountWrap").style.display = "none";
            document.getElementById("uByAccountWrap").style.display = "none";
            document.getElementById("uProviders").innerHTML = "";
            if (typeof providerDD !== "undefined" && providerDD) providerDD.render();
        };
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installUsageProviderDemo);
    else installUsageProviderDemo();
})();
