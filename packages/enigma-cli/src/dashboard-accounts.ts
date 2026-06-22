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

import {
    DEFAULT_NAME, TOOL_NAMES, getTool, listAccounts, listProfiles,
    setActive, addAccount, renameAccount, removeAccount,
    setActiveProfile, addProfile, renameProfile, removeProfile, setProfileAccount, unsetProfileAccount,
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
    /** True when the account has a signed-in identity; false = needs `enigma <tool> <name>` to log in. */
    loggedIn: boolean;
}

export interface DashProfile {
    name: string;
    active: boolean;
    accounts: Record<string, string>;
    summary: string;
}

export interface AccountsPayload {
    tools: Array<{ name: string; label: string }>;
    accounts: DashAccount[];
    profiles: DashProfile[];
}

/** Snapshot every tool's accounts and all profiles for the browser. */
export function serializeAccounts(): AccountsPayload {
    const accounts: DashAccount[] = TOOL_NAMES.flatMap((tool) =>
        listAccounts(tool).map((a) => ({
            tool, toolLabel: a.toolLabel, name: a.name, dir: a.dir,
            email: a.email ?? a.displayName,
            active: a.active, removable: a.name !== DEFAULT_NAME,
            loggedIn: Boolean(a.email ?? a.displayName),
        })));
    const profiles: DashProfile[] = listProfiles().map((p) => ({
        name: p.name, active: p.active, accounts: p.accounts,
        summary: Object.entries(p.accounts).map(([t, a]) => `${t}=${a}`).join("  ") || "(no accounts pinned)",
    }));
    return { tools: TOOL_NAMES.map((t) => ({ name: t, label: getTool(t).label })), accounts, profiles };
}

export interface AccountActionResult { ok: boolean; error?: string; data: AccountsPayload; }

/** One serializable mutation payload from the browser. All fields optional; validated per op. */
export interface AccountActionPayload {
    tool?: string;
    name?: string;
    newName?: string;
    profile?: string;
    account?: string | null;
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
