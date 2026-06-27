/**
 * `gate init [--fork-url <url>]`: set up or refresh the local gate for the
 * current repository, start the daemon, and print a summary. Faithful port of
 * upstream's `internal/cli/init.go`.
 *
 * Divergence: the user-level agent skill install (Go's `skill.InstallUser` plus
 * the vendored-copy note) belongs to the not-yet-ported skill subsystem and is
 * omitted here. Everything else - the gate setup, daemon start with rollback,
 * and the summary block - is preserved.
 */

import { redact } from "../safeurl";
import type { Paths } from "../paths";
import { ensureDaemon } from "./daemonCmd";
import { eject, initWithFork, REMOTE_NAME } from "../init";
import { out, sCyan, sDim, sBold, sGreen, openDb, errMessage } from "./common";

/** Parsed options for `gate init`. */
export interface InitCliOptions {
    /** GitHub fork remote URL; an empty string when the flag was given empty. */
    forkUrl?: string;
}

/** ASCII banner printed atop the init summary. */
const BANNER = `____ _  _ _ ____ _  _ ____    ____ ____ ___ ____
|___ |\\ | | | __ |\\/| |__|    | __ |__|  |  |___
|___ | \\| | |__] |  | |  |    |__] |  |  |  |___`;

/**
 * Initializes (or refreshes) the gate for the current directory. Mirrors the Go
 * command: validate the fork flag, run the gate setup, start the daemon (rolling
 * back a freshly created gate on failure), then print the summary.
 */
export async function runInitCli(opts: InitCliOptions, paths: Paths): Promise<void> {
    const d = openDb(paths);
    try {
        const forkProvided = opts.forkUrl !== undefined;
        const forkURL = opts.forkUrl ?? "";
        if (forkProvided && forkURL.trim() === "") {
            throw new Error("init: --fork-url must not be empty");
        }

        let repo;
        let created: boolean;
        try {
            const result = await initWithFork(d, paths, ".", forkURL);
            repo = result.repo;
            created = result.created;
        } catch (err) {
            throw new Error(`init: ${errMessage(err)}`);
        }

        try {
            await ensureDaemon(paths);
        } catch (err) {
            // Only roll back a gate we created in this run; a re-init must never
            // eject a user's pre-existing gate.
            if (created) {
                try {
                    await eject(d, paths, ".");
                } catch (ejectErr) {
                    throw new Error(`start daemon: ${errMessage(err)}, rollback init: ${errMessage(ejectErr)}`);
                }
            }
            throw new Error(`start daemon: ${errMessage(err)}`);
        }

        out(`${sCyan(BANNER)}\n`);
        out("\n");
        const headline = created ? "Gate initialized" : "Gate already initialized (refreshed)";
        out(`  ${sGreen("✓")} ${headline}\n`);
        out("\n");
        out(`  ${sDim("  repo")}  ${repo.workingPath}\n`);
        out(`  ${sDim("  gate")}  ${REMOTE_NAME} → ${paths.repoDir(repo.id)}\n`);
        let remoteURL = repo.upstreamUrl;
        if (repo.forkUrl !== "") remoteURL = redact(remoteURL);
        out(`  ${sDim("remote")}  ${remoteURL}\n`);
        if (repo.forkUrl !== "") {
            out(`  ${sDim("  fork")}  ${redact(repo.forkUrl)}\n`);
        }
        out("\n");
        out(`  ${sDim("Push through the gate with:")}\n`);
        out(`  ${sBold(`git push ${REMOTE_NAME} <branch>`)}\n`);
    } finally {
        d.close();
    }
}
