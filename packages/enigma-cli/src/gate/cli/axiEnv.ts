/**
 * Shared resources for the axi command family: paths, the gate database, the
 * current repo, and an optional daemon connection. Faithful port of the
 * `openResources`/`findRepo`/`openAxiEnv` helpers from upstream's
 * `internal/cli/root.go` and `axi.go`.
 *
 * The daemon lifecycle (starting it on demand, checking liveness) is not part of
 * this subset, so it is injected through `AxiDaemon`; the wiring layer provides a
 * concrete implementation. Everything else is local-database backed and works
 * whether or not the daemon is running.
 */

import { Paths } from "../paths";
import type { AxiIO } from "./axiRender";
import type { Client } from "../ipc/client";
import { findGitRoot, findMainRepoRoot } from "../git";
import { Database, getRepoByPath, type Repo } from "../db";

/** Returns a string message for any thrown value. */
export function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Starts (if needed) and checks the gate daemon. Provided by the wiring layer. */
export interface AxiDaemon {
    ensureDaemon(p: Paths): Promise<void>;
    isDaemonRunning(p: Paths): Promise<boolean>;
}

/** Cross-cutting dependencies threaded through every axi command. */
export interface AxiDeps {
    io: AxiIO;
    daemon: AxiDaemon;
    signal?: AbortSignal;
    /** Overrides the resolved paths root (test hook). */
    paths?: Paths;
}

/** Resolved paths plus an open database. The caller must close the database. */
export interface AxiResources {
    p: Paths;
    d: Database;
}

/** The bundle of resources an axi subcommand operates on. */
export class AxiEnv {
    constructor(
        readonly p: Paths,
        readonly d: Database,
        readonly repo: Repo,
        readonly client: Client | null
    ) {}

    /** Closes the daemon connection (if any) and the database. */
    close(): void {
        this.client?.close();
        this.d.close();
    }
}

/** Resolves paths, ensures directories exist, and opens the database. */
export function openResources(deps: AxiDeps): AxiResources {
    let p: Paths;
    try {
        p = deps.paths ?? Paths.resolve();
    } catch (err) {
        throw new Error(`resolve paths: ${errMessage(err)}`);
    }
    try {
        p.ensureDirs();
    } catch (err) {
        throw new Error(`create directories: ${errMessage(err)}`);
    }
    let d: Database;
    try {
        d = new Database(p.db());
    } catch (err) {
        throw new Error(`open database: ${errMessage(err)}`);
    }
    return { p, d };
}

/**
 * Looks up the repo for the current directory, falling back to the main worktree
 * root so worktrees work when the main repo is already initialized.
 */
export function findRepo(d: Database): Repo {
    let gitRoot: string;
    try {
        gitRoot = findGitRoot(".");
    } catch {
        throw new Error("not in a git repository");
    }
    const repo = getRepoByPath(d, gitRoot);
    if (repo !== null) return repo;

    let mainRoot: string;
    try {
        mainRoot = findMainRepoRoot(".");
    } catch {
        throw new Error("repo not initialized (run 'enigma gate init' first)");
    }
    if (mainRoot === gitRoot) {
        throw new Error("repo not initialized (run 'enigma gate init' first)");
    }
    const mainRepo = getRepoByPath(d, mainRoot);
    if (mainRepo === null) {
        throw new Error("repo not initialized (run 'enigma gate init' first)");
    }
    return mainRepo;
}

/**
 * Opens the env: resolves paths, opens the DB, and finds the repo. When
 * ensureDaemonConn is set, also starts (if needed) and dials the daemon.
 */
export async function openAxiEnv(deps: AxiDeps, ensureDaemonConn: boolean): Promise<AxiEnv> {
    const { p, d } = openResources(deps);
    let repo: Repo;
    try {
        repo = findRepo(d);
    } catch (err) {
        d.close();
        throw err;
    }
    let client: Client | null = null;
    if (ensureDaemonConn) {
        try {
            await deps.daemon.ensureDaemon(p);
        } catch (err) {
            d.close();
            throw new Error(`start daemon: ${errMessage(err)}`);
        }
        try {
            const { Client: IpcClient } = await import("../ipc/client");
            client = await IpcClient.dial(p.socket());
        } catch (err) {
            d.close();
            throw new Error(`connect to daemon: ${errMessage(err)}`);
        }
    }
    return new AxiEnv(p, d, repo, client);
}

/**
 * Returns an actionable hint when the failure is an uninitialized repo, and an
 * empty list otherwise.
 */
export function repoInitHelp(err: unknown): string[] {
    if (errMessage(err).includes("not initialized")) {
        return ["Run `enigma gate init` to set up the gate in this repository"];
    }
    return [];
}
