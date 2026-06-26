/**
 * `gate runs [--limit N]`: list pipeline runs for the current repository.
 * Faithful port of no-mistakes' `internal/cli/runs.go`. Reads runs directly
 * from the DB (not IPC), as the Go command does.
 */

import type { Run } from "../db";
import type { Paths } from "../paths";
import { REMOTE_NAME } from "../init";
import { getRunsByRepo } from "../db";
import {
    out,
    sDim,
    sBold,
    openDb,
    findRepo,
    runStatusStyle,
    formatDateShort
} from "./common";

/** Parsed options for `gate runs`. */
export interface RunsCliOptions {
    /** Maximum number of runs to display (Go default 10). */
    limit?: number;
}

/** Lists pipeline runs for the current directory's repo. */
export async function runRunsCli(opts: RunsCliOptions, paths: Paths): Promise<void> {
    const d = openDb(paths);
    try {
        const repo = findRepo(d);
        const runs = getRunsByRepo(d, repo.id);

        if (runs.length === 0) {
            out(`  ${sDim("no runs yet. Push through the gate to start a pipeline:")}\n`);
            out(`  ${sBold(`git push ${REMOTE_NAME} <branch>`)}\n`);
            return;
        }

        const limit = opts.limit ?? 10;
        let shown = runs;
        if (limit > 0 && shown.length > limit) {
            shown = shown.slice(0, limit);
        }

        for (const r of shown) printRunLine(r);

        if (runs.length > shown.length) {
            out(`\n  ${sDim(`(${runs.length - shown.length} more runs, use --limit to see more)`)}\n`);
        }
    } finally {
        d.close();
    }
}

/** Renders one run row, matching Go's "  %-12s %-20s %s  %s%s" layout. */
function printRunLine(r: Run): void {
    const ts = formatDateShort(r.createdAt);
    const sha = r.headSha.length > 8 ? r.headSha.slice(0, 8) : r.headSha;
    const pr = r.prUrl != null ? `  ${r.prUrl}` : "";
    out(`  ${runStatusStyle(r.status).padEnd(12)} ${r.branch.padEnd(20)} ${sDim(sha)}  ${sDim(ts)}${pr}\n`);
}
