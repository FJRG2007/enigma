/**
 * Bridge that exposes the SAME account/profile data layer the TUI hub uses (accounts.ts)
 * to the local dashboard's HTTP API, so a user can manage logins and profiles from the
 * browser instead of only the terminal. Pure data + apply layer: it serializes the current
 * accounts/profiles for rendering and applies one mutation, mirroring the hub callbacks in
 * cli.ts.
 *
 * One thing the browser CANNOT do is run a tool's interactive login (that needs the
 * terminal): the UI surfaces the command to run instead (`enigma <tool> <account>`).
 *
 * dashboard.ts imports this DYNAMICALLY (only when the Accounts panel is used), and the
 * one heavy dependency (skills.ts, to seed a freshly created account dir) is imported
 * lazily inside the add branch so the module stays cheap to load.
 */

import { accountTokenState, packSessionSources } from "./packs";
import { sessionState, sessionEmail, isUsableSession, transferSession, type SessionState } from "./claude-oauth";
import {
    DEFAULT_NAME, TOOL_NAMES, getTool, listAccounts, listProfiles, openLoginTerminal,
    setActive, addAccount, renameAccount, removeAccount, resolveConfigDir,
    setActiveProfile, addProfile, renameProfile, removeProfile, setProfileAccount, unsetProfileAccount,
    setAccountProvider, providerFromPreset, PROVIDER_PRESETS, type ProviderInput,
} from "./accounts";

export interface DashAccount {
    tool: string;
    toolLabel: string;
    name: string;
    dir: string;
    email?: string;
    active: boolean;
    /** False for a tool's built-in "default" account (cannot be renamed/removed). */
    removable: boolean;
    /** True when the account has a usable signed-in session (for Claude, a valid token - not just a cached email). */
    loggedIn: boolean;
    /** Claude login freshness: ok | expired | empty | absent. Undefined for tools without token inspection. */
    loginState?: "ok" | "expired" | "empty" | "absent";
    /** Whether this tool supports a provider override (drives the provider control's visibility). */
    supportsProvider: boolean;
    /** The active provider override (token never included), or null for the default backend. */
    provider: { baseUrl: string; model?: string; preset?: string; hasToken: boolean } | null;
}

/** A provider preset the browser can offer (no secrets). */
export interface DashPreset { id: string; label: string; tool: string; baseUrl: string; model?: string; tokenUrl?: string; }

export interface DashProfile {
    name: string;
    active: boolean;
    accounts: Record<string, string>;
    summary: string;
}

/**
 * A Claude config dir that holds a login and can seed another one WITHOUT a re-login (a managed
 * account, the default ~/.claude, or a pack context). The dashboard/CLI transfer a session by
 * copying one of these into a signed-out account. `usable` = ok | refreshable.
 */
export interface DashSessionSource {
    id: string;
    kind: "account" | "pack";
    tool: string;
    label: string;
    email?: string;
    state: SessionState;
    usable: boolean;
}

export interface AccountsPayload {
    tools: Array<{ name: string; label: string }>;
    accounts: DashAccount[];
    profiles: DashProfile[];
    /** Built-in provider presets the UI can offer (e.g. MiniMax), keyed by tool. */
    presets: DashPreset[];
    /** Claude sessions that can be copied into a signed-out account (reuse without re-login). */
    sessionSources: DashSessionSource[];
}

/**
 * Every Claude session that can seed another account without a re-login: each Claude account dir
 * plus every pack context that holds a credentials file. Claude-only - it is the one tool whose
 * OAuth session is a portable file (see claude-oauth.ts). Used by the "Transfer session" flow.
 */
export function serializeSessionSources(): DashSessionSource[] {
    if (!TOOL_NAMES.includes("claude")) return [];
    const sources: DashSessionSource[] = listAccounts("claude").map((a) => {
        const state = sessionState(a.dir);
        return { id: `account:${a.name}`, kind: "account" as const, tool: "claude", label: a.name, email: a.email ?? sessionEmail(a.dir), state, usable: isUsableSession(state) };
    });
    for (const s of packSessionSources("claude")) {
        const state = sessionState(s.dir);
        sources.push({ id: `pack:${s.id}`, kind: "pack", tool: "claude", label: `pack: ${s.label}`, email: sessionEmail(s.dir), state, usable: isUsableSession(state) });
    }
    return sources;
}

/** Resolve a session-source id ("account:<name>" | "pack:<id>") to its config dir, or null. */
function sessionSourceDir(id: string): string | null {
    if (id.startsWith("account:")) {
        try { return resolveConfigDir("claude", id.slice("account:".length)); } catch { return null; }
    }
    if (id.startsWith("pack:")) {
        return packSessionSources("claude").find((s) => s.id === id.slice("pack:".length))?.dir ?? null;
    }
    return null;
}

/** Snapshot every tool's accounts and all profiles for the browser. */
export function serializeAccounts(): AccountsPayload {
    const accounts: DashAccount[] = TOOL_NAMES.flatMap((tool) =>
        listAccounts(tool).map((a) => {
            // For Claude, "logged in" means a USABLE token, not just a cached email - so a stale
            // account (e.g. its token expired) is shown as such and can be re-authenticated.
            const loginState = tool === "claude" ? accountTokenState(tool, a.name) : undefined;
            const loggedIn = tool === "claude" ? loginState === "ok" : Boolean(a.email ?? a.displayName);
            return {
            tool, toolLabel: a.toolLabel, name: a.name, dir: a.dir,
            email: a.email ?? a.displayName,
            active: a.active, removable: a.name !== DEFAULT_NAME,
            loggedIn, loginState,
            supportsProvider: a.supportsProvider,
            provider: a.provider
                ? { baseUrl: a.provider.baseUrl, model: a.provider.model, preset: a.provider.preset, hasToken: a.provider.hasToken }
                : null,
            };
        }));
    const profiles: DashProfile[] = listProfiles().map((p) => ({
        name: p.name, active: p.active, accounts: p.accounts,
        summary: Object.entries(p.accounts).map(([t, a]) => `${t}=${a}`).join("  ") || "(no accounts pinned)",
    }));
    const presets: DashPreset[] = PROVIDER_PRESETS.map((p) => ({ id: p.id, label: p.label, tool: p.tool, baseUrl: p.baseUrl, model: p.model, tokenUrl: p.tokenUrl }));
    return { tools: TOOL_NAMES.map((t) => ({ name: t, label: getTool(t).label })), accounts, profiles, presets, sessionSources: serializeSessionSources() };
}

export interface AccountActionResult { ok: boolean; error?: string; note?: string; data: AccountsPayload; }

/** One serializable mutation payload from the browser. All fields optional; validated per op. */
export interface AccountActionPayload {
    tool?: string;
    name?: string;
    newName?: string;
    profile?: string;
    account?: string | null;
    /** account.provider: null clears the override; an object sets it (preset or custom base/model + token). */
    provider?: { preset?: string; baseUrl?: string; model?: string; token?: string } | null;
    /** account.transfer: id of the session source to copy from ("account:<name>" | "pack:<id>"). */
    source?: string;
}

/**
 * Apply one account/profile mutation, mirroring the hub's callbacks (cli.ts). Every op is
 * try/wrapped so a validation error (bad/duplicate name, unknown tool) comes back as
 * `{ ok:false, error }` with the refreshed snapshot, never a throw. A freshly created
 * account is seeded with skills/memory/settings exactly like the TUI add flow.
 */
export async function applyAccountAction(op: string, payload: AccountActionPayload): Promise<AccountActionResult> {
    const tool = typeof payload.tool === "string" ? payload.tool : "";
    const name = typeof payload.name === "string" ? payload.name : "";
    const newName = typeof payload.newName === "string" ? payload.newName : "";
    const profile = typeof payload.profile === "string" ? payload.profile : "";
    try {
        switch (op) {
            case "account.activate": setActive(tool, name); break;
            case "account.add": {
                const account = addAccount(tool, name);
                try { const { syncAccount } = await import("./skills"); syncAccount(tool, account.dir); }
                catch { /* seeded on first launch instead */ }
                break;
            }
            case "account.rename": renameAccount(tool, name, newName); break;
            case "account.remove": removeAccount(tool, name); break;
            case "account.login": {
                // Spawn the tool's interactive login in a new terminal window (the browser can't
                // host a TUI login). Falls back to telling the user the command when no terminal opens.
                const opened = openLoginTerminal(tool, name);
                const cmd = `enigma ${tool}${name === DEFAULT_NAME ? "" : ` ${name}`}`;
                return opened
                    ? { ok: true, note: `Opened a terminal to log in '${name}'. Complete /login there, then refresh.`, data: serializeAccounts() }
                    : { ok: false, error: `Could not open a terminal. Run this yourself:  ${cmd}`, data: serializeAccounts() };
            }
            case "account.transfer": {
                // Reuse a live login: copy a session (another account or a pack context) into this
                // account so it is signed in again without /login. Claude-only.
                if (tool !== "claude") throw new Error(`Session transfer is Claude-only (got '${tool}').`);
                const source = typeof payload.source === "string" ? payload.source : "";
                const sourceDir = sessionSourceDir(source);
                if (!sourceDir) throw new Error(`Unknown session source '${source}'.`);
                const targetDir = resolveConfigDir("claude", name);
                const res = transferSession(sourceDir, targetDir);
                if (!res.ok) return { ok: false, error: res.error || "transfer failed", data: serializeAccounts() };
                return { ok: true, note: `Session moved into '${name}'. It shares the login now - no re-login needed.`, data: serializeAccounts() };
            }
            case "account.provider": {
                const p = payload.provider;
                if (p === null || p === undefined) { setAccountProvider(tool, name, null); break; }
                let input: ProviderInput | null;
                if (p.preset) {
                    input = providerFromPreset(p.preset, p.token);
                    if (!input) throw new Error(`Unknown preset '${p.preset}'.`);
                    if (p.baseUrl) input.baseUrl = p.baseUrl;
                    if (p.model) input.model = p.model;
                } else {
                    input = { baseUrl: p.baseUrl || "", model: p.model, preset: "custom", token: p.token };
                }
                setAccountProvider(tool, name, input);
                break;
            }
            case "profile.activate": setActiveProfile(name || null); break;
            case "profile.add": addProfile(name); break;
            case "profile.rename": renameProfile(name, newName); break;
            case "profile.remove": removeProfile(name); break;
            case "profile.setAccount":
                if (payload.account === null || payload.account === "") unsetProfileAccount(profile, tool);
                else setProfileAccount(profile, tool, String(payload.account));
                break;
            default: return { ok: false, error: `unknown action: ${op}`, data: serializeAccounts() };
        }
        return { ok: true, data: serializeAccounts() };
    } catch (err) {
        return { ok: false, error: (err as Error).message, data: serializeAccounts() };
    }
}
