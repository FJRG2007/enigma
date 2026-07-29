/**
 * Filesystem layout for the gate subsystem. Everything lives under a single
 * root, `~/.enigma/gate` by default, overridable via `ENIGMA_GATE_HOME` (the
 * port's equivalent of upstream's home env var) so tests can isolate state.
 *
 * Faithful port of the Go `internal/paths` package. The root is resolved lazily
 * per `Paths.resolve()` call so a test that reassigns the env/home is honored.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

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
