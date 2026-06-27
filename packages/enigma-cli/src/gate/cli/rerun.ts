/**
 * `gate rerun`: re-run the pipeline for the current branch via the daemon.
 * Faithful port of upstream's `internal/cli/rerun.go`.
 */

import type { Paths } from "../paths";
import { Client } from "../ipc/client";
import { currentBranch } from "../git";
import { ensureDaemon } from "./daemonCmd";
import { out, sDim, sGreen, openDb, findRepo, errMessage } from "./common";

/** Reruns the pipeline for the current branch. */
export async function runRerunCli(paths: Paths): Promise<void> {
    const d = openDb(paths);
    try {
        const repo = findRepo(d);

        let branch: string;
        try {
            branch = await currentBranch(".");
        } catch (err) {
            throw new Error(`get current branch: ${errMessage(err)}`);
        }
        if (branch === "HEAD") {
            throw new Error("not on a branch");
        }

        try {
            await ensureDaemon(paths);
        } catch (err) {
            throw new Error(`start daemon: ${errMessage(err)}`);
        }

        let client: Client;
        try {
            client = await Client.dial(paths.socket());
        } catch (err) {
            throw new Error(`connect to daemon: ${errMessage(err)}`);
        }
        try {
            let runId: string;
            try {
                runId = await client.rerun({ repoId: repo.id, branch });
            } catch (err) {
                throw new Error(`rerun pipeline: ${errMessage(err)}`);
            }
            out(`  ${sGreen("✓")} Rerun started for ${branch} ${sDim(runId)}\n`);
        } finally {
            client.close();
        }
    } finally {
        d.close();
    }
}
