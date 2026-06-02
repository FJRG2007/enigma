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
export interface HubAccount { tool: string; name: string; dir: string; active: boolean; removable: boolean; }
/**
 * A follow-up the hub asks its caller to perform after the TUI tears down.
 * Connecting/logging in must run the tool's own login flow, which needs the
 * terminal the TUI owns - so the hub exits with this and cli.ts runs it.
 */
export type HubExitAction = { type: "connect"; tool: string; account: string };
export interface HubContext {
    agents: HubAgent[];
    protections: HubProtection[];
    runAction: (req: ActionRequest) => Promise<ActionResult>;
    /** Tool accounts and the operations the panel can perform without spawning. */
    accounts?: HubAccount[];
    activateAccount?: (tool: string, name: string) => HubAccount[];
    removeAccount?: (tool: string, name: string) => HubAccount[];
}
