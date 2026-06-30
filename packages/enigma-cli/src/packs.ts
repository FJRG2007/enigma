/**
 * Packs: optional, isolated harness bundles installed from the marketplace.
 *
 * A pack (Helio is the first) ships skills, slash commands, sub-agents and MCP servers for a
 * focused domain - here, offensive security / bug bounty. Unlike enigma's policy skills, a pack
 * is NEVER deployed into the user's normal agent: it is fetched on demand as an asset-only npm
 * package (@enigmax/<pack>) into a managed dir, and deployed only into a DEDICATED, isolated
 * agent context dir. Launching `enigma helio` spawns the agent pointed at that context (via the
 * tool's config-dir env var, reusing accounts.ts), so the agent sees ONLY the pack's skills and
 * commands - the normal coding agent stays clean and unburdened.
 *
 * Credentials are seeded from the user's active account into the context dir, so the isolated
 * pack agent shares the login with no re-authentication.
 *
 * Delivery mirrors @enigmax/dashboard (dashboard-pkg.ts): a managed install dir, a best-effort
 * synchronous npm installer, and a runtime resolver that falls back to the dev workspace copy.
 */

import { homedir } from "node:os";
import { isDir, readJson } from "./util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { readConfig, setEnigmaValue, setPackAccount } from "./config";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import {
    DEFAULT_TOOL, accountExists, getTool, isToolName, launchInDir,
    listAccounts, resolveConfigDir, resolveLaunchAccount,
} from "./accounts";

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
    /** MCP servers the pack ships (registered into the context only by `enigma pack setup`). */
    mcp?: { name: string; relArgs: string[] }[];
}

/** Built-in pack catalog. Add a pack as one entry here; the rest is generic. */
export const PACKS: PackDef[] = [
    {
        id: "helio",
        label: "Helio",
        pkg: "@enigmax/helio",
        description: "Bug-bounty and offensive-security harness: recon, vuln hunting, web2/web3 audit, AD, cloud, triage and report writing. Runs in an isolated agent context so it never loads into your normal coding agent.",
        tags: ["bug-bounty", "security", "pentest", "web3"],
        homepage: "https://github.com/TPEOficial/helio",
        // Only self-contained Python servers are auto-registered. Helio's Burp client is a
        // separate Java server (needs Burp Suite + an API key); it stays config-only - see
        // the pack's mcp/burp-mcp-client/README for manual setup.
        mcp: [
            { name: "helio-hackerone", relArgs: ["mcp", "hackerone-mcp", "server.py"] },
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
        const v = (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: unknown }).version;
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
    if (!getPack(id)) throw new Error(`Unknown pack '${id}'.`);
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
    return name && accountExists(tool, name) ? name : null;
}

/**
 * Set (or clear, with null) the default account that seeds a pack's isolated context on a tool.
 * The account must exist for that tool (create one first with `enigma account add`). Clearing
 * makes the pack fall back to the active profile / tool-active account.
 */
export function setPackDefaultAccount(id: string, tool: string, account: string | null): void {
    if (!getPack(id)) throw new Error(`Unknown pack '${id}'.`);
    if (!isToolName(tool)) throw new Error(`Unknown tool '${tool}'.`);
    if (account !== null && !accountExists(tool, account)) {
        throw new Error(`No such ${tool} account: '${account}'. Create it first: enigma account add ${account}${tool === DEFAULT_TOOL ? "" : ` --tool ${tool}`}.`);
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
        if (!accountExists(tool, explicit)) {
            throw new Error(`No such ${tool} account: '${explicit}'. Create it first: enigma account add ${explicit}${tool === DEFAULT_TOOL ? "" : ` --tool ${tool}`}.`);
        }
        return explicit;
    }
    return getPackAccount(id, tool) ?? resolveLaunchAccount(tool);
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
        const file = join(getTool(tool).accountTarget(dir).memory, "settings.json");
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
 * Idempotent and version-gated - a re-deploy only runs when the installed pack version changed.
 * Returns the context dir, or null when the pack assets cannot be resolved.
 */
export function deployPack(id: string, tool: string): string | null {
    const assets = packAssetsDir(id);
    if (!assets) return null;
    const dir = contextDir(id, tool);
    ensurePackBypass(dir, tool); // always ensure (even when version-gated below), so existing contexts get it too
    const version = installedPackVersion(id) ?? "dev";
    try {
        if (existsSync(deployMarker(dir)) && readFileSync(deployMarker(dir), "utf8").trim() === version) return dir;
    } catch { /* re-deploy on a bad marker */ }

    const target = getTool(tool).accountTarget(dir);
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

const CRED_FILES: Record<string, string[]> = {
    claude: [".credentials.json"],
    codex: ["auth.json"],
    opencode: [join("xdg-data", "opencode", "auth.json")],
};

/** Whether a Claude credentials file already holds a usable OAuth token (non-empty access+refresh). */
function hasUsableToken(file: string): boolean {
    try {
        const t = (JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string } }).claudeAiOauth;
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
        const t = (JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } }).claudeAiOauth;
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
        const source = resolveConfigDir(tool, account);
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
            cpSync(from, to);
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
 * Register the pack's MCP servers into the isolated context (Claude Code config). Gated behind
 * `enigma pack setup` because the servers need Python + the pack's tooling; registering them
 * blindly would make the agent fail to start a server whose deps are missing. Returns the names
 * registered, or [] when nothing applies. Claude-only for now.
 */
export function setupPackMcp(id: string, tool: string): string[] {
    const pack = getPack(id);
    const assets = packAssetsDir(id);
    if (!pack?.mcp || !assets || tool !== "claude") return [];
    const dir = contextDir(id, tool);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, ".claude.json");
    const current = existsSync(file) ? (readJson<Record<string, unknown>>(file) ?? {}) : {};
    const servers = { ...(typeof current.mcpServers === "object" && current.mcpServers ? current.mcpServers as Record<string, unknown> : {}) };
    const added: string[] = [];
    const python = process.platform === "win32" ? "python" : "python3";
    for (const server of pack.mcp) {
        const script = join(assets, ...server.relArgs);
        if (!existsSync(script)) continue;
        servers[server.name] = { type: "stdio", command: python, args: [script] };
        added.push(server.name);
    }
    if (!added.length) return [];
    current.mcpServers = servers;
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
    return added;
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
    accounts: { name: string; label: string; state: "ok" | "expired" | "empty" | "absent" }[];
    /** Login state of the account that will seed the pack now (ok | expired | empty | absent). */
    resolvedState: "ok" | "expired" | "empty" | "absent";
    /** True when the isolated context ALREADY holds a usable token, so no login will be asked
     * even if the resolved account looks stale - suppresses a misleading "not signed in" warning. */
    contextReady: boolean;
}

/** Marketplace listing of every pack with its install/enable state and seeding account. */
export function listPacks(): PackView[] {
    return PACKS.map((p) => {
        const tool = DEFAULT_TOOL;
        const accounts = listAccounts(tool).map((a) => ({ name: a.name, label: a.email ?? a.displayName ?? a.name, state: accountTokenState(tool, a.name) }));
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
export async function launchPack(id: string, tool: string = DEFAULT_TOOL, passthrough: string[] = [], account?: string): Promise<number> {
    const pack = getPack(id);
    if (!pack) { process.stderr.write(`Unknown pack '${id}'.\n`); return 1; }
    if (!isToolName(tool)) { process.stderr.write(`Unknown tool '${tool}'.\n`); return 1; }
    let seedAccount: string;
    try { seedAccount = resolvePackAccount(id, tool, account); }
    catch (e) { process.stderr.write(`${(e as Error).message}\n`); return 1; }
    if (!ensurePackInstalled(id)) {
        process.stderr.write(`Could not fetch the ${pack.label} pack (${pack.pkg}). Check your network and npm.\n`);
        return 1;
    }
    if (!isPackEnabled(id)) enablePack(id);
    const dir = deployPack(id, tool);
    if (!dir) { process.stderr.write(`${pack.label} pack assets are missing.\n`); return 1; }
    // Note (don't block) when there is no copyable token for the chosen account: the agent may
    // ask to log in once inside the isolated context. This is expected when the account's real
    // token lives in the OS keychain rather than a file (e.g. Claude Code on Windows) - it is NOT
    // necessarily "signed out". A one-time sign-in is remembered by the context afterwards.
    const ctxFresh = hasUsableToken(join(dir, ...(CRED_FILES[tool]?.[0] ?? "").split("/")));
    const srcState = accountTokenState(tool, seedAccount);
    if (!ctxFresh && srcState !== "ok") {
        const valid = listAccounts(tool).find((a) => a.name !== seedAccount && accountTokenState(tool, a.name) === "ok");
        const lines = [
            `Note: no saved token could be copied for '${seedAccount}', so ${pack.label} may ask you to log in once.`,
            "  If it does, sign in inside the pack (/login) - the isolated context remembers it next time.",
        ];
        if (valid) lines.push(`  Or seed from an account that has a file-based login:  enigma pack use ${id} ${valid.name}`);
        lines.push("");
        process.stderr.write(lines.join("\n"));
    }
    seedCredentials(id, tool, seedAccount);
    process.stdout.write(`Launching ${pack.label} (${tool}) with account '${seedAccount}' in an isolated context.\n`);
    return launchInDir(tool, dir, passthrough);
}

/** Claude OAuth token state for an account's stored credentials: ok | expired | empty | absent. */
export function accountTokenState(tool: string, account: string): "ok" | "expired" | "empty" | "absent" {
    if (tool !== "claude") return "ok"; // only Claude's token freshness is inspected today
    const rel = CRED_FILES[tool]?.[0];
    if (!rel) return "ok";
    try { return tokenState(join(resolveConfigDir(tool, account), ...rel.split("/"))); }
    catch { return "absent"; }
}
