/**
 * `gate eject`: remove the gate from the current repository (remote, bare repo,
 * worktrees, and DB record) and print a summary. Faithful port of no-mistakes'
 * `internal/cli/eject.go`.
 */

import { eject } from "../init";
import { redact } from "../safeurl";
import type { Paths } from "../paths";
import { out, sDim, sGreen, openDb, errMessage } from "./common";

/** Removes the gate for the current directory and prints what was removed. */
export async function runEjectCli(paths: Paths): Promise<void> {
    const d = openDb(paths);
    try {
        let repo;
        try {
            repo = await eject(d, paths, ".");
        } catch (err) {
            throw new Error(`eject: ${errMessage(err)}`);
        }

        out(`  ${sGreen("✓")} Gate removed\n`);
        out("\n");
        out(`  ${sDim("  repo")}  ${repo.workingPath}\n`);
        let remoteURL = repo.upstreamUrl;
        if (repo.forkUrl !== "") remoteURL = redact(remoteURL);
        out(`  ${sDim("remote")}  ${remoteURL}\n`);
        if (repo.forkUrl !== "") {
            out(`  ${sDim("  fork")}  ${redact(repo.forkUrl)}\n`);
        }
    } finally {
        d.close();
    }
}
