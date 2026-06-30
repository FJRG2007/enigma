/**
 * Bridge exposing the marketplace packs to the dashboard Packs subpage and dispatching its
 * actions. The pack lifecycle (fetch, enable, deploy, MCP setup) lives in packs.ts; this is the
 * thin shaping + action layer the loopback server calls.
 *
 * dashboard.ts imports this DYNAMICALLY (only when the Packs subpage is used), so there is no
 * static import cycle. Launching a pack needs the terminal (it spawns the agent), so the browser
 * cannot do it - the "launch" action returns the command for the UI to show instead.
 */

import { DEFAULT_TOOL } from "./accounts";
import {
    listPacks, getPack, ensurePackInstalled, disablePack, enablePack, refreshPack,
    installedPackVersion, setupPackMcp, type PackView,
} from "./packs";

/** Marketplace listing of every pack with its install/enable state. */
export function listPacksForDashboard(): PackView[] {
    return listPacks();
}

export interface PackActionResult {
    ok: boolean;
    error?: string;
    note?: string;
    /** Set by "launch": the shell command the user runs to start the pack (browser cannot spawn). */
    command?: string;
    /** The refreshed list after a mutating action. */
    packs?: PackView[];
}

/**
 * Dispatch a Packs-subpage action. Mutating actions return the refreshed list. Never throws.
 *  - install : fetch the pack bundle and add it to the marketplace selection.
 *  - remove  : delete the pack and its isolated context.
 *  - update  : refresh the pack to the latest version.
 *  - setup   : register the pack's MCP servers into the isolated context.
 *  - launch  : return the command to run (the browser cannot spawn an agent).
 */
export async function applyPackAction(id: string, action: string): Promise<PackActionResult> {
    const pack = getPack(id);
    if (!pack) return { ok: false, error: `unknown pack: ${id}` };
    const list = (): PackView[] => listPacks();
    switch (action) {
        case "install":
            if (!ensurePackInstalled(id)) return { ok: false, error: "could not fetch the pack (network or npm)" };
            enablePack(id);
            return { ok: true, note: `${pack.label} added. Launch it with: enigma ${id}`, packs: list() };
        case "remove":
            disablePack(id);
            return { ok: true, note: `${pack.label} removed.`, packs: list() };
        case "update": {
            const changed = refreshPack(id);
            return { ok: true, note: changed ? `${pack.label} updated to ${installedPackVersion(id)}.` : `${pack.label} is up to date.`, packs: list() };
        }
        case "setup": {
            const added = setupPackMcp(id, DEFAULT_TOOL);
            return { ok: true, note: added.length ? `Registered MCP: ${added.join(", ")} (needs Python 3).` : "No MCP servers registered.", packs: list() };
        }
        case "launch":
            return { ok: true, command: `enigma ${id}`, note: `Run "enigma ${id}" in a terminal to launch the isolated ${pack.label} agent.` };
        default:
            return { ok: false, error: `unknown action: ${action}` };
    }
}
