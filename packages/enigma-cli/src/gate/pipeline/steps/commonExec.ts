/**
 * Subprocess helpers for pipeline steps: custom-PATH binary resolution, git
 * invocations that honor the StepContext environment, provider-CLI probes, and
 * the shell runner. Faithful port of the no-mistakes
 * `internal/pipeline/steps/common_exec.go`.
 *
 * Go threaded `context.Context`; here the StepContext carries an `AbortSignal`.
 * Go's `*exec.Cmd` (used by the host CmdFactory and the git helpers) maps to the
 * `StepCmd` object below, exposing `run`/`output`/`combinedOutput` so the scm
 * host factories can wrap it. The long-lived shell runner
 * (`runShellCommandWithEnv`) routes through `spawnConfigured` for process-group
 * isolation + whole-tree kill on cancel, mirroring Go's ConfigureShellCommand.
 */

import { redactText } from "../../safeurl";
import type { StepContext } from "../types";
import { execFile } from "node:child_process";
import { statSync, type Stats } from "node:fs";
import { spawnConfigured } from "../../shellenv";
import { join, sep, extname, delimiter, isAbsolute } from "node:path";
import {
    type Provider,
    PROVIDER_GITHUB,
    PROVIDER_GITLAB,
    PROVIDER_BITBUCKET
} from "../../scm/host";

/** Cap on captured subprocess output; git diffs can be large, so generous. */
const MAX_BUFFER = 256 * 1024 * 1024;

/** Go's runtime.GOOS dialect ("windows"/"darwin"/"linux"). */
const GOOS = process.platform === "win32" ? "windows" : process.platform;

/** The subset of Go's `*exec.Cmd` the step helpers and scm hosts consume. */
export interface StepCmd {
    /** Runs and resolves to the failure Error or null on success (cmd.Run). */
    run(): Promise<Error | null>;
    /** Runs and resolves to stdout, stderr, and any failure Error (cmd.Output). */
    output(): Promise<{ stdout: string; stderr: string; err: Error | null }>;
    /** Runs and resolves to combined stdout+stderr plus any error (cmd.CombinedOutput). */
    combinedOutput(): Promise<{ out: string; err: Error | null }>;
}

/** Snapshot of the process environment as `KEY=value` entries (os.Environ). */
function processEnviron(): string[] {
    const env: string[] = [];
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        env.push(`${key}=${value}`);
    }
    return env;
}

/** Splits a PATH-style list on the OS list separator (filepath.SplitList). */
function splitPathList(value: string): string[] {
    if (value === "") return [];
    return value.split(delimiter);
}

export function envValue(env: string[], key: string): [string, boolean] {
    return envValueForOS(env, key, GOOS);
}

export function envValueForOS(env: string[], key: string, goos: string): [string, boolean] {
    const prefix = `${key}=`;
    for (const entry of env) {
        if (entry.startsWith(prefix)) return [entry.slice(prefix.length), true];
        if (
            goos === "windows" &&
            entry.length >= prefix.length &&
            entry.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
        ) {
            return [entry.slice(prefix.length), true];
        }
    }
    return ["", false];
}

function envKey(entry: string): string {
    const idx = entry.indexOf("=");
    const key = idx === -1 ? entry : entry.slice(0, idx);
    if (GOOS === "windows") return key.toUpperCase();
    return key;
}

/** Merges `extra` over the process environment; empty extra returns []. */
export function mergeEnv(extra: string[]): string[] {
    if (extra.length === 0) return [];
    const merged: string[] = [];
    const overrides = new Map<string, string>();
    for (const entry of extra) overrides.set(envKey(entry), entry);
    for (const entry of processEnviron()) {
        const key = envKey(entry);
        const override = overrides.get(key);
        if (override !== undefined) {
            merged.push(override);
            overrides.delete(key);
            continue;
        }
        merged.push(entry);
    }
    for (const entry of extra) {
        const key = envKey(entry);
        const override = overrides.get(key);
        if (override !== undefined) {
            merged.push(override);
            overrides.delete(key);
        }
    }
    return merged;
}

/** Converts `KEY=value` entries into a process-env object for spawn/execFile. */
function envArrayToObject(entries: string[]): NodeJS.ProcessEnv {
    const obj: NodeJS.ProcessEnv = {};
    for (const entry of entries) {
        const idx = entry.indexOf("=");
        if (idx === -1) {
            obj[entry] = "";
            continue;
        }
        obj[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return obj;
}

function executableCandidates(name: string, env: string[]): string[] {
    return executableCandidatesForOS(GOOS, name, env);
}

function executableCandidatesForOS(goos: string, name: string, env: string[]): string[] {
    const candidates = [name];
    if (goos !== "windows" || extname(name) !== "") return candidates;
    let pathExt = ".COM;.EXE;.BAT;.CMD";
    const [customPathExt, ok] = envValueForOS(env, "PATHEXT", goos);
    if (ok) pathExt = customPathExt;
    for (const raw of pathExt.split(";")) {
        const ext = raw.trim();
        if (ext === "") continue;
        candidates.push(name + ext);
    }
    return candidates;
}

function findInCustomPath(workDir: string, env: string[], name: string): string {
    const [customPath, ok] = envValue(env, "PATH");
    if (!ok) return "";
    for (let dir of splitPathList(customPath)) {
        if (dir === "") continue;
        if (!isAbsolute(dir)) dir = join(workDir, dir);
        for (const candidateName of executableCandidates(name, env)) {
            const candidate = join(dir, candidateName);
            let fi: Stats;
            try {
                fi = statSync(candidate);
            } catch {
                continue;
            }
            if (pathCandidateUsable(GOOS, candidate, fi)) return candidate;
        }
    }
    return "";
}

function pathCandidateUsable(goos: string, path: string, fi: Stats): boolean {
    if (fi.isDirectory()) return false;
    if (goos === "windows") return extname(path) !== "";
    return (fi.mode & 0o111) !== 0;
}

function missingFromCustomPath(env: string[], name: string): string {
    const [customPath, ok] = envValue(env, "PATH");
    if (!ok) return "";
    const missing = join(".", executableCandidates(name, env)[0]);
    for (const dir of splitPathList(customPath)) {
        if (dir.trim() === "") continue;
        return join(dir, executableCandidates(name, env)[0]);
    }
    return missing;
}

/** Builds the Go-style `exec: "name": executable file not found in $PATH` error. */
function notFoundError(name: string): Error {
    return new Error(`exec: "${name}": executable file not found in $PATH`);
}

function makeStepCmd(
    resolved: string,
    args: string[],
    cwd: string,
    envObj: NodeJS.ProcessEnv | undefined,
    signal: AbortSignal,
    presetErr: Error | null
): StepCmd {
    const exec = (): Promise<{ stdout: string; stderr: string; code: number; err: Error | null }> =>
        new Promise(resolvePromise => {
            execFile(
                resolved,
                args,
                { cwd, env: envObj, signal, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" },
                (err, stdout, stderr) => {
                    if (!err) {
                        resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code: 0, err: null });
                        return;
                    }
                    const e = err as NodeJS.ErrnoException;
                    if (e.code === "ENOENT") {
                        resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code: -1, err: notFoundError(resolved) });
                        return;
                    }
                    const code = typeof e.code === "number" ? e.code : 1;
                    resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code, err: new Error(`exit status ${code}`) });
                }
            );
        });
    return {
        run: async () => {
            if (presetErr !== null) return presetErr;
            return (await exec()).err;
        },
        output: async () => {
            if (presetErr !== null) return { stdout: "", stderr: "", err: presetErr };
            const r = await exec();
            return { stdout: r.stdout, stderr: r.stderr, err: r.err };
        },
        combinedOutput: async () => {
            if (presetErr !== null) return { out: "", err: presetErr };
            const r = await exec();
            return { out: r.stdout + r.stderr, err: r.err };
        }
    };
}

/**
 * Builds a StepCmd that inherits the StepContext's extra Env, if any. When
 * sctx.env overrides PATH, the binary is resolved from the overridden PATH so
 * tests can inject fake binaries without modifying the process environment.
 */
export function stepCmd(sctx: StepContext, name: string, ...args: string[]): StepCmd {
    let resolved = name;
    let missingFromPath = false;
    if (sctx.env.length > 0 && !name.includes(sep)) {
        const candidate = findInCustomPath(sctx.workDir, sctx.env, name);
        if (candidate !== "") {
            resolved = candidate;
        } else {
            const [, ok] = envValue(sctx.env, "PATH");
            if (ok) {
                resolved = missingFromCustomPath(sctx.env, name);
                missingFromPath = true;
            }
        }
    }
    const envObj = sctx.env.length > 0 ? envArrayToObject(mergeEnv(sctx.env)) : undefined;
    return makeStepCmd(resolved, args, sctx.workDir, envObj, sctx.signal, missingFromPath ? notFoundError(name) : null);
}

/**
 * Runs a git command using the StepContext's environment. Like git.run but
 * respects sctx.env so tests can inject a fake git binary. Throws on failure.
 */
export async function stepGitRun(sctx: StepContext, ...args: string[]): Promise<string> {
    const cmd = stepCmd(sctx, "git", ...args);
    const { stdout, stderr, err } = await cmd.output();
    if (err !== null) {
        throw new Error(`git ${redactText(args.join(" "))}: ${err.message}: ${redactText(stderr.trim())}`);
    }
    return stdout.trim();
}

export function stepGitHeadSHA(sctx: StepContext): Promise<string> {
    return stepGitRun(sctx, "rev-parse", "HEAD");
}

export async function stepGitLsRemote(sctx: StepContext, remote: string, ref: string): Promise<string> {
    const out = await stepGitRun(sctx, "ls-remote", remote, ref);
    if (out === "") return "";
    const parts = out.split(/\s+/).filter(part => part !== "");
    if (parts.length < 1) return "";
    return parts[0];
}

export async function stepGitPush(
    sctx: StepContext,
    remote: string,
    ref: string,
    expectedSHA: string,
    forceWithLease: boolean
): Promise<void> {
    const args = ["push", remote];
    if (forceWithLease) {
        if (expectedSHA !== "") {
            args.push(`--force-with-lease=${ref}:${expectedSHA}`);
        } else {
            args.push("--force-with-lease");
        }
    }
    args.push(`HEAD:${ref}`);
    await stepGitRun(sctx, ...args);
}

function providerCLIName(provider: Provider): string {
    switch (provider) {
        case PROVIDER_GITHUB:
            return "gh";
        case PROVIDER_GITLAB:
            return "glab";
        case PROVIDER_BITBUCKET:
            return "bb";
        default:
            return "";
    }
}

function providerAuthCheckCommand(provider: Provider): string[] {
    switch (provider) {
        case PROVIDER_GITHUB:
            return ["gh", "auth", "status"];
        case PROVIDER_GITLAB:
            return ["glab", "auth", "status"];
        case PROVIDER_BITBUCKET:
            return ["bb", "profile", "which"];
        default:
            return [];
    }
}

/** Reports whether the provider CLI binary resolves on the process PATH. */
function providerCLIAvailable(provider: Provider): boolean {
    const name = providerCLIName(provider);
    if (name === "") return false;
    return defaultLookPath(name);
}

/** Synchronous exec.LookPath equivalent over the process environment. */
function defaultLookPath(name: string): boolean {
    const env = processEnviron();
    if (name.includes(sep) || name.includes("/")) {
        try {
            return pathCandidateUsable(GOOS, name, statSync(name));
        } catch {
            return false;
        }
    }
    const [customPath, ok] = envValue(env, "PATH");
    if (!ok) return false;
    for (const dir of splitPathList(customPath)) {
        if (dir === "") continue;
        for (const candidateName of executableCandidates(name, env)) {
            const full = join(dir, candidateName);
            let fi: Stats;
            try {
                fi = statSync(full);
            } catch {
                continue;
            }
            if (pathCandidateUsable(GOOS, full, fi)) return true;
        }
    }
    return false;
}

/** Checks whether the provider CLI is available, respecting a custom PATH. */
export function stepCLIAvailable(sctx: StepContext, provider: Provider): boolean {
    const name = providerCLIName(provider);
    if (name === "") return false;
    if (sctx.env.length === 0) return providerCLIAvailable(provider);
    if (findInCustomPath(sctx.workDir, sctx.env, name) !== "") return true;
    const [, ok] = envValue(sctx.env, "PATH");
    if (ok) return false;
    return providerCLIAvailable(provider);
}

/** Checks whether the provider CLI is authenticated, resolving via sctx.env. */
export async function stepAuthConfigured(sctx: StepContext, provider: Provider): Promise<boolean> {
    const args = providerAuthCheckCommand(provider);
    if (args.length === 0) return false;
    const cmd = stepCmd(sctx, args[0], ...args.slice(1));
    return (await cmd.run()) === null;
}

/** Approximates Go's `%q` verb for the command strings used in error messages. */
function goQuote(s: string): string {
    return JSON.stringify(s);
}

/**
 * Executes a shell command and returns combined stdout+stderr plus the exit
 * code. A non-zero exit code is not an error - only a spawn failure throws.
 */
export function runShellCommand(signal: AbortSignal, dir: string, cmdStr: string): Promise<[string, number]> {
    return runShellCommandWithEnv(signal, dir, [], cmdStr);
}

export function runStepShellCommand(sctx: StepContext, cmdStr: string): Promise<[string, number]> {
    return runShellCommandWithEnv(sctx.signal, sctx.workDir, sctx.env, cmdStr);
}

export function runShellCommandWithEnv(
    signal: AbortSignal,
    dir: string,
    env: string[],
    cmdStr: string
): Promise<[string, number]> {
    const isWindows = process.platform === "win32";
    const command = isWindows ? "cmd.exe" : "sh";
    const cmdArgs = isWindows ? ["/c", cmdStr] : ["-c", cmdStr];
    const envObj = env.length > 0 ? envArrayToObject(mergeEnv(env)) : undefined;
    return new Promise((resolvePromise, reject) => {
        // Isolate the command in its own process group so that aborting the signal
        // kills the whole tree (e.g. npm -> node test workers), not just the shell
        // parent. Otherwise grandchildren survive and hold the worktree locked.
        const child = spawnConfigured(command, cmdArgs, { cwd: dir, env: envObj, signal });
        const chunks: Buffer[] = [];
        child.stdout?.on("data", (d: Buffer) => chunks.push(Buffer.from(d)));
        child.stderr?.on("data", (d: Buffer) => chunks.push(Buffer.from(d)));
        let settled = false;
        const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            fn();
        };
        child.on("error", err => settle(() => reject(new Error(`run command ${goQuote(cmdStr)}: ${err.message}`))));
        child.on("close", code =>
            settle(() => resolvePromise([Buffer.concat(chunks).toString("utf8"), code === null ? -1 : code]))
        );
    });
}
