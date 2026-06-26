/**
 * `gate status`: show the resolved gate, remote, daemon, and active-run status
 * for the current repository. Faithful port of no-mistakes'
 * `internal/cli/status.go`. Reads the active run directly from the DB (not IPC),
 * as the Go command does.
 */

import { redact } from "../safeurl";
import { getActiveRun } from "../db";
import type { Paths } from "../paths";
import { isDaemonRunning } from "./daemonCmd";
import {
    out,
    sCyan,
    sDim,
    minLen,
    openDb,
    sGreen,
    findRepo,
    runStatusStyle,
    formatDateTime
} from "./common";

/** Prints the status of the gate for the current directory. */
export async function runStatusCli(paths: Paths): Promise<void> {
    const d = openDb(paths);
    try {
        let repo;
        try {
            repo = findRepo(d);
        } catch (err) {
            out(`${err instanceof Error ? err.message : String(err)}\n`);
            return;
        }

        out(`  ${sDim("  repo:")}  ${repo.workingPath}\n`);
        let remoteURL = repo.upstreamUrl;
        if (repo.forkUrl !== "") remoteURL = redact(remoteURL);
        out(`  ${sDim("remote:")}  ${remoteURL}\n`);
        if (repo.forkUrl !== "") {
            out(`  ${sDim("  fork:")}  ${redact(repo.forkUrl)}\n`);
        }
        out(`  ${sDim("  gate:")}  ${paths.repoDir(repo.id)}\n`);

        const alive = await isDaemonRunning(paths);
        if (alive) {
            out(`  ${sDim("daemon:")}  ${sGreen("●")} running\n`);
        } else {
            out(`  ${sDim("daemon:")}  ${sDim("○")} stopped\n`);
        }

        const activeRun = getActiveRun(d, repo.id, "");
        if (activeRun !== null) {
            out("\n");
            out(`  ${sCyan("Active run")}\n`);
            const sha = activeRun.headSha.slice(0, minLen(activeRun.headSha.length, 8));
            const ts = formatDateTime(activeRun.createdAt);
            out(`  ${sDim("     id:")}  ${activeRun.id}\n`);
            out(`  ${sDim(" branch:")}  ${activeRun.branch}\n`);
            out(`  ${sDim(" status:")}  ${runStatusStyle(activeRun.status)}\n`);
            out(`  ${sDim("   head:")}  ${sDim(sha)}\n`);
            out(`  ${sDim("started:")}  ${sDim(ts)}\n`);
        } else {
            out(`\n  ${sDim("no active run")}\n`);
        }
    } finally {
        d.close();
    }
}
