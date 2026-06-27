/**
 * Deploy or remove the experimental `/gate` slash command in each managed agent's
 * command dir, gated by the `gate` toggle. This is the verbatim-file-copy twin of
 * mcp-deploy's applyCompressToggle: toggling `enigma config gate on/off` takes
 * effect immediately on already-deployed agents, without re-running `enigma install`.
 *
 * Kept self-contained (agents.ts + config + fs only, never skills.ts) so the
 * settings registry that calls it stays cheap to load - same constraint that put
 * applyCompressToggle in the light mcp-deploy module.
 */

import { AGENTS } from "./agents";
import { readConfig } from "./config";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

type Scope = "global" | "local";

const __dirname = dirname(fileURLToPath(import.meta.url));
// gate.md ships under assets/commands; the launcher points ENIGMA_ASSETS_DIR at the
// real assets in the compiled binary, with the package path as the dev/tsx fallback
// (mirrors skills.ts ASSETS resolution - duplicated here to avoid importing skills.ts).
const ASSETS = process.env.ENIGMA_ASSETS_DIR ?? join(resolve(__dirname, ".."), "assets");
const GATE_SRC = join(ASSETS, "commands", "gate.md");
const GATE_FILE = "gate.md";

/**
 * Apply the `gate` toggle's command side effect across managed agents at `scope`.
 * Mirrors presence AND absence: an ENABLE writes gate.md only into a command dir
 * that already exists (so it never creates command dirs for a tool the user does
 * not use, matching applyCompressToggle's existsSync guard); a DISABLE removes a
 * deployed gate.md. Returns the agent names whose command dir changed.
 */
export function applyGateToggle(scope: Scope): string[] {
    const enabled = readConfig().config.gate;
    const src = existsSync(GATE_SRC) ? readFileSync(GATE_SRC, "utf8") : null;
    const changed: string[] = [];
    for (const [name, def] of Object.entries(AGENTS)) {
        const dir = def.targets[scope]?.commands;
        if (!dir) continue;
        const dest = join(dir, GATE_FILE);
        if (enabled) {
            if (!src || !existsSync(dir)) continue; // never create a command dir for an unused tool
            if (existsSync(dest) && readFileSync(dest, "utf8") === src) continue;
            mkdirSync(dir, { recursive: true });
            writeFileSync(dest, src);
            changed.push(name);
        } else if (existsSync(dest)) {
            rmSync(dest, { force: true });
            changed.push(name);
        }
    }
    return changed;
}
