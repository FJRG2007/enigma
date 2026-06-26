/**
 * Agent backend factory: maps a resolved `cfg.agent` selector to a concrete
 * backend (claude/codex/rovodev/opencode/pi, or acpx for `acp:<target>`).
 *
 * Faithful 1:1 port of the Go `internal/agent` factory section (`New`,
 * `NewWithOptions`, `acpTarget`). Like the Go original, this returns the RAW
 * backend; worktree steering (`withSteering`) is applied by the run manager in
 * `startRun`, exactly where Go wraps it - never here.
 *
 * Divergences (intentional):
 * - The Go `New`/`NewWithOptions` take `(name, bin, extraArgs, opts)`; here the
 *   per-backend `createX` constructors already derive the binary path and extra
 *   args from `cfg` (via `agentPath`/`agentArgs`), so `createAgent` takes `cfg`
 *   plus `paths` (opencode/rovodev need it) and dispatches by `cfg.agent`.
 * - `exec.LookPath` (used by `resolveAgent`) is ported as the self-contained
 *   `lookPath` below, returning the resolved absolute path or throwing an
 *   ENOENT-coded error, matching the `(bin) => Promise<string>` contract.
 */

import { createPi } from "./pi";
import { createAcpx } from "./acpx";
import type { Paths } from "../paths";
import { createCodex } from "./codex";
import { createClaude } from "./claude";
import type { Config } from "../config";
import { createRovodev } from "./rovodev";
import { join, delimiter } from "node:path";
import { createOpencode } from "./opencode";
import { type Agent, type Options } from "./agent";
import { statSync, accessSync, constants } from "node:fs";
import {
    AGENT_PI,
    AGENT_CODEX,
    AGENT_CLAUDE,
    AGENT_ROVODEV,
    AGENT_OPENCODE
} from "../types";

/**
 * Extracts the target from a well-formed `acp:<target>` selector, or null when
 * `name` is not an acp selector. Mirrors the Go `acpTarget`: the target must be
 * non-empty and contain no whitespace.
 */
export function acpTarget(name: string): string | null {
    if (!name.startsWith("acp:")) return null;
    const target = name.slice("acp:".length);
    if (target === "" || /[ \t\r\n]/.test(target)) return null;
    return target;
}

/**
 * Creates an agent backend by name with backend-specific options. ACP selectors
 * (`acp:<target>`) build an acpx backend, optionally driven by a raw ACP command
 * from `opts.acpRegistryOverrides`; native names build their CLI backend. Throws
 * on an unknown selector. The result is NOT steered - callers apply
 * `withSteering` exactly where the Go `startRun` does.
 */
export function createAgent(cfg: Config, paths: Paths, opts: Options = {}): Agent {
    const target = acpTarget(cfg.agent);
    if (target !== null) return createAcpx(cfg, target, opts);
    switch (cfg.agent) {
        case AGENT_CLAUDE:
            return createClaude(cfg, opts);
        case AGENT_CODEX:
            return createCodex(cfg, opts);
        case AGENT_ROVODEV:
            return createRovodev(cfg, paths, opts);
        case AGENT_OPENCODE:
            return createOpencode(cfg, paths, opts);
        case AGENT_PI:
            return createPi(cfg, opts);
        default:
            throw new Error(
                `unknown agent "${cfg.agent}"; valid options: auto, claude, codex, rovodev, opencode, pi, acp:<target> (set 'agent' in ~/.enigma/gate/config.yaml)`
            );
    }
}

/**
 * Resolves a binary name to an absolute path on PATH, the port's equivalent of
 * Go's `exec.LookPath` (fed to `resolveAgent`). Resolves with the path on
 * success; rejects with an ENOENT-coded error when no executable is found, so
 * `resolveAgent` can distinguish "not installed" from a real failure.
 */
export function lookPath(bin: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const found = lookPathSync(bin);
        if (found !== null) {
            resolve(found);
            return;
        }
        const err = new Error(`exec: "${bin}": executable file not found in $PATH`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        reject(err);
    });
}

/** Synchronous PATH/PATHEXT lookup mirroring Go's `exec.LookPath` resolution. */
function lookPathSync(bin: string): string | null {
    const win = process.platform === "win32";
    if (bin.includes("/") || (win && bin.includes("\\"))) {
        return usableExecutable(bin, win) ? bin : null;
    }
    const pathEnv = process.env.PATH ?? "";
    const exts = win ? windowsExts() : [""];
    for (const dir of pathEnv.split(delimiter)) {
        if (dir === "") continue;
        for (const ext of exts) {
            const candidate = join(dir, bin + ext);
            if (usableExecutable(candidate, win)) return candidate;
        }
    }
    return null;
}

/** Reports whether `path` is a regular file the OS treats as executable. */
function usableExecutable(path: string, win: boolean): boolean {
    let isFile: boolean;
    try {
        isFile = statSync(path).isFile();
    } catch {
        return false;
    }
    if (!isFile) return false;
    if (win) return true; // executability on Windows is by extension (PATHEXT)
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Lower-cased PATHEXT extensions (with a leading dot), defaulting like Windows. */
function windowsExts(): string[] {
    const raw = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    const exts = raw
        .split(";")
        .map(e => e.trim().toLowerCase())
        .filter(e => e !== "");
    return exts.length > 0 ? exts : [".com", ".exe", ".bat", ".cmd"];
}
