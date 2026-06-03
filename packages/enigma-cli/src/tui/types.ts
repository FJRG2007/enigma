/**
 * Shared hub/TUI contract. These types are framework-agnostic and live here so the
 * renderer (src/tui/opentui.ts) and the callers that build a HubContext (cli.ts,
 * src/settings.ts) depend on a neutral module rather than on a specific renderer.
 */

import type { Scope } from "../settings-registry";

/** A skill-install or git-hook action requested from its right-panel checklist. */
export interface ActionRequest {
    action: "skills" | "security";
    scope?: Scope;
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
/** A tool account row shown in the hub's Accounts panel. */
export interface HubAccount {
    tool: string;
    toolLabel: string;
    name: string;
    dir: string;
    email?: string;
    active: boolean;
    removable: boolean;
}
/**
 * A follow-up the hub asks its caller to perform after the TUI tears down, because
 * each needs the terminal the TUI owns: connecting runs the tool's own login flow;
 * updating runs npm to replace the running binary. The hub exits with this and
 * cli.ts runs it.
 */
export type HubExitAction =
    | { type: "connect"; tool: string; account: string }
    | { type: "update" };
export interface HubContext {
    agents: HubAgent[];
    protections: HubProtection[];
    runAction: (req: ActionRequest) => Promise<ActionResult>;
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
}
