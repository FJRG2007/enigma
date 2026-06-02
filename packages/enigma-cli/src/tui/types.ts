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
/** A Claude Code account row shown in the hub's Accounts panel. */
export interface HubAccount { name: string; dir: string; active: boolean; removable: boolean; }
export interface HubContext {
    agents: HubAgent[];
    protections: HubProtection[];
    runAction: (req: ActionRequest) => Promise<ActionResult>;
    /** Claude Code accounts and the operations the panel can perform without spawning. */
    accounts?: HubAccount[];
    activateAccount?: (name: string) => HubAccount[];
    removeAccount?: (name: string) => HubAccount[];
}
