/**
 * Agents (`enigma agent`, formerly "packs"): optional, isolated harness bundles installed from
 * the marketplace. The code keeps the "pack" name, and so do the stored config keys (`packs`,
 * `packAccounts`) and the managed root (~/.enigma/packs), so existing installs keep working.
 *
 * A pack (Helio for offensive security / bug bounty, Orion for bugs/speed/scalability/search
 * quality QA, Vega for reverse engineering) ships skills, slash commands, sub-agents and MCP
 * servers for a focused domain; Vega also pins an engine (agent-engine.ts) its MCP server runs on.
 * Unlike enigma's policy skills, a pack is NEVER deployed into the user's normal agent: it is
 * fetched on demand as an asset-only npm package (@enigmax/<pack>) into a managed dir, and
 * deployed only into a DEDICATED, isolated agent context dir. Launching `enigma helio` (or
 * `enigma orion`) spawns the agent pointed at that context (via the tool's config-dir env var,
 * reusing accounts.ts), so the agent sees ONLY the pack's skills and commands - the normal
 * coding agent stays clean and unburdened.
 *
 * Credentials are seeded from the user's active account into the context dir, so the isolated
 * pack agent shares the login with no re-authentication.
 *
 * Delivery mirrors @enigmax/dashboard (dashboard-pkg.ts): a managed install dir, a best-effort
 * synchronous npm installer, and a runtime resolver that falls back to the dev workspace copy.
 */

import { homedir } from "node:os";
import * as acct from "./accounts";
import { isDir, readJson, resolveBin } from "./util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { copyIfFresher } from "./claude-oauth";
import { applyContextServer, browserInvocation, hasContextServer, type ContextServer } from "./mcp-deploy";
import { engineBin, engineNodeRange, ensureEngine, ensureEngineAsync, installedEngineVersion, pickNode, readEngineSpec, type EngineSpec } from "./agent-engine";
import { mirrorAccountSettings } from "./permissions";
import { readConfig, setEnigmaValue, setPackAccount } from "./config";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** A marketplace pack: an optional isolated harness bundle. */
export interface PackDef {
    /** Stable id and launch shortcut (e.g. "helio" -> `enigma helio`). */
    id: string;
    label: string;
    /** Asset-only npm package the pack content ships in. */
    pkg: string;
    description: string;
    tags: string[];
    /** Pack homepage (the source repo), shown in the marketplace. */
    homepage: string;
    /**
     * MCP servers the pack uses. A script it ships (`relArgs`, run with python) is registered
     * only by `enigma agent setup`; a `builtin` server enigma already knows how to launch is
     * registered on every deploy, so the pack works on its first launch. An `engine` server is
     * the pack's engine bin run with `args` (see agent-engine.ts). Timeouts map to each client's
     * own keys (see applyContextServer).
     */
    mcp?: { name: string; relArgs?: string[]; builtin?: "browser" | "engine"; args?: string[]; toolTimeoutMs?: number; startupTimeoutMs?: number; }[];
    /**
     * The npm runtime behind an `engine` server, pinned by the bundle's assets/engine.json: `bin`
     * is the package's bin to run; `clients` maps an enigma tool to the engine's own client id
     * for its `setup` and `doctor` commands, which `enigma agent setup` runs inside the context.
     */
    engine?: { bin: string; clients: Record<string, string>; };
}

/** Built-in pack catalog. Add a pack as one entry here; the rest is generic. */
export const PACKS: PackDef[] = [
    {
        id: "helio",
        label: "Helio",
        pkg: "@enigmax/helio",
        description: "Bug-bounty and offensive-security harness: recon, vuln hunting, web2/web3 audit, AD, cloud, triage and report writing. Runs in an isolated agent context so it never loads into your normal coding agent.",
        tags: ["bug-bounty", "security", "pentest", "web3"],
        homepage: "https://www.npmjs.com/package/@enigmax/helio",
        // Only self-contained Python servers are auto-registered. Helio's Burp client is a
        // separate Java server (needs Burp Suite + an API key); it stays config-only - see
        // the pack's mcp/burp-mcp-client/README for manual setup.
        mcp: [
            { name: "helio-hackerone", relArgs: ["mcp", "hackerone-mcp", "server.py"] },
        ],
    },
    {
        id: "orion",
        label: "Orion",
        pkg: "@enigmax/orion",
        description: "Hunts what looks finished but is not: broken flows, slow loads, unbounded queries, scaling limits and searches that never say \"no results\" - each proved with a trace, a number or a failing input, in a real browser. Runs in an isolated agent context.",
        tags: ["bugs", "performance", "scalability", "qa"],
        homepage: "https://www.npmjs.com/package/@enigmax/orion",
        // The browser is the pack's main instrument, so it is wired on deploy, not behind setup.
        mcp: [
            { name: "chrome-devtools", builtin: "browser" },
        ],
    },
    {
        id: "vega",
        label: "Vega",
        pkg: "@enigmax/vega",
        description: "Reverse engineering on REA (Reverse Engineer Anything): one MCP server and skill to reverse native binaries, Electron/JavaScript apps, .NET, Android, firmware, websites and captures - every claim backed by the evidence it came from. Runs in an isolated agent context.",
        tags: ["reverse-engineering", "binaries", "security", "mcp"],
        homepage: "https://github.com/morluto/rea",
        engine: { bin: "rea", clients: { claude: "claude_code", codex: "codex", opencode: "opencode", kimi: "kimi" } },
        // A Ghidra analysis of a large binary runs for many minutes without output, longer than
        // the clients' defaults allow (Codex: 60 s per call; Claude Code: 30 min idle), and a
        // cancelled analysis restarts from scratch (morluto/rea#3509). Startup matches REA's own
        // registration (30 s).
        mcp: [
            { name: "rea", builtin: "engine", args: ["mcp"], toolTimeoutMs: 6 * 60 * 60_000, startupTimeoutMs: 30_000 },
        ],
    },
];

/** Root holding all packs' managed installs + contexts. ENIGMA_PACKS_DIR overrides (tests). */
function packsRoot(): string {
    return process.env.ENIGMA_PACKS_DIR || join(homedir(), ".enigma", "packs");
}

function packRoot(id: string): string {
    return join(packsRoot(), id);
}

/** Look up a pack by id, or null. */
export function getPack(id: string): PackDef | null {
    return PACKS.find((p) => p.id === id) ?? null;
}

/** The npm install host dir for a pack (its node_modules live here). */
function installDir(id: string): string {
    return join(packRoot(id), "pkg");
}

/** Whether the pack's npm bundle is fetched. */
export function isPackInstalled(id: string): boolean {
    const pack = getPack(id);
    if (!pack) return false;
    return existsSync(join(installDir(id), "node_modules", ...pack.pkg.split("/"), "package.json"));
}

/** Installed pack bundle version, or null when absent/unreadable. */
export function installedPackVersion(id: string): string | null {
    const pack = getPack(id);
    if (!pack) return null;
    const pkgJson = join(installDir(id), "node_modules", ...pack.pkg.split("/"), "package.json");
    try {
        const v = (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: unknown; }).version;
        return typeof v === "string" ? v : null;
    } catch {
        return null;
    }
}

/**
 * Resolve a pack's vendored assets dir (the folder holding skills/, commands/, agents/, mcp/).
 * Order: explicit override (tests/dev) -> managed on-demand install -> the workspace package when
 * running from source. Returns null when it cannot be found.
 */
export function packAssetsDir(id: string): string | null {
    const pack = getPack(id);
    if (!pack) return null;
    const override = process.env[`ENIGMA_${id.toUpperCase()}_ASSETS`];
    if (override) return override;
    const managed = join(installDir(id), "node_modules", ...pack.pkg.split("/"), "assets");
    if (existsSync(join(managed, "skills"))) return managed;
    // Dev: packages/<id>/assets relative to packages/enigma-cli/src.
    const dev = join(__dirname, "..", "..", id, "assets");
    if (existsSync(join(dev, "skills"))) return dev;
    return null;
}

/** Ensure the managed host dir exists with a private manifest so npm installs there. */
function ensureHostDir(id: string): void {
    const dir = installDir(id);
    mkdirSync(dir, { recursive: true });
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ name: `enigma-pack-${id}-host`, private: true }, null, 2)}\n`);
}

/** Run `npm install <pkg>@<spec>` in the pack's managed dir. Best-effort, never throws. */
function npmInstall(id: string, spec: string): void {
    const pack = getPack(id);
    if (!pack) return;
    try {
        ensureHostDir(id);
        spawnSync("npm", ["install", `${pack.pkg}@${spec}`, "--no-audit", "--no-fund", "--silent", "--prefer-online"], {
            cwd: installDir(id), shell: true, stdio: "ignore", timeout: 180000, windowsHide: true,
        });
    } catch { /* best-effort: a missing npm or no network just leaves the pack un-fetched */ }
}

/** Fetch the pack bundle if absent (latest). Returns true when present afterwards. */
export function ensurePackInstalled(id: string): boolean {
    if (isPackInstalled(id)) return true;
    // Dev: a workspace copy is enough, no fetch needed.
    if (packAssetsDir(id)) return true;
    npmInstall(id, "latest");
    return isPackInstalled(id);
}

/** Force-refresh the pack bundle to latest; returns true if the version changed. */
export function refreshPack(id: string): boolean {
    const before = installedPackVersion(id);
    npmInstall(id, "latest");
    return installedPackVersion(id) !== before;
}

// --- enabled state (config.packs) ------------------------------------------------

/** Pack ids the user has added from the marketplace. */
export function enabledPacks(): string[] {
    return readConfig().config.packs ?? [];
}

export function isPackEnabled(id: string): boolean {
    return enabledPacks().includes(id);
}

/** Add a pack to the user's marketplace selection (idempotent). */
export function enablePack(id: string): void {
    if (!getPack(id)) throw new Error(`Unknown agent '${id}'.`);
    const next = [...new Set([...enabledPacks(), id])];
    setEnigmaValue("packs", next, "global");
}

/** Remove a pack from the selection and delete its managed dir + context. */
export function disablePack(id: string): void {
    setEnigmaValue("packs", enabledPacks().filter((p) => p !== id), "global");
    rmSync(packRoot(id), { recursive: true, force: true });
}

// --- per-pack seeding account ----------------------------------------------------

/** Config key for a pack's default seeding account on a tool. */
function packAccountKey(id: string, tool: string): string {
    return `${id}:${tool}`;
}

/** The pack's stored default account for a tool, if set and still existing; else null. */
export function getPackAccount(id: string, tool: string): string | null {
    const name = readConfig().config.packAccounts?.[packAccountKey(id, tool)];
    return name && acct.accountExists(tool, name) ? name : null;
}

/**
 * Set (or clear, with null) the default account that seeds a pack's isolated context on a tool.
 * The account must exist for that tool (create one first with `enigma account add`). Clearing
 * makes the pack fall back to the active profile / tool-active account.
 */
export function setPackDefaultAccount(id: string, tool: string, account: string | null): void {
    if (!getPack(id)) throw new Error(`Unknown agent '${id}'.`);
    if (!acct.isToolName(tool)) throw new Error(`Unknown tool '${tool}'.`);
    if (account !== null && !acct.accountExists(tool, account)) {
        throw new Error(`No such ${tool} account: '${account}'. Create it first: enigma account add ${account}${tool === acct.DEFAULT_TOOL ? "" : ` --tool ${tool}`}.`);
    }
    setPackAccount(packAccountKey(id, tool), account, "global");
}

/**
 * Resolve which account seeds the pack on a tool: an explicit choice wins, then the pack's
 * stored default, then the active profile's mapping / the tool's active account (resolveLaunchAccount).
 * Throws when an explicit account does not exist, so a typo never silently seeds the wrong login.
 */
export function resolvePackAccount(id: string, tool: string, explicit?: string): string {
    if (explicit) {
        if (!acct.accountExists(tool, explicit)) {
            throw new Error(`No such ${tool} account: '${explicit}'. Create it first: enigma account add ${explicit}${tool === acct.DEFAULT_TOOL ? "" : ` --tool ${tool}`}.`);
        }
        return explicit;
    }
    return getPackAccount(id, tool) ?? acct.resolveLaunchAccount(tool);
}

// --- isolated context deployment -------------------------------------------------

/** The isolated agent config dir for a pack + tool. */
function contextDir(id: string, tool: string): string {
    return join(packRoot(id), "context", tool);
}

/** Marker recording which pack version the context was last deployed from. */
function deployMarker(dir: string): string {
    return join(dir, ".enigma-pack-version");
}

/** Recursively copy every entry of `src` into `dest` (creating dest). */
function copyInto(src: string, dest: string): void {
    if (!existsSync(src)) return;
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) cpSync(join(src, name), join(dest, name), { recursive: true });
}

/**
 * Enable Claude Code's permission bypass in the pack's isolated context by default. A security
 * harness like Helio issues many tool calls, so per-action approval prompts would be unworkable.
 * Honors the global permissionBypass opt-out (config), merges into any existing settings, and is
 * idempotent. Claude-only (its bypass lives in a config-dir settings.json). Writes only the pack
 * context, never the user's account. Best-effort.
 */
function ensurePackBypass(dir: string, tool: string): void {
    if (tool !== "claude" || !readConfig().config.permissionBypass) return;
    try {
        const file = join(acct.getTool(tool).accountTarget(dir).memory, "settings.json");
        const settings = (existsSync(file) ? readJson<Record<string, unknown>>(file) : {}) ?? {};
        const perm = (typeof settings.permissions === "object" && settings.permissions) ? settings.permissions as Record<string, unknown> : {};
        if (perm.defaultMode === "bypassPermissions") return;
        perm.defaultMode = "bypassPermissions";
        settings.permissions = perm;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    } catch { /* best-effort */ }
}

/** Pick the command source dir for a tool: a per-tool subfolder, else the flat commands/. */
function commandSource(assets: string, tool: string): string {
    const perTool = tool === "claude" ? "claude-code" : tool;
    const scoped = join(assets, "commands", perTool);
    return existsSync(scoped) ? scoped : join(assets, "commands");
}

/**
 * Deploy the pack's content into its isolated context dir for `tool`: skills, the tool's
 * command set, sub-agents (Claude Code) and a memory file carrying the harness instructions.
 * The user's enigma-managed agent settings (commit attribution / feedback survey off, ...) are
 * mirrored into the context and the pack's bypass default is forced on top, so the isolated
 * agent behaves like the user's normal one.
 * Idempotent and version-gated - a re-deploy only runs when the installed pack version changed.
 * Returns the context dir, or null when the pack assets cannot be resolved.
 */
export function deployPack(id: string, tool: string): string | null {
    const assets = packAssetsDir(id);
    if (!assets) return null;
    const dir = contextDir(id, tool);
    // Mirror the user's enigma-managed agent settings into the isolated context (Claude commit
    // attribution + feedback survey off, and the codex/opencode equivalents), then force the
    // pack's bypass default on top so a global bypass-off cannot undo it. Both run even when
    // version-gated below, so an already-deployed context picks up the current posture on the
    // next launch.
    mirrorAccountSettings(tool, dir);
    ensurePackBypass(dir, tool);
    registerPackMcp(id, tool, true);
    const version = installedPackVersion(id) ?? "dev";
    try {
        if (existsSync(deployMarker(dir)) && readFileSync(deployMarker(dir), "utf8").trim() === version) return dir;
    } catch { /* re-deploy on a bad marker */ }

    const target = acct.getTool(tool).accountTarget(dir);
    // Skills -> the tool's skill dir (when it has a per-account one).
    if (target.skills) {
        rmSync(target.skills, { recursive: true, force: true });
        copyInto(join(assets, "skills"), target.skills);
    }
    // Commands -> the tool's command dir.
    if (target.commands) {
        rmSync(target.commands, { recursive: true, force: true });
        copyInto(commandSource(assets, tool), target.commands);
    }
    // Sub-agents (Claude Code reads <config-dir>/agents).
    if (tool === "claude") {
        const agentsDest = join(target.memory, "agents");
        rmSync(agentsDest, { recursive: true, force: true });
        copyInto(join(assets, "agents"), agentsDest);
    }
    // Memory: the harness instructions become the context's agent memory file.
    const memoryFile = join(target.memory, tool === "claude" ? "CLAUDE.md" : "AGENTS.md");
    const memorySrc = existsSync(join(assets, "AGENTS.md")) ? join(assets, "AGENTS.md") : join(assets, "SKILL.md");
    if (existsSync(memorySrc)) {
        mkdirSync(target.memory, { recursive: true });
        writeFileSync(memoryFile, readFileSync(memorySrc, "utf8"));
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(deployMarker(dir), `${version}\n`);
    return dir;
}

/**
 * Credential material to seed into a pack context, per tool, relative to the account's config
 * dir. An entry may name a file or a whole directory - Kimi stores one file per provider under
 * `credentials/` (plus `credentials/mcp/`), so the directory is the unit that carries a login.
 */
const CRED_FILES: Record<string, string[]> = {
    claude: [".credentials.json"],
    codex: ["auth.json"],
    opencode: [join("xdg-data", "opencode", "auth.json")],
    kimi: ["credentials"],
};

/** Whether a Claude credentials file already holds a usable OAuth token (non-empty access+refresh). */
function hasUsableToken(file: string): boolean {
    try {
        const t = (JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; }; }).claudeAiOauth;
        return Boolean(t?.accessToken && t?.refreshToken);
    } catch {
        return false;
    }
}

/**
 * Login state of a Claude credentials file: "ok" | "expired" | "empty" | "absent".
 * IMPORTANT: a past-expiry access token is NOT a problem when a refresh token is present - the
 * agent refreshes it automatically, so that is "ok" (reporting it "expired" was a false alarm
 * for any normally-aged login). Only a token with no refresh token AND past expiry is truly
 * unusable ("expired"); "empty" is a logged-out/blanked file; "absent" is no file at all.
 */
function tokenState(file: string): "ok" | "expired" | "empty" | "absent" {
    if (!existsSync(file)) return "absent";
    try {
        const t = (JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; }; }).claudeAiOauth;
        if (!t?.accessToken) return "empty";
        const past = typeof t.expiresAt === "number" && t.expiresAt > 0 && t.expiresAt < Date.now();
        return past && !t.refreshToken ? "expired" : "ok";
    } catch {
        return "absent";
    }
}

/**
 * Seed `account`'s credential files into the pack context so the isolated agent shares that login
 * (no re-authentication). Best-effort and claude-first: only well-known auth files are copied,
 * never the user's project history.
 *
 * Rules that keep this from ever making auth WORSE (it only ever writes inside the pack context,
 * never the user's account dir):
 *  1. Keep the context's own token when it belongs to the SAME account we are seeding from - the
 *     agent rotates its OAuth token in place, and re-copying the account's older token over a
 *     refreshed one would break the next refresh. A per-context marker records which account's
 *     token is in the context, so this only protects a genuine rotation, not a stale token.
 *  2. RE-SEED when the account CHANGED (you pinned/switched to a different login): the context may
 *     still hold the previous account's token, whose identity no longer matches the context - that
 *     token/identity mismatch is exactly what makes the agent prompt to log in. On a change we copy
 *     the new token AND align the context identity with it.
 *  3. (Claude) Never PLANT a non-usable token. A blanked/keychain-stored `.credentials.json` must
 *     not be copied in (an empty token file is worse than none - it blocks the agent's own session
 *     resolution); the context is left for the agent to resolve.
 *
 * Silent on any failure. Exported for testing.
 */
export function seedCredentials(id: string, tool: string, account: string): void {
    const files = CRED_FILES[tool];
    if (!files) return;
    try {
        const source = acct.resolveConfigDir(tool, account);
        const dest = contextDir(id, tool);
        const marker = join(dest, ".enigma-pack-account");
        let seededFrom = "";
        try { seededFrom = readFileSync(marker, "utf8").trim(); } catch { /* no prior seed */ }
        const accountChanged = seededFrom !== account;

        let copied = false;
        for (const rel of files) {
            const from = join(source, rel);
            if (!existsSync(from)) continue;
            // Claude: only copy a credentials file that actually carries a usable token - never
            // plant a blanked/keychain-stored placeholder over the agent's own resolution.
            if (tool === "claude" && !hasUsableToken(from)) continue;
            const to = join(dest, rel);
            // Keep the context token only when it is the SAME account's (a possible fresh rotation);
            // a different/switched account must replace it (token/identity mismatch -> login prompt).
            if (!accountChanged && existsSync(to) && hasUsableToken(to)) continue;
            mkdirSync(dirname(to), { recursive: true });
            // A directory entry (Kimi's per-provider credentials/) copies as a tree; the
            // recursive flag is inert for a file, so both kinds take the same path.
            cpSync(from, to, { recursive: true });
            copied = true;
        }
        // Claude: keep the context's ACCOUNT STATE (onboarding flags + identity) in sync with the
        // seeding account so the agent treats the context as the same signed-in install. Without
        // `hasCompletedOnboarding` the agent runs the onboarding flow - which asks to log in - even
        // with a perfectly valid token. Idempotent; runs whenever the context holds this account's
        // token (copied now, or kept from a same-account launch), so a context that only had the
        // token synced by an older enigma gets the missing onboarding state on the next launch.
        if (tool === "claude") {
            const ctxHasToken = hasUsableToken(join(dest, ...(files[0] ?? "").split("/")));
            if (copied || ctxHasToken) syncContextAccountState(source, dest);
        }
        if (copied) {
            mkdirSync(dest, { recursive: true });
            writeFileSync(marker, account);
        }
    } catch { /* best-effort - the user can log in inside the context if seeding misses */ }
}

/**
 * Mirror the seeding account's Claude config state (`.claude.json`) into the pack context so the
 * agent treats the context as the same signed-in install: it carries the onboarding flags,
 * identity and preferences the agent checks before deciding to run onboarding/login. The pack's
 * own MCP servers are preserved, and the account's project history is dropped to keep the context
 * clean. Writes the CONTEXT file only - the user's account dir is never touched. Best-effort.
 */
function syncContextAccountState(accountDir: string, ctxDir: string): void {
    try {
        const acc = readJson<Record<string, unknown>>(join(accountDir, ".claude.json"));
        if (!acc?.oauthAccount) return;
        const ctxFile = join(ctxDir, ".claude.json");
        const ctx = (existsSync(ctxFile) ? readJson<Record<string, unknown>>(ctxFile) : {}) ?? {};
        const merged: Record<string, unknown> = { ...acc };
        delete merged.projects; // don't drag the account's project history into the pack context
        if (ctx.mcpServers) merged.mcpServers = ctx.mcpServers; // keep the pack's own MCP servers
        writeFileSync(ctxFile, `${JSON.stringify(merged, null, 2)}\n`);
    } catch { /* best-effort */ }
}

/**
 * Keep a pack context and its (managed) seeding account on ONE reused Claude session so they
 * never diverge into the OAuth rotation "ping-pong" (whichever dir refreshes last invalidates
 * the other's refresh token, silently logging the loser out). Converges both dirs on whichever
 * currently holds the FRESHER token, in either direction:
 *  - account fresher (you just launched `enigma claude`, it refreshed) -> update the context;
 *  - context fresher (the pack has been the only thing launched, and the account went stale or
 *    blanked) -> heal the account, so the next `enigma claude` reuses the live session.
 * Only the strictly-fresher side ever writes (copyIfFresher), so a newer token is never lost.
 * Claude-only, and restricted to MANAGED accounts: the synthetic "default" account is the user's
 * own ~/.claude, which enigma never writes credentials into. Best-effort.
 */
export function reconcilePackSession(id: string, tool: string, account: string): void {
    if (tool !== "claude" || account === acct.DEFAULT_NAME) return;
    try {
        const accountDir = acct.resolveConfigDir(tool, account);
        const ctx = contextDir(id, tool);
        copyIfFresher(accountDir, ctx);
        copyIfFresher(ctx, accountDir);
    } catch { /* best-effort */ }
}

/** Claude pack contexts that currently hold a credentials file, as session-transfer sources. */
export function packSessionSources(tool: string = acct.DEFAULT_TOOL): { id: string; label: string; dir: string; }[] {
    return PACKS
        .map((p) => ({ id: p.id, label: p.label, dir: contextDir(p.id, tool) }))
        .filter((s) => existsSync(join(s.dir, ".credentials.json")));
}

/**
 * Register the pack's MCP servers into the isolated context. Script servers are gated behind
 * `enigma agent setup` because they need Python + the pack's tooling; registering them blindly
 * would make the agent fail to start a server whose deps are missing. Returns the names
 * registered, or [] when nothing applies.
 */
export function setupPackMcp(id: string, tool: string): string[] {
    return registerPackMcp(id, tool, false);
}

/**
 * How `tool` launches one of the pack's MCP servers: a spec to register, null to remove the
 * entry, or undefined to leave it alone (a script server on the deploy path, an engine that is
 * not installed yet). `builtinOnly` is the deploy path.
 */
function packServerSpec(id: string, assets: string, server: NonNullable<PackDef["mcp"]>[number], tool: string, builtinOnly: boolean): ContextServer | null | undefined {
    const timeouts = { toolTimeoutMs: server.toolTimeoutMs, startupTimeoutMs: server.startupTimeoutMs };
    if (server.builtin === "browser") return readConfig().config.browser ? { ...browserInvocation(tool), ...timeouts } : null;
    if (server.builtin === "engine") {
        const inv = engineInvocation(id);
        return inv ? { command: inv.command, args: [...inv.args, ...(server.args ?? [])], ...timeouts } : undefined;
    }
    if (builtinOnly || !server.relArgs) return undefined;
    const script = join(assets, ...server.relArgs);
    if (!existsSync(script)) return undefined;
    return { command: process.platform === "win32" ? "python" : "python3", args: [script], ...timeouts };
}

/** Write the pack's MCP servers into its context, in `tool`'s own config format. */
function registerPackMcp(id: string, tool: string, builtinOnly: boolean): string[] {
    const pack = getPack(id);
    const assets = packAssetsDir(id);
    if (!pack?.mcp || !assets) return [];
    if (builtinOnly && !pack.mcp.some((server) => server.builtin)) return [];
    const dir = contextDir(id, tool);
    const added: string[] = [];
    for (const server of pack.mcp) {
        const spec = packServerSpec(id, assets, server, tool, builtinOnly);
        if (spec === undefined) continue;
        applyContextServer(tool, dir, server.name, spec);
        if (spec && hasContextServer(tool, dir, server.name)) added.push(server.name);
    }
    return added;
}

// --- engine ----------------------------------------------------------------------

/**
 * Install the pack's pinned engine (assets/engine.json) when it declares one. Returns null when
 * the engine is ready or the pack has none, else why it could not be installed.
 */
export function ensurePackEngine(id: string, onInstall?: (spec: EngineSpec) => void): string | null {
    const spec = packEngineSpec(id);
    if (spec === null || typeof spec === "string") return spec;
    if (installedEngineVersion(packRoot(id), spec.package) !== spec.version) onInstall?.(spec);
    return ensureEngine(packRoot(id), spec);
}

/** ensurePackEngine without blocking the event loop, for the dashboard server. */
export async function ensurePackEngineAsync(id: string): Promise<string | null> {
    const spec = packEngineSpec(id);
    if (spec === null || typeof spec === "string") return spec;
    return ensureEngineAsync(packRoot(id), spec);
}

/** The pack's engine spec, null when it declares no engine, or why its declaration is invalid. */
function packEngineSpec(id: string): EngineSpec | string | null {
    const pack = getPack(id);
    if (!pack?.engine) return null;
    const assets = packAssetsDir(id);
    return (assets ? readEngineSpec(assets) : null) ?? `${pack.label} declares no valid engine (assets/engine.json).`;
}

/** Whether the pack needs no engine or has its pinned one installed, without installing anything. */
function isPackEngineReady(id: string): boolean {
    const pack = getPack(id);
    if (!pack?.engine) return true;
    const assets = packAssetsDir(id);
    const spec = assets ? readEngineSpec(assets) : null;
    return Boolean(spec) && installedEngineVersion(packRoot(id), spec!.package) === spec!.version;
}

/**
 * Install the engine for a launch, telling the user what is happening and what is wrong: a
 * failed install, or a machine without a Node.js the engine accepts, leaves the agent without
 * its tools, which must not look like a working launch.
 */
function preparePackEngine(id: string): void {
    const pack = getPack(id);
    if (!pack?.engine) return;
    const error = ensurePackEngine(id, (spec) => process.stdout.write(`Installing the ${pack.label} engine (${spec.package}@${spec.version}), once per version...\n`));
    if (error) {
        process.stderr.write(`Could not install the ${pack.label} engine: ${error}\n  ${pack.label}'s tools will be missing in this session. Retry with: enigma agent setup ${id}\n`);
        return;
    }
    const inv = engineInvocation(id);
    const spec = readEngineSpec(packAssetsDir(id) ?? "");
    if (inv && !inv.nodeOk && spec) {
        process.stderr.write(`No installed Node.js satisfies ${pack.label}'s requirement (${engineNodeRange(packRoot(id), spec.package) ?? "unknown"}), so its tools will fail to start. Install a matching Node.js and relaunch.\n`);
    }
}

/**
 * `<node> <engine bin>` for the pack's installed engine, with a node that satisfies the engine's
 * `engines.node` range when this machine has one (else the PATH node, so the engine's own
 * launcher reports the mismatch). Null when the engine is not installed.
 */
export function engineInvocation(id: string): { command: string; args: string[]; nodeOk: boolean; } | null {
    const pack = getPack(id);
    const assets = packAssetsDir(id);
    const spec = assets ? readEngineSpec(assets) : null;
    if (!pack?.engine || !spec) return null;
    const script = engineBin(packRoot(id), spec.package, pack.engine.bin);
    if (!script) return null;
    const node = pickNode(engineNodeRange(packRoot(id), spec.package));
    return { command: node?.path ?? resolveBin("node") ?? "node", args: [script], nodeOk: Boolean(node) };
}

/**
 * Run the engine's own command (`setup`, `doctor`, any CLI call) against the pack's isolated
 * context for `tool`: its client id is added for setup/doctor, and the tool's config-dir env
 * points it at the context, never the user's normal agent. Interactive (inherits the terminal).
 */
export function runPackEngine(id: string, tool: string, args: string[]): number {
    const pack = getPack(id);
    const inv = engineInvocation(id);
    if (!pack?.engine || !inv) return 1;
    const client = pack.engine.clients[tool];
    const withClient = client && (args[0] === "setup" || args[0] === "doctor") && !args.includes("--client") ? [...args, "--client", client] : args;
    const result = spawnSync(inv.command, [...inv.args, ...withClient], {
        stdio: "inherit", windowsHide: true,
        env: acct.toolEnv(tool, contextDir(id, tool)),
    });
    return result.status ?? 1;
}

// --- launch ----------------------------------------------------------------------

export interface PackView {
    id: string;
    label: string;
    description: string;
    tags: string[];
    homepage: string;
    installed: boolean;
    enabled: boolean;
    version: string | null;
    /** Tool the pack launches on (its primary tool; claude today). */
    tool: string;
    /** The pack's pinned default account, or null when it follows the active profile/account. */
    defaultAccount: string | null;
    /** Account that WILL seed the pack now (resolved default/profile/active), for display. */
    resolvedAccount: string;
    /** Accounts available for the tool, with login freshness so the picker can flag stale logins. */
    accounts: { name: string; label: string; state: "ok" | "expired" | "empty" | "absent"; }[];
    /** Login state of the account that will seed the pack now (ok | expired | empty | absent). */
    resolvedState: "ok" | "expired" | "empty" | "absent";
    /** True when the isolated context ALREADY holds a usable token, so no login will be asked
     * even if the resolved account looks stale - suppresses a misleading "not signed in" warning. */
    contextReady: boolean;
}

/** Marketplace listing of every pack with its install/enable state and seeding account. */
export function listPacks(): PackView[] {
    return PACKS.map((p) => {
        const tool = acct.DEFAULT_TOOL;
        const accounts = acct.listAccounts(tool).map((a) => ({ name: a.name, label: a.email ?? a.displayName ?? a.name, state: accountTokenState(tool, a.name) }));
        const resolvedAccount = resolvePackAccount(p.id, tool);
        const ctxCred = join(contextDir(p.id, tool), ...(CRED_FILES[tool]?.[0] ?? "").split("/"));
        return {
            id: p.id, label: p.label, description: p.description, tags: p.tags, homepage: p.homepage,
            installed: isPackInstalled(p.id) || Boolean(packAssetsDir(p.id)),
            enabled: isPackEnabled(p.id), version: installedPackVersion(p.id),
            tool, defaultAccount: getPackAccount(p.id, tool), resolvedAccount,
            resolvedState: accountTokenState(tool, resolvedAccount), accounts,
            contextReady: tool === "claude" ? hasUsableToken(ctxCred) : existsSync(ctxCred),
        };
    });
}

/**
 * Launch a pack's isolated agent: fetch the bundle if needed, deploy it into the context dir,
 * seed the chosen account's credentials, then spawn the tool pointed at that context. `account`
 * resolution: explicit > the pack's pinned default > the active profile / tool-active account.
 * Resolves with the tool's exit code (returns 1 with a message on any setup problem).
 */
/**
 * Prepare a pack's isolated context for a given tool WITHOUT launching it, and return the
 * context directory. Mirrors launchPack's setup (resolve the seed account, fetch + enable the
 * pack, deploy its harness, seed credentials, reconcile the session) so a caller can spawn the
 * agent itself with the context dir - used by the local API server to serve requests inside a
 * pack (e.g. Helio). Throws on any unrecoverable error. `account` overrides the pack default.
 */
export function ensurePackContext(id: string, tool: string = acct.DEFAULT_TOOL, account?: string): string {
    const pack = getPack(id);
    if (!pack) throw new Error(`Unknown agent '${id}'.`);
    if (!acct.isToolName(tool)) throw new Error(`Unknown tool '${tool}'.`);
    const seedAccount = resolvePackAccount(id, tool, account);
    if (!ensurePackInstalled(id)) throw new Error(`Could not fetch ${pack.label} (${pack.pkg}). Check your network and npm.`);
    if (!isPackEnabled(id)) enablePack(id);
    if (!isPackEngineReady(id)) throw new Error(`The ${pack.label} engine is not installed. Run: enigma agent setup ${id}`);
    const dir = deployPack(id, tool);
    if (!dir) throw new Error(`${pack.label} assets are missing.`);
    seedCredentials(id, tool, seedAccount);
    reconcilePackSession(id, tool, seedAccount);
    return dir;
}

export async function launchPack(id: string, tool: string = acct.DEFAULT_TOOL, passthrough: string[] = [], account?: string): Promise<number> {
    const pack = getPack(id);
    if (!pack) { process.stderr.write(`Unknown agent '${id}'.\n`); return 1; }
    if (!acct.isToolName(tool)) { process.stderr.write(`Unknown tool '${tool}'.\n`); return 1; }
    let seedAccount: string;
    try { seedAccount = resolvePackAccount(id, tool, account); }
    catch (e) { process.stderr.write(`${(e as Error).message}\n`); return 1; }
    if (!ensurePackInstalled(id)) {
        process.stderr.write(`Could not fetch ${pack.label} (${pack.pkg}). Check your network and npm.\n`);
        return 1;
    }
    if (!isPackEnabled(id)) enablePack(id);
    preparePackEngine(id);
    const dir = deployPack(id, tool);
    if (!dir) { process.stderr.write(`${pack.label} assets are missing.\n`); return 1; }
    // Note (don't block) when there is no copyable token for the chosen account: the agent may
    // ask to log in once inside the isolated context. This is expected when the account's real
    // token lives in the OS keychain rather than a file (e.g. Claude Code on Windows) - it is NOT
    // necessarily "signed out". A one-time sign-in is remembered by the context afterwards.
    const ctxFresh = hasUsableToken(join(dir, ...(CRED_FILES[tool]?.[0] ?? "").split("/")));
    const srcState = accountTokenState(tool, seedAccount);
    if (!ctxFresh && srcState !== "ok") {
        const valid = acct.listAccounts(tool).find((a) => a.name !== seedAccount && accountTokenState(tool, a.name) === "ok");
        const lines = [
            `Note: no saved token could be copied for '${seedAccount}', so ${pack.label} may ask you to log in once.`,
            "  If it does, sign in inside the agent (/login) - the isolated context remembers it next time.",
        ];
        if (valid) lines.push(`  Or seed from an account that has a file-based login:  enigma agent use ${id} ${valid.name}`);
        lines.push("");
        process.stderr.write(lines.join("\n"));
    }
    seedCredentials(id, tool, seedAccount);
    // Reuse ONE session: before launch, converge the context and the managed account on the
    // fresher token (seed it in, or heal a blanked/stale account from the still-live context).
    reconcilePackSession(id, tool, seedAccount);
    process.stdout.write(`Launching ${pack.label} (${tool}) with account '${seedAccount}' in an isolated context.\n`);
    const code = await acct.launchInDir(tool, dir, passthrough);
    // After exit, propagate any token the pack refreshed during the session back to the managed
    // account, so the next `enigma claude ${seedAccount}` reuses the live session, not a stale copy.
    if (tool === "claude" && seedAccount !== acct.DEFAULT_NAME) {
        try { copyIfFresher(dir, acct.resolveConfigDir(tool, seedAccount)); } catch { /* best-effort */ }
    }
    return code;
}

/** Claude OAuth token state for an account's stored credentials: ok | expired | empty | absent. */
export function accountTokenState(tool: string, account: string): "ok" | "expired" | "empty" | "absent" {
    if (tool !== "claude") return "ok"; // only Claude's token freshness is inspected today
    const rel = CRED_FILES[tool]?.[0];
    if (!rel) return "ok";
    try { return tokenState(join(acct.resolveConfigDir(tool, account), ...rel.split("/"))); }
    catch { return "absent"; }
}
