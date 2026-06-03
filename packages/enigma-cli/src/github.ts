/**
 * GitHub CLI (gh) specific configuration. Disables gh's usage telemetry by
 * default at install time: a privacy win with zero functional cost (telemetry is
 * pure usage analytics - no gh feature depends on it), and it also sidesteps a
 * known Windows bug where the detached `gh send-telemetry` subprocess spawns
 * `tzutil.exe` without window suppression, flashing a terminal window on every
 * gh invocation (https://github.com/cli/cli/issues/13354).
 *
 * Reads/writes go through `gh config` itself rather than parsing gh's YAML, so
 * enigma stays agnostic to gh's config location (~/.config/gh vs %AppData%) and
 * key validation. gh's config is user-global only - there is no per-repo form.
 */

import { spawnSync } from "node:child_process";
import { resolveBin } from "./util";

/** Run `gh config <args>` and return trimmed stdout, or null when gh is unusable. */
function ghConfig(args: string[]): string | null {
    const bin = process.env.ENIGMA_GH_BIN || resolveBin("gh");
    if (!bin) return null;
    try {
        const r = spawnSync(bin, ["config", ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
        if (r.status !== 0) return null;
        return (r.stdout || "").trim();
    } catch {
        return null;
    }
}

/** Is the GitHub CLI installed (resolvable on PATH)? */
export function hasGhCli(): boolean {
    return Boolean(process.env.ENIGMA_GH_BIN || resolveBin("gh"));
}

/**
 * Whether gh telemetry is currently enabled. gh's default is enabled, so an
 * unset/unreadable value reads as true. Returns null when gh is not installed.
 */
export function getGhTelemetry(): boolean | null {
    if (!hasGhCli()) return null;
    const value = ghConfig(["get", "telemetry"]);
    return value !== "disabled";
}

/**
 * Enable or disable gh telemetry. Returns whether the value actually changed;
 * null when gh is not installed or too old to know the `telemetry` key (the
 * set command fails on unknown keys - treated as "nothing to do").
 */
export function setGhTelemetry(enabled: boolean): boolean | null {
    const current = getGhTelemetry();
    if (current === null || current === enabled) return current === null ? null : false;
    const result = ghConfig(["set", "telemetry", enabled ? "enabled" : "disabled"]);
    return result === null ? null : true;
}
