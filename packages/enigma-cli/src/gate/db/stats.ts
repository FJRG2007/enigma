/**
 * Historical usage aggregation across repositories, runs, and steps. Faithful
 * port of no-mistakes' `internal/db/stats.go`.
 */

import type { Repo } from "./repo";
import { getRunsByRepo } from "./run";
import type { Database } from "./index";
import { basename, sep } from "node:path";
import { getStepsByRun, type StepResult } from "./step";
import { getRoundsByStep, type StepRound } from "./round";
import { parseFindingsJSON, stepOrder, type Finding, type StepName } from "../types";

/** Summarizes historical gate usage across all repositories. */
export interface Stats {
    totalRepos: number;
    totalRuns: number;
    pullRequests: number;
    rescueRuns: number;
    reportedFindings: number;
    fixedFindings: number;
    stepStats: StepStats[];
    repoStats: RepoStats[];
}

/** Summarizes reported and fixed findings for one pipeline step. */
export interface StepStats {
    stepName: StepName;
    reportedFindings: number;
    fixedFindings: number;
}

/** Summarizes historical usage for one repository. */
export interface RepoStats {
    repoId: string;
    workingPath: string;
    runs: number;
    rescueRuns: number;
    reportedFindings: number;
    fixedFindings: number;
}

/** Returns a compact repository name for terminal reports. */
export function repoDisplayName(r: RepoStats): string {
    const name = basename(r.workingPath);
    if (name === "." || name === sep || name === "") return r.workingPath;
    return name;
}

/** Aggregates historical usage across all repositories. */
export function getStats(db: Database): Stats {
    const repos = getRepos(db);

    const stats: Stats = {
        totalRepos: repos.length,
        totalRuns: 0,
        pullRequests: 0,
        rescueRuns: 0,
        reportedFindings: 0,
        fixedFindings: 0,
        stepStats: [],
        repoStats: []
    };
    const stepStats = new Map<StepName, StepStats>();

    for (const repo of repos) {
        const repoStats: RepoStats = {
            repoId: repo.id,
            workingPath: repo.workingPath,
            runs: 0,
            rescueRuns: 0,
            reportedFindings: 0,
            fixedFindings: 0
        };
        const runs = getRunsByRepo(db, repo.id);
        repoStats.runs = runs.length;
        stats.totalRuns += runs.length;

        for (const run of runs) {
            if (run.prUrl !== null && run.prUrl !== "") stats.pullRequests++;

            const [runReported, runFixed] = aggregateRunStats(db, run.id, stepStats);
            stats.reportedFindings += runReported;
            stats.fixedFindings += runFixed;
            repoStats.reportedFindings += runReported;
            repoStats.fixedFindings += runFixed;
            if (runReported > 0 && runFixed > 0) {
                stats.rescueRuns++;
                repoStats.rescueRuns++;
            }
        }

        stats.repoStats.push(repoStats);
    }

    for (const step of stepStats.values()) {
        if (step.reportedFindings === 0 && step.fixedFindings === 0) continue;
        stats.stepStats.push({ ...step });
    }
    sortStepStats(stats.stepStats);
    sortRepoStats(stats.repoStats);

    return stats;
}

function aggregateRunStats(db: Database, runId: string, stepStats: Map<StepName, StepStats>): [number, number] {
    const steps = getStepsByRun(db, runId);

    let runReported = 0;
    let runFixed = 0;
    for (const step of steps) {
        const rounds = getRoundsByStep(db, step.id);
        const findingStats = computeFindingStats(step, rounds);
        const reported = findingStats.reportedFindings;
        const fixed = findingStats.fixedFindings;

        runReported += reported;
        runFixed += fixed;
        let stat = stepStats.get(step.stepName);
        if (stat === undefined) {
            stat = { stepName: step.stepName, reportedFindings: 0, fixedFindings: 0 };
            stepStats.set(step.stepName, stat);
        }
        stat.reportedFindings += reported;
        stat.fixedFindings += fixed;
    }

    return [runReported, runFixed];
}

function stepFindingCounts(step: StepResult, rounds: StepRound[]): [number, number] {
    const stats = computeFindingStats(step, rounds);
    return [stats.reportedFindings, stats.reportedFindings - stats.fixedFindings];
}

function computeFindingStats(step: StepResult, rounds: StepRound[]): StepStats {
    const stats: StepStats = { stepName: step.stepName, reportedFindings: 0, fixedFindings: 0 };
    if (rounds.length === 0) {
        stats.reportedFindings = findingsCount(step.findingsJson);
        return stats;
    }

    const reported = new Set<string>();
    let current: Finding[] = [];
    for (const round of rounds) {
        const items = findingItems(round.findingsJson);
        for (const item of items) reported.add(findingStatsKey(item));
        current = items;
    }

    stats.reportedFindings = reported.size;
    const currentCount = current.length;
    stats.fixedFindings = stats.reportedFindings - currentCount;
    if (stats.fixedFindings < 0) stats.fixedFindings = 0;
    if (stats.fixedFindings > stats.reportedFindings) stats.fixedFindings = stats.reportedFindings;
    return stats;
}

/** Returns how many findings were resolved for a single step. */
export function fixedFindingsByStep(db: Database, step: StepResult): number {
    return stepFindingStats(db, step).fixedFindings;
}

/** Returns reported and fixed finding counts for a single step. */
export function stepFindingStats(db: Database, step: StepResult): StepStats {
    const rounds = getRoundsByStep(db, step.id);
    return computeFindingStats(step, rounds);
}

function findingsCount(raw: string | null): number {
    if (raw === null || raw === "") return 0;
    try {
        return parseFindingsJSON(raw).items.length;
    } catch {
        return 0;
    }
}

function findingItems(raw: string | null): Finding[] {
    if (raw === null || raw === "") return [];
    try {
        return parseFindingsJSON(raw).items;
    } catch {
        return [];
    }
}

function findingStatsKey(item: Finding): string {
    return JSON.stringify([item.severity ?? "", item.file ?? "", item.line ?? 0, item.description ?? ""]);
}

function sortStepStats(stats: StepStats[]): void {
    stats.sort((a, b) => {
        if (a.fixedFindings !== b.fixedFindings) return b.fixedFindings - a.fixedFindings;
        if (a.reportedFindings !== b.reportedFindings) return b.reportedFindings - a.reportedFindings;
        return stepOrder(a.stepName) - stepOrder(b.stepName);
    });
}

function sortRepoStats(stats: RepoStats[]): void {
    stats.sort((a, b) => {
        if (a.rescueRuns !== b.rescueRuns) return b.rescueRuns - a.rescueRuns;
        if (a.fixedFindings !== b.fixedFindings) return b.fixedFindings - a.fixedFindings;
        if (a.runs !== b.runs) return b.runs - a.runs;
        if (a.workingPath < b.workingPath) return -1;
        if (a.workingPath > b.workingPath) return 1;
        return 0;
    });
}

function getRepos(db: Database): Repo[] {
    const rows = db.sql.query(
        "SELECT id, working_path, upstream_url, COALESCE(fork_url, ''), default_branch, created_at FROM repos ORDER BY working_path"
    ).values();
    return rows.map(row => ({
        id: row[0] as string,
        workingPath: row[1] as string,
        upstreamUrl: row[2] as string,
        forkUrl: row[3] as string,
        defaultBranch: row[4] as string,
        createdAt: row[5] as number
    }));
}
