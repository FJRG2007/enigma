/**
 * Bridge exposing the marketplace packs to the dashboard Packs subpage and dispatching its
 * actions. The pack lifecycle (fetch, enable, deploy, MCP setup) lives in packs.ts; this is the
 * thin shaping + action layer the loopback server calls.
 *
 * dashboard.ts imports this DYNAMICALLY (only when the Packs subpage is used), so there is no
 * static import cycle. Launching a pack needs the terminal (it spawns the agent), so the browser
 * cannot do it - the "launch" action returns the command for the UI to show instead.
 */

import * as packsMod from "./packs";
import { DEFAULT_TOOL } from "./accounts";

/** Marketplace listing of every pack with its install/enable state. */
export function listPacksForDashboard(): packsMod.PackView[] {
    return packsMod.listPacks();
}

export interface PackActionResult {
    ok: boolean;
    error?: string;
    note?: string;
    /** Set by "launch": the shell command the user runs to start the pack (browser cannot spawn). */
    command?: string;
    /** The refreshed list after a mutating action. */
    packs?: packsMod.PackView[];
}

/**
 * Dispatch a Packs-subpage action. Mutating actions return the refreshed list. Never throws.
 *  - install : fetch the pack bundle and add it to the marketplace selection.
 *  - remove  : delete the pack and its isolated context.
 *  - update  : refresh the pack to the latest version.
 *  - setup       : register the pack's MCP servers into the isolated context.
 *  - set-account : pin which account seeds the pack (value = account name, or "" to clear).
 *  - launch      : return the command to run (the browser cannot spawn an agent).
 */
export async function applyPackAction(id: string, action: string, value?: string): Promise<PackActionResult> {
    const pack = packsMod.getPack(id);
    if (!pack) return { ok: false, error: `unknown pack: ${id}` };
    const list = (): packsMod.PackView[] => packsMod.listPacks();
    switch (action) {
        case "install":
            if (!packsMod.ensurePackInstalled(id)) return { ok: false, error: "could not fetch the pack (network or npm)" };
            packsMod.enablePack(id);
            return { ok: true, note: `${pack.label} added. Launch it with: enigma ${id}`, packs: list() };
        case "remove":
            packsMod.disablePack(id);
            return { ok: true, note: `${pack.label} removed.`, packs: list() };
        case "update": {
            const changed = packsMod.refreshPack(id);
            return { ok: true, note: changed ? `${pack.label} updated to ${packsMod.installedPackVersion(id)}.` : `${pack.label} is up to date.`, packs: list() };
        }
        case "setup": {
            const added = packsMod.setupPackMcp(id, DEFAULT_TOOL);
            return { ok: true, note: added.length ? `Registered MCP: ${added.join(", ")} (needs Python 3).` : "No MCP servers registered.", packs: list() };
        }
        case "set-account": {
            try { packsMod.setPackDefaultAccount(id, DEFAULT_TOOL, value ? value : null); }
            catch (e) { return { ok: false, error: (e as Error).message }; }
            return { ok: true, note: value ? `${pack.label} will seed with account '${value}'.` : `${pack.label} follows the active account.`, packs: list() };
        }
        case "launch":
            return { ok: true, command: `enigma ${id}`, note: `Run "enigma ${id}" in a terminal to launch the isolated ${pack.label} agent.` };
        default:
            return { ok: false, error: `unknown action: ${action}` };
    }
}
