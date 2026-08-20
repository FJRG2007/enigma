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
            autoLint: true, guardrails: { on: true, rules: 6 }, verify: { on: true, command: "npm test" }, usageStats: !!FX.usage, dashboard: "always", commitEmoji: true,
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
        { alias: "server1", name: "web-prod", host: "203.0.113.10", user: "root", port: 22, identityFile: "~/.ssh/id_ed25519", hasPassword: false, target: "root@203.0.113.10", forwardLabels: ["pg: local 9090 -> localhost:5432"], forwards: [{ type: "local", bind: "9090", host: "localhost", hostPort: 5432, name: "pg" }] },
        { alias: "db", host: "db.internal", user: "deploy", proxyJump: "root@203.0.113.10", hasPassword: true, target: "deploy@db.internal", forwardLabels: [], forwards: [] }
    ];

    var TUNNELS = [
        { name: "pg", server: "server1", type: "local", bind: "9090", host: "localhost", hostPort: 5432, active: true, spec: "9090:localhost:5432", label: "pg: local 9090 -> localhost:5432", target: "root@203.0.113.10", missing: false },
        { name: "redis", server: "db", type: "local", bind: "6380", host: "localhost", hostPort: 6379, active: false, spec: "6380:localhost:6379", label: "redis: local 6380 -> localhost:6379", target: "deploy@db.internal", missing: false },
        { name: "socks", server: "server1", type: "dynamic", bind: "1080", active: false, spec: "D:1080", label: "socks: dynamic SOCKS on 1080", target: "root@203.0.113.10", missing: false }
    ];

    // Mirrors RESERVED_CONNECTION_KEYS in src/ssh.ts so the demo form rejects the same aliases
    // the real CLI would refuse.
    var SSH_RESERVED = {
        connection: ["add", "delete", "edit", "forward", "fwd", "info", "list", "ls", "remove", "rm", "show", "tunnel", "tunnels"]
    };

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
        schema: { nodes: { File: 214, Function: 2841, Class: 214, Interface: 187, Type: 70 }, edges: { IMPORTS: 1204, REFERENCES: 5220 } },
        freshness: { project: "enigma", root: "/home/you/dev/enigma", indexedAt: now - 3600000, drift: { changed: [], added: [], removed: [] }, stale: 0, truncated: false },
        ask: null
    };

    // A small, fixed slice of a plausible codebase so the demo's graph panel draws something
    // real-shaped: symbol nodes with cross-file wiring, plus the file/import view behind them.
    var CG_SYMBOLS = [
        ["src/config.ts#readConfig", "readConfig", "function", "src/config.ts", 42, 58, "function readConfig(): { config: EnigmaConfig; path: string }", 61],
        ["src/config.ts#writeConfig", "writeConfig", "function", "src/config.ts", 64, 91, "function writeConfig(next: EnigmaConfig): void", 18],
        ["src/config.ts#EnigmaConfig", "EnigmaConfig", "interface", "src/config.ts", 12, 38, "export interface EnigmaConfig", 44],
        ["src/util.ts#readJson", "readJson", "function", "src/util.ts", 20, 31, "function readJson<T>(path: string): T | null", 39],
        ["src/util.ts#isDir", "isDir", "function", "src/util.ts", 33, 36, "function isDir(path: string): boolean", 27],
        ["src/tool-launch.ts#resolveBin", "resolveBin", "function", "src/tool-launch.ts", 71, 96, "function resolveBin(tool: string): string | null", 34],
        ["src/agents.ts#installedAgents", "installedAgents", "function", "src/agents.ts", 55, 88, "function installedAgents(): Agent[]", 21],
        ["src/agents.ts#Agent", "Agent", "interface", "src/agents.ts", 14, 29, "export interface Agent", 25],
        ["src/skills.ts#syncTarget", "syncTarget", "function", "src/skills.ts", 210, 288, "function syncTarget(target: Target): SyncReport", 22],
        ["src/skills.ts#renderSkill", "renderSkill", "function", "src/skills.ts", 132, 186, "function renderSkill(skill: Skill, cfg: EnigmaConfig): string", 9],
        ["src/mcp.ts#toolList", "toolList", "function", "src/mcp.ts", 230, 244, "function toolList(): Tool[]", 7],
        ["src/cli.ts#run", "run", "function", "src/cli.ts", 2525, 2740, "async function run(argv: string[]): Promise<void>", 3],
        ["src/dashboard.ts#serveDashboard", "serveDashboard", "function", "src/dashboard.ts", 980, 1090, "function serveDashboard(opts: DashboardOptions): Server", 4],
        ["src/bin/enigma.ts#main", "main", "function", "src/bin/enigma.ts", 8, 21, "async function main(): Promise<void>", 0]
    ];
    var CG_EDGES = [
        ["src/config.ts#readConfig", "src/util.ts#readJson", "calls"],
        ["src/config.ts#readConfig", "src/config.ts#EnigmaConfig", "references"],
        ["src/config.ts#writeConfig", "src/config.ts#EnigmaConfig", "references"],
        ["src/config.ts#writeConfig", "src/util.ts#isDir", "calls"],
        ["src/tool-launch.ts#resolveBin", "src/config.ts#readConfig", "calls"],
        ["src/tool-launch.ts#resolveBin", "src/util.ts#isDir", "calls"],
        ["src/agents.ts#installedAgents", "src/tool-launch.ts#resolveBin", "calls"],
        ["src/agents.ts#installedAgents", "src/agents.ts#Agent", "references"],
        ["src/skills.ts#syncTarget", "src/config.ts#readConfig", "calls"],
        ["src/skills.ts#syncTarget", "src/skills.ts#renderSkill", "calls"],
        ["src/skills.ts#syncTarget", "src/agents.ts#installedAgents", "calls"],
        ["src/skills.ts#renderSkill", "src/config.ts#EnigmaConfig", "references"],
        ["src/mcp.ts#toolList", "src/config.ts#readConfig", "calls"],
        ["src/dashboard.ts#serveDashboard", "src/config.ts#readConfig", "calls"],
        ["src/dashboard.ts#serveDashboard", "src/util.ts#readJson", "calls"],
        ["src/cli.ts#run", "src/skills.ts#syncTarget", "calls"],
        ["src/cli.ts#run", "src/dashboard.ts#serveDashboard", "calls"],
        ["src/cli.ts#run", "src/mcp.ts#toolList", "calls"],
        ["src/cli.ts#run", "src/agents.ts#installedAgents", "calls"],
        ["src/bin/enigma.ts#main", "src/cli.ts#run", "calls"]
    ];
    var CG_FILES = ["src/config.ts", "src/util.ts", "src/tool-launch.ts", "src/agents.ts", "src/skills.ts", "src/mcp.ts", "src/cli.ts", "src/dashboard.ts", "src/bin/enigma.ts"];

    // The import view of the same fixture, deduped the way the engine dedupes its edges, so the
    // file scope has one edge list whichever way it is entered - overview or focused.
    var CG_FILE_EDGES = (function () {
        var out = [], seen = {};
        for (var i = 0; i < CG_EDGES.length; i++) {
            var from = CG_EDGES[i][0].split("#")[0], to = CG_EDGES[i][1].split("#")[0], key = `${from}>${to}`;
            if (from === to || seen[key]) continue;
            seen[key] = 1;
            out.push({ source: from, target: to, relation: "imports" });
        }
        return out;
    })();

    /** Whole-fixture neighbour count per node id, over one edge list. */
    function cgDegrees(edges) {
        var deg = {};
        for (var i = 0; i < edges.length; i++) {
            var s = edges[i].source || edges[i][0], t = edges[i].target || edges[i][1];
            deg[s] = (deg[s] || 0) + 1;
            deg[t] = (deg[t] || 0) + 1;
        }
        return deg;
    }
    var CG_SYMBOL_DEG = cgDegrees(CG_EDGES);
    var CG_FILE_DEG = cgDegrees(CG_FILE_EDGES);

    /**
     * Fill the counts the panel draws its "+N" badge and Expand button from: `neighbours` is the
     * whole-graph total and `hidden` what this slice leaves out, so a merged picture can recount
     * the badge against what is actually on screen.
     */
    function cgCount(nodes, edges, degree) {
        var drawn = cgDegrees(edges);
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].neighbours = degree[nodes[i].id] || 0;
            nodes[i].hidden = Math.max(0, nodes[i].neighbours - (drawn[nodes[i].id] || 0));
        }
        return nodes;
    }
    function cgNode(row, depth) {
        return { id: row[0], name: row[1], kind: row[2], path: row[3], line: row[4], endLine: row[5], signature: row[6], inDegree: row[7], depth: depth, hidden: 0, neighbours: 0 };
    }
    function cgFileNode(path, depth, inDegree) {
        return { id: path, name: path.split("/").pop(), kind: "file", path: path, line: 1, endLine: 200, signature: "", inDegree: inDegree || 0, depth: depth, hidden: 0, neighbours: 0 };
    }
    function codeGraphSlice(body) {
        var b = body || {};
        var totals = { files: 214, symbols: 3312, edges: 6424, importEdges: 1204 };
        var base = { project: CODEGRAPH.selected || "enigma", root: "/home/you/dev/enigma", scope: b.scope === "files" ? "files" : "symbols", depth: b.depth || 1, focus: null, truncated: false, incomplete: false };
        var focus = (b.focus || "").trim().toLowerCase();
        var missing = function () {
            return Object.assign({}, base, { nodes: [], edges: [], totals: totals, focus: [], note: `No symbol or file named '${b.focus}' in the graph.` });
        };
        var counts = {};
        for (var i = 0; i < CG_FILE_EDGES.length; i++) counts[CG_FILE_EDGES[i].target] = (counts[CG_FILE_EDGES[i].target] || 0) + 1;
        // The scope decides the edge population whether or not there is a focus: a symbol slice
        // under a "files" label would make the scope control a no-op the moment a focus is typed.
        if (base.scope === "files") {
            var centre = null;
            if (focus) {
                for (var f = 0; f < CG_FILES.length && !centre; f++) if (CG_FILES[f].toLowerCase() === focus) centre = CG_FILES[f];
                for (var g = 0; g < CG_SYMBOLS.length && !centre; g++) {
                    var sym = CG_SYMBOLS[g];
                    if (sym[0].toLowerCase() === focus || sym[1].toLowerCase() === focus) centre = sym[3];
                }
                if (!centre) return missing();
            }
            var keepFiles = {};
            if (centre) {
                keepFiles[centre] = 0;
                for (var h = 0; h < CG_FILE_EDGES.length; h++) {
                    var fe = CG_FILE_EDGES[h];
                    if (fe.source === centre && keepFiles[fe.target] === undefined) keepFiles[fe.target] = 1;
                    if (fe.target === centre && keepFiles[fe.source] === undefined) keepFiles[fe.source] = 1;
                }
            } else {
                CG_FILES.forEach(function (path, idx) { keepFiles[path] = idx === 0 ? 0 : 1; });
            }
            var fileNodes = CG_FILES.filter(function (path) { return keepFiles[path] !== undefined; })
                .map(function (path) { return cgFileNode(path, keepFiles[path], counts[path]); });
            var fileEdges = CG_FILE_EDGES.filter(function (e) { return keepFiles[e.source] !== undefined && keepFiles[e.target] !== undefined; });
            return Object.assign({}, base, {
                nodes: cgCount(fileNodes, fileEdges, CG_FILE_DEG), edges: fileEdges, totals: totals,
                focus: centre ? [{ id: centre, name: centre.split("/").pop(), path: centre, line: 1 }] : null
            });
        }
        if (!focus) {
            var allNodes = CG_SYMBOLS.map(function (r) { return cgNode(r, 0); });
            var allEdges = CG_EDGES.map(function (e) { return { source: e[0], target: e[1], relation: e[2] }; });
            return Object.assign({}, base, { nodes: cgCount(allNodes, allEdges, CG_SYMBOL_DEG), edges: allEdges, totals: totals });
        }
        var hit = null;
        for (var j = 0; j < CG_SYMBOLS.length; j++) {
            var r = CG_SYMBOLS[j];
            if (r[0].toLowerCase() === focus || r[1].toLowerCase() === focus || r[3].toLowerCase() === focus) { hit = r; break; }
        }
        if (!hit) return missing();
        var keep = {};
        keep[hit[0]] = 0;
        for (var k = 0; k < CG_EDGES.length; k++) {
            if (CG_EDGES[k][0] === hit[0] && keep[CG_EDGES[k][1]] === undefined) keep[CG_EDGES[k][1]] = 1;
            if (CG_EDGES[k][1] === hit[0] && keep[CG_EDGES[k][0]] === undefined) keep[CG_EDGES[k][0]] = 1;
        }
        var nodes = CG_SYMBOLS.filter(function (r) { return keep[r[0]] !== undefined; }).map(function (r) { return cgNode(r, keep[r[0]]); });
        var edges = CG_EDGES.filter(function (e) { return keep[e[0]] !== undefined && keep[e[1]] !== undefined; })
            .map(function (e) { return { source: e[0], target: e[1], relation: e[2] }; });
        return Object.assign({}, base, { nodes: cgCount(nodes, edges, CG_SYMBOL_DEG), edges: edges, totals: totals, focus: [{ id: hit[0], name: hit[1], path: hit[3], line: hit[4] }] });
    }

    function codeGraphAsk(query) {
        return `code graph - "${query}" (hybrid)\n\n- readConfig - function - src/config.ts:42-58\n    function readConfig(): { config: EnigmaConfig; path: string }\n- resolveBin - function - src/tool-launch.ts:71-96\n    function resolveBin(tool: string): string | null\n\nSaved you from opening 2 files (~410 lines).\n`;
    }

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

    // Quality gate: one finished run and one parked on a review finding, so the demo shows
    // both the pipeline strip and what a decision point looks like.
    // `live` gates the Stop control and the poll, `activity` is the live step + log tail: both
    // are payload fields the real bridge sends, and a mock that omits them silently drops the
    // feature from the preview and the screenshot.
    function gateRun(id, branch, status, steps, findings, activity) {
        return {
            id: id, branch: branch, status: status, headSha: id.slice(0, 8), prUrl: status === "completed" ? "https://github.com/FJRG2007/enigma/pull/114" : null,
            error: null, awaitingAgent: !!(findings && findings.length), intent: null, createdAt: Date.now() / 1000, updatedAt: Date.now() / 1000,
            live: status === "pending" || status === "running" || status === "awaiting_approval",
            activity: activity || null,
            steps: steps, findings: findings || [],
        };
    }
    function gateStep(name, status, ms, findings, startedAt) {
        return { name: name, status: status, durationMs: ms, findings: findings || 0, startedAt: startedAt || null, completedAt: null };
    }
    function gateView(project) {
        var now = Math.floor(Date.now() / 1000);
        var done = gateRun("a1b2c3d4e5", "feat/dashboard-sidebar", "completed", [
            gateStep("intent", "completed", 2), gateStep("rebase", "completed", 1374), gateStep("review", "completed", 393273, 3),
            gateStep("test", "completed", 61200), gateStep("document", "completed", 8100), gateStep("lint", "completed", 4300),
            gateStep("push", "completed", 2200), gateStep("pr", "completed", 1900), gateStep("ci", "completed", 41000),
        ]);
        var parked = gateRun("f6a7b8c9d0", "fix/token-refresh", "running", [
            gateStep("intent", "completed", 2), gateStep("rebase", "completed", 1290), gateStep("review", "awaiting_approval", 220400, 1, now - 220),
            gateStep("test", "pending", null), gateStep("document", "pending", null), gateStep("lint", "pending", null),
            gateStep("push", "pending", null), gateStep("pr", "pending", null), gateStep("ci", "pending", null),
        ], [{ id: "token-refresh-race", severity: "warning", action: "auto-fix", file: "src/auth/token.ts", description: "Two concurrent requests can both refresh the token, so the second overwrites the first with an older value." }],
        {
            step: "review", status: "awaiting_approval", startedAt: now - 220,
            tail: [
                "reading diff (14 files, +412 -96)",
                "agent: reviewing src/auth/token.ts",
                "agent: reviewing src/auth/session.ts",
                "1 finding recorded, waiting for a decision",
            ],
        });
        return {
            on: true, runsAvailable: true, runsNote: "", daemon: true, root: "~/.enigma/gate",
            canWrite: true, writeNote: "", serverNow: now,
            // The pipeline-settings panel renders from this; without it the whole panel hides.
            settings: {
                agent: "claude", agentResolved: "claude", model: "", modelSupported: true,
                ciTimeout: "168h", logLevel: "info", intentEnabled: true, fixPolicy: "assisted",
                autoFix: { rebase: 2, review: 0, test: 2, document: 1, lint: 2, ci: 2 },
                defaults: {
                    agent: "auto", ciTimeout: "168h", logLevel: "info", fixPolicy: "assisted", intentEnabled: true,
                    autoFix: { rebase: 3, review: 0, test: 3, document: 3, lint: 3, ci: 3 },
                },
            },
            globalConfig: { path: "~/.enigma/gate/config.yaml" },
            repo: project ? { path: project, initialized: true, configPath: `${project}/.enigma-gate.yaml`, text: "# Repository gate configuration\n\ncommands:\n  test: npm test\n", exists: true } : null,
            runs: project ? [done] : [parked, done],
        };
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
        if (path.indexOf("/api/gate") !== -1) {
            if (method === "POST") {
                if (body && body.action === "abort") return { ok: true, message: "Demo - the run was not stopped." };
                return { ok: true, message: "Demo - the config was not written." };
            }
            return gateView(qparam(path, "path"));
        }
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
                if (body && body.op === "graph") return { ok: true, graph: codeGraphSlice(body) };
                if (body && body.op === "ask") {
                    var q = (body.query || "").trim();
                    if (!q) return { ok: false, error: "missing query" };
                    CODEGRAPH.ask = { query: q, report: codeGraphAsk(q) };
                    return { ok: true, view: CODEGRAPH };
                }
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
            if (method !== "POST") return { connections: SSH, tunnels: TUNNELS, reserved: SSH_RESERVED };
            var sb = body || {};
            if (sb.action === "connect") return { ok: true, command: `enigma ssh ${sb.alias || "server1"}`, note: "Run this in a terminal to connect." };
            if (sb.action === "tunnel-start") { TUNNELS = TUNNELS.map((t) => t.name === sb.tunnelName ? Object.assign({}, t, { active: true }) : t); return { ok: true, note: "Demo - tunnel started.", connections: SSH, tunnels: TUNNELS }; }
            if (sb.action === "tunnel-stop") { TUNNELS = TUNNELS.map((t) => t.name === sb.tunnelName ? Object.assign({}, t, { active: false }) : t); return { ok: true, note: "Demo - tunnel stopped.", connections: SSH, tunnels: TUNNELS }; }
            return { ok: true, note: "Demo - no change made.", connections: SSH, tunnels: TUNNELS };
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
