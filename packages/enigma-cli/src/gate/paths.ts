/**
 * Filesystem layout for the gate subsystem. Everything lives under a single
 * root, `~/.enigma/gate` by default, overridable via `ENIGMA_GATE_HOME` (the
 * port's equivalent of upstream's home env var) so tests can isolate state.
 *
 * Faithful port of the Go `internal/paths` package. The root is resolved lazily
 * per `Paths.resolve()` call so a test that reassigns the env/home is honored.
 */

import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { gateLedgerPath } from "../gate-ledger";
import { join, resolve, relative, isAbsolute } from "node:path";

/** Accessor for all gate filesystem locations, rooted at a single directory. */
export class Paths {
    constructor(private readonly rootDir: string) {}

    /** Paths rooted at `ENIGMA_GATE_HOME` or `~/.enigma/gate`. */
    static resolve(): Paths {
        const env = process.env.ENIGMA_GATE_HOME;
        if (env) return new Paths(env);
        return new Paths(join(homedir(), ".enigma", "gate"));
    }

    /** Paths rooted at a custom directory (for testing). */
    static withRoot(root: string): Paths {
        return new Paths(root);
    }

    root(): string {
        return this.rootDir;
    }

    db(): string {
        return join(this.rootDir, "state.sqlite");
    }

    socket(): string {
        return join(this.rootDir, "socket");
    }

    pidFile(): string {
        return join(this.rootDir, "daemon.pid");
    }

    configFile(): string {
        return join(this.rootDir, "config.yaml");
    }

    updateCheckFile(): string {
        return join(this.rootDir, "update-check.json");
    }

    /**
     * Snapshot of the active run for an agent status bar. Kept outside the
     * database because the status line runs on enigma's Node launcher, which
     * never loads the Bun runtime that `bun:sqlite` needs. Mirrored by
     * `bin/statusline.mjs`, which resolves the same path independently.
     */
    statuslineFile(): string {
        return join(this.rootDir, "statusline.json");
    }

    /**
     * Durable record of the last run per repository, for readers that cannot open
     * the database. Same Bun/Node split as the status-line snapshot, but this one
     * is not a view of the ACTIVE run: the completion gate (`src/verify.ts`) asks
     * it whether the gate ever saw the commits a turn is about to call done, which
     * has to survive the run ending.
     */
    runLedgerFile(): string {
        return gateLedgerPath(this.rootDir);
    }

    reposDir(): string {
        return join(this.rootDir, "repos");
    }

    repoDir(repoID: string): string {
        return join(this.rootDir, "repos", `${repoID}.git`);
    }

    worktreesDir(): string {
        return join(this.rootDir, "worktrees");
    }

    worktreeDir(repoID: string, runID: string): string {
        return join(this.rootDir, "worktrees", repoID, runID);
    }

    /** Root holding the private temp directory of every run. */
    agentTmpRoot(): string {
        return join(this.rootDir, "tmp");
    }

    /**
     * Private temp directory for one run's agent subprocesses. Agent CLIs keep
     * per-working-directory state in the OS temp dir, and a gate worktree path is
     * unique per run and never revisited, so that state is orphaned the moment the
     * run ends and nothing ever reclaims it. Pointing the subprocess at a temp root
     * enigma owns makes it disappear with the worktree instead, for every backend,
     * without depending on where any particular agent chooses to put it.
     */
    agentTmpDir(repoID: string, runID: string): string {
        return join(this.agentTmpRoot(), repoID, runID);
    }

    /**
     * Maps a worktree path back to that run's private temp directory, or null when
     * the path is not a gate worktree - an agent launched anywhere else keeps the
     * ambient temp dir, which is the caller's to manage.
     */
    agentTmpDirForWorktree(worktreePath: string): string | null {
        if (worktreePath.trim() === "") return null;
        const rel = relative(this.worktreesDir(), resolve(worktreePath));
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
        const parts = rel.split(/[\\/]/);
        if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
        return this.agentTmpDir(parts[0], parts[1]);
    }

    logsDir(): string {
        return join(this.rootDir, "logs");
    }

    runLogDir(runID: string): string {
        return join(this.rootDir, "logs", runID);
    }

    daemonLog(): string {
        return join(this.rootDir, "logs", "daemon.log");
    }

    cliLog(): string {
        return join(this.rootDir, "logs", "cli.log");
    }

    /**
     * PID-tracking files for managed agent servers (opencode, rovodev) so a
     * freshly started daemon can reap orphans left by a crashed predecessor.
     */
    serverPIDsDir(): string {
        return join(this.rootDir, "servers");
    }

    /** Creates all required directories under root. */
    ensureDirs(): void {
        for (const d of [this.rootDir, this.reposDir(), this.worktreesDir(), this.logsDir(), this.serverPIDsDir()]) {
            mkdirSync(d, { recursive: true });
        }
    }
}
