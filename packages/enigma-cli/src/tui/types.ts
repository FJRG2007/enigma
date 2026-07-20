/**
 * Shared hub/TUI contract. These types are framework-agnostic and live here so the
 * renderer (src/tui/opentui.ts) and the callers that build a HubContext (cli.ts,
 * src/settings.ts) depend on a neutral module rather than on a specific renderer.
 */

import type { Scope } from "../settings-registry";

/** A skill-install, git-hook, or fix-path action requested from its right-panel checklist. */
export interface ActionRequest {
    action: "skills" | "security" | "fix-path";
    scope?: Scope;
    /** Selected agent names (skills) or tool names (fix-path). */
    agents?: string[];
    protections?: string[];
}

/** The outcome of a hub action, rendered inline in the native result panel. */
export interface ActionResult {
    ok: boolean;
    title: string;
    lines: string[];
}

/** Minimal agent/protection shapes the hub needs (passed in to avoid heavy imports). */
export interface HubAgent { name: string; label: string; installed: boolean; }
export interface HubProtection { value: string; label: string; hint: string; }
/**
 * A skill row in the install panel's SKILLS section; discarded = never installed/updated.
 * agentsOff lists the agent names the skill is turned off for (the per-agent opt-out), so the
 * hub can enable/disable a skill app-by-app on top of the global discard.
 */
export interface HubSkill { name: string; version: string | null; discarded: boolean; agentsOff: string[]; }
/** A provider override (e.g. MiniMax) on an account, token never included. */
export interface HubProvider { baseUrl: string; model?: string; preset?: string; hasToken: boolean; }
/** A built-in provider preset offered in the hub's provider editor. */
export interface HubPreset { id: string; label: string; tool: string; baseUrl: string; model?: string; tokenUrl?: string; }
/** A tool account row shown in the hub's Accounts panel. */
export interface HubAccount {
    tool: string;
    toolLabel: string;
    name: string;
    dir: string;
    email?: string;
    active: boolean;
    removable: boolean;
    /** Whether this tool supports a provider override (drives the 'p' key + display). */
    supportsProvider?: boolean;
    /** The active provider override, or null/undefined for the tool's default backend. */
    provider?: HubProvider | null;
}
/** A launchable tool, for the add-account tool selector. */
export interface HubTool { name: string; label: string; }
/** A profile row shown in the hub's Profiles panel. */
export interface HubProfile {
    name: string;
    active: boolean;
    /** Human summary of the tool->account mappings, e.g. "claude=work  codex=acme". */
    summary: string;
}
/**
 * A follow-up the hub asks its caller to perform after the TUI tears down, because
 * each needs the terminal the TUI owns: connecting runs the tool's own login flow;
 * updating runs npm to replace the running binary. The hub exits with this and
 * cli.ts runs it.
 */
export type HubExitAction =
    | { type: "connect"; tool: string; account: string }
    | { type: "ssh-connect"; alias: string; tunnel: boolean }
    | { type: "update" };
export interface HubContext {
    agents: HubAgent[];
    protections: HubProtection[];
    runAction: (req: ActionRequest) => Promise<ActionResult>;
    /** All known skills for the install panel's SKILLS section (discarded included). */
    skills?: HubSkill[];
    /** Discard (remove everywhere + skip future installs/updates) or restore a skill. */
    setSkillDiscarded?: (name: string, discarded: boolean) => HubSkill[];
    /** Turn a skill on/off for ONE agent (per-app opt-out); returns the refreshed list. */
    setSkillAgent?: (name: string, agent: string, off: boolean) => HubSkill[];
    /** True when no agent has a skills deployment yet, so the hub guides first-time setup. */
    firstRun?: boolean;
    /** Present when a newer enigma-cli is available, so the hub can offer "update now". */
    update?: { current: string; latest: string };
    /** Tool accounts and the operations the panel can perform without spawning. */
    accounts?: HubAccount[];
    activateAccount?: (tool: string, name: string) => HubAccount[];
    removeAccount?: (tool: string, name: string) => HubAccount[];
    /**
     * Create an account from the panel. Returns the refreshed list plus a
     * validation result so the renderer can show inline errors (bad/duplicate
     * name) without importing the data layer.
     */
    addAccount?: (tool: string, name: string) => { ok: boolean; error?: string; accounts: HubAccount[] };
    /** Rename an account (its config dir moves with it); errors come back inline. */
    renameAccount?: (tool: string, oldName: string, newName: string) => { ok: boolean; error?: string; accounts: HubAccount[] };
    /** Built-in provider presets (e.g. MiniMax) the provider editor offers. */
    providerPresets?: HubPreset[];
    /**
     * Set (object) or clear (null) an account's provider override. An omitted token keeps the
     * stored one; "" clears it. Returns the refreshed list + an inline validation result.
     */
    setAccountProvider?: (tool: string, name: string, input: { baseUrl: string; model?: string; preset?: string; token?: string } | null) => { ok: boolean; error?: string; accounts: HubAccount[] };
    /** Supported tools, for the add-account searchable selector. */
    tools?: HubTool[];
    /**
     * Per-tool launch-path status for the "Fix tool paths" action checklist: each
     * tool's name, label and a one-line status hint (on PATH / off PATH / not installed).
     */
    toolPaths?: Array<{ name: string; label: string; status: string }>;
    /** Profiles (one account per tool under a name) and activation; "" deactivates. */
    profiles?: HubProfile[];
    activateProfile?: (name: string) => HubProfile[];
    /** Create a profile; validation errors come back inline like addAccount. */
    addProfile?: (name: string) => { ok: boolean; error?: string; profiles: HubProfile[] };
    /** Rename a profile (mappings and active pointer follow); errors come back inline. */
    renameProfile?: (oldName: string, newName: string) => { ok: boolean; error?: string; profiles: HubProfile[] };
    /** Delete a profile (its accounts are kept). */
    removeProfile?: (name: string) => HubProfile[];
    /** Pin a tool's account inside a profile, or unpin it with null. */
    setProfileAccount?: (profile: string, tool: string, account: string | null) => { ok: boolean; error?: string; profiles: HubProfile[] };
}
