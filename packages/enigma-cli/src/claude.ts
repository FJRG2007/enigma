/**
 * Claude Code specific configuration. Currently: deterministically disable the
 * automatic "Co-Authored-By: Claude" commit trailer and the "Generated with
 * Claude Code" PR footer, so commits/PRs are attributed solely to the user.
 *
 * A skill rule only persuades the model; this writes the real settings.json knob
 * so the behavior is enforced regardless of what the model does.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { isDir, readJson } from "./util";

/** Settings file Claude Code reads for a given scope. */
function claudeSettingsPath(scope: "global" | "local"): string {
    return scope === "global"
        ? join(homedir(), ".claude", "settings.json")
        : join(process.cwd(), ".claude", "settings.json");
}

/**
 * Merge the attribution-disabling keys into Claude's settings.json without
 * clobbering other settings. Sets the current `attribution` object (commit/pr
 * empty) and the legacy `includeCoAuthoredBy: false` for older versions.
 * Returns true if the file was written (i.e. something changed).
 */
export function disableClaudeAttribution(scope: "global" | "local"): boolean {
    const path = claudeSettingsPath(scope);
    const current = readJson<Record<string, unknown>>(path) || {};

    const attribution = (typeof current.attribution === "object" && current.attribution !== null)
        ? current.attribution as Record<string, unknown>
        : {};

    const alreadyOff =
        attribution.commit === "" && attribution.pr === "" && current.includeCoAuthoredBy === false;
    if (alreadyOff) return false;

    const next = {
        ...current,
        attribution: { ...attribution, commit: "", pr: "" },
        includeCoAuthoredBy: false,
    };

    const dir = join(path, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
    return true;
}
