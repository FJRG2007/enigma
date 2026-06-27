/**
 * GitHub PR client backed by the `gh` CLI. Faithful port of the upstream
 * `internal/scm/github` package: PR create/find/update, CI check status, merge
 * state, and failing-check log retrieval, with fork `--head <owner>:<branch>`
 * routing. Commands shell out to `gh` via execFile with argument arrays.
 *
 * The pure scm value types (PR, PRContent, PRState, MergeableState, CheckBucket,
 * Check, Capabilities, extractPRNumber) are defined here because the host.ts
 * port deferred the provider CLI clients; Provider detection stays in host.ts.
 */

import { execFile } from "node:child_process";
import { Provider, PROVIDER_GITHUB } from "./host";

/** Outcome of a single `gh` invocation: captured text plus a non-null error on failure. */
export type CmdResult = { out: string; err: Error | null };

/** A built command, mirroring the subset of `exec.Cmd` the host uses. */
export interface Cmd {
    /** Run and report only the exit error (Go: cmd.Run()). */
    run(): Promise<Error | null>;
    /** Run and return stdout plus the exit error (Go: cmd.Output()). */
    output(): Promise<CmdResult>;
    /** Run and return stdout+stderr plus the exit error (Go: cmd.CombinedOutput()). */
    combinedOutput(): Promise<CmdResult>;
}

/** Builds a command in the caller's workdir/env, cancelled via the signal. */
export type CmdFactory = (signal: AbortSignal | undefined, name: string, ...args: string[]) => Cmd;

/** PR identifies a pull request on a provider. */
export interface PR {
    number: string;
    url: string;
}

/** PRContent is the title + body for creating or updating a PR. */
export interface PRContent {
    title: string;
    body: string;
}

/** PRState is the normalized lifecycle state of a PR. */
export type PRState = string;

export const PR_STATE_OPEN: PRState = "OPEN";
export const PR_STATE_MERGED: PRState = "MERGED";
export const PR_STATE_CLOSED: PRState = "CLOSED";

/** MergeableState is the normalized merge-conflict status of a PR. */
export type MergeableState = string;

export const MERGEABLE_OK: MergeableState = "MERGEABLE";
export const MERGEABLE_CONFLICT: MergeableState = "CONFLICTING";
export const MERGEABLE_PENDING: MergeableState = "PENDING";

/** CheckBucket is the normalized outcome of a CI check. */
export type CheckBucket = string;

export const CHECK_BUCKET_PASS: CheckBucket = "pass";
export const CHECK_BUCKET_FAIL: CheckBucket = "fail";
export const CHECK_BUCKET_PENDING: CheckBucket = "pending";
export const CHECK_BUCKET_CANCEL: CheckBucket = "cancel";
export const CHECK_BUCKET_SKIP: CheckBucket = "skipping";

/** Check is a single CI check result on a PR. */
export interface Check {
    name: string;
    bucket: CheckBucket;
    /** Null when unknown; used to detect CI re-runs between polls. */
    completedAt: Date | null;
}

/** Capabilities declares which optional Host methods return meaningful data. */
export interface Capabilities {
    mergeableState: boolean;
    failedCheckLogs: boolean;
}

/** Raw `gh pr list` row shape. */
interface RawPR {
    number?: number;
    url?: string;
    headRefName?: string;
    headRepositoryOwner?: { login?: string } | null;
}

/** Raw `gh run list` row shape. */
interface GithubRun {
    databaseId?: number;
    headSha?: string;
    name?: string;
    displayTitle?: string;
    workflowName?: string;
}

/** Raw `gh run view --json jobs` payload. */
interface GithubRunView {
    jobs?: GithubRunJob[];
}

/** Raw job entry within a run view. */
interface GithubRunJob {
    name?: string;
    conclusion?: string;
    status?: string;
}

/** Raw `gh pr checks` row shape. */
interface RawCheck {
    name?: string;
    state?: string;
    bucket?: string;
    completedAt?: string;
}

/**
 * Returns the trailing numeric segment from a PR/MR URL, or null when the URL
 * has no trailing numeric path segment.
 */
export function extractPRNumber(prURL: string): string | null {
    const trimmed = prURL.replace(/\/+$/, "");
    const parts = trimmed.split("/");
    const num = parts[parts.length - 1];
    if (num === "") return null;
    if (!/^[+-]?\d+$/.test(num)) return null;
    return num;
}

/** Default CmdFactory that runs `gh` (or any binary) through execFile. */
export const execFileCmdFactory: CmdFactory = (signal, name, ...args) => {
    const exec = (combined: boolean): Promise<CmdResult> =>
        new Promise<CmdResult>((resolve) => {
            execFile(
                name,
                args,
                { signal, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
                (error, stdout, stderr) => {
                    const out = combined ? String(stdout) + String(stderr) : String(stdout);
                    resolve({ out, err: error ?? null });
                }
            );
        });
    return {
        run: () => exec(false).then((r) => r.err),
        output: () => exec(false),
        combinedOutput: () => exec(true)
    };
};

/** Host talks to GitHub through the `gh` CLI. */
export class Host {
    /** Use New / NewWithFork rather than constructing directly. */
    constructor(
        private readonly cmd: CmdFactory,
        private readonly cliAvailable: (() => boolean) | null,
        private readonly repo: string,
        private readonly forkOwner: string
    ) {}

    provider(): Provider {
        return PROVIDER_GITHUB;
    }

    capabilities(): Capabilities {
        return { mergeableState: true, failedCheckLogs: true };
    }

    /** Returns null when the host is ready, or a descriptive error otherwise. */
    async available(signal: AbortSignal | undefined): Promise<Error | null> {
        if (this.cliAvailable != null && !this.cliAvailable()) {
            return new Error("gh CLI is not installed");
        }
        const err = await this.cmd(signal, "gh", "auth", "status").run();
        if (err != null) return new Error("gh CLI is not authenticated");
        return null;
    }

    /** Returns the open PR for the source branch, or null if none exists. */
    async findPR(signal: AbortSignal | undefined, branch: string, base: string): Promise<PR | null> {
        const args = ["pr", "list", "--head", branch];
        if (base.trim() !== "") args.push("--base", base);
        args.push(...this.repoArgs());
        let jsonFields = "number,url";
        if (this.forkOwner !== "") jsonFields = "number,url,headRefName,headRepositoryOwner";
        args.push("--state", "open", "--json", jsonFields);
        const { out, err } = await this.cmd(signal, "gh", ...args).combinedOutput();
        if (err != null) throw new Error(`gh pr list: ${out.trim()}: ${err.message}`);
        let prs: RawPR[];
        try {
            prs = JSON.parse(out) as RawPR[];
        } catch {
            return null;
        }
        if (!Array.isArray(prs) || prs.length === 0) return null;
        for (const candidate of prs) {
            if (!this.matchesHead(candidate.headRefName ?? "", candidate.headRepositoryOwner ?? null, branch)) {
                continue;
            }
            const pr: PR = { number: "", url: (candidate.url ?? "").trim() };
            if ((candidate.number ?? 0) > 0) {
                pr.number = String(candidate.number);
            } else {
                const num = extractPRNumber(pr.url);
                if (num != null) pr.number = num;
            }
            if (pr.url === "") return null;
            return pr;
        }
        return null;
    }

    private matchesHead(headRefName: string, owner: { login?: string } | null, branch: string): boolean {
        if (this.forkOwner === "") return true;
        if (headRefName.trim() !== "" && headRefName !== branch) return false;
        if (owner == null) return false;
        return (owner.login ?? "").trim().toLowerCase() === this.forkOwner.toLowerCase();
    }

    async createPR(
        signal: AbortSignal | undefined,
        branch: string,
        base: string,
        content: PRContent
    ): Promise<PR> {
        const args = ["pr", "create", "--head", this.headRef(branch), "--base", base, ...this.repoArgs()];
        args.push("--title", content.title, "--body", content.body);
        const { out, err } = await this.cmd(signal, "gh", ...args).combinedOutput();
        if (err != null) throw new Error(`gh pr create: ${out.trim()}: ${err.message}`);
        const url = out.trim();
        const pr: PR = { number: "", url };
        const num = extractPRNumber(url);
        if (num != null) pr.number = num;
        return pr;
    }

    async updatePR(signal: AbortSignal | undefined, pr: PR, content: PRContent): Promise<PR> {
        let id = pr.number;
        if (id === "") id = pr.url;
        const args = ["pr", "edit", id, ...this.repoArgs()];
        args.push("--title", content.title, "--body", content.body);
        const { out, err } = await this.cmd(signal, "gh", ...args).combinedOutput();
        if (err != null) throw new Error(`gh pr edit: ${out.trim()}: ${err.message}`);
        return pr;
    }

    async getPRState(signal: AbortSignal | undefined, pr: PR): Promise<PRState> {
        const args = ["pr", "view", pr.number, ...this.repoArgs()];
        args.push("--json", "state", "--jq", ".state");
        const { out, err } = await this.cmd(signal, "gh", ...args).output();
        if (err != null) throw new Error(`gh pr view: ${err.message}`);
        return normalizePRState(out.trim());
    }

    async getChecks(signal: AbortSignal | undefined, pr: PR): Promise<Check[]> {
        const args = ["pr", "checks", pr.number, ...this.repoArgs()];
        args.push("--json", "name,state,bucket,completedAt");
        const { out, err } = await this.cmd(signal, "gh", ...args).combinedOutput();
        if (err != null) {
            if (out.includes("no checks reported")) return [];
            throw new Error(`gh pr checks: ${err.message}`);
        }
        let raw: RawCheck[];
        try {
            raw = JSON.parse(out) as RawCheck[];
        } catch (e) {
            throw new Error(`parse CI checks: ${(e as Error).message}`);
        }
        const checks: Check[] = [];
        for (const r of raw) {
            let completedAt: Date | null = null;
            if ((r.completedAt ?? "") !== "") {
                const parsed = new Date(r.completedAt as string);
                if (!isNaN(parsed.getTime())) completedAt = parsed;
            }
            checks.push({
                name: r.name ?? "",
                bucket: normalizeCheckBucket(r.bucket ?? "", r.state ?? ""),
                completedAt
            });
        }
        return checks;
    }

    async getMergeableState(signal: AbortSignal | undefined, pr: PR): Promise<MergeableState> {
        const args = ["pr", "view", pr.number, ...this.repoArgs()];
        args.push("--json", "mergeable", "--jq", ".mergeable");
        const { out, err } = await this.cmd(signal, "gh", ...args).output();
        if (err != null) throw new Error(`gh pr view mergeable: ${err.message}`);
        return normalizeMergeableState(out.trim());
    }

    async fetchFailedCheckLogs(
        signal: AbortSignal | undefined,
        _pr: PR,
        branch: string,
        headSHA: string,
        failingNames: string[]
    ): Promise<string> {
        if (failingNames.length === 0) return "";
        const targets = new Set<string>();
        for (const name of failingNames) {
            const normalized = normalizeRunName(name);
            if (normalized !== "") targets.add(normalized);
        }
        if (targets.size === 0) return "";
        const args = ["run", "list", "--branch", branch];
        if (headSHA.trim() !== "") args.push("--commit", headSHA.trim());
        args.push(...this.repoArgs());
        args.push("--status", "failure", "--limit", "20", "--json", "databaseId,headSha,name,displayTitle,workflowName");
        const { out: listOut, err } = await this.cmd(signal, "gh", ...args).output();
        if (err != null) return "";
        let runs: GithubRun[];
        try {
            runs = JSON.parse(listOut) as GithubRun[];
        } catch {
            return "";
        }
        if (!Array.isArray(runs)) return "";
        for (const run of runs) {
            if (!(await this.runMatchesTargets(signal, run, targets))) continue;
            const viewArgs = ["run", "view", String(run.databaseId ?? 0), ...this.repoArgs()];
            viewArgs.push("--log-failed");
            const { out, err: viewErr } = await this.cmd(signal, "gh", ...viewArgs).output();
            if (viewErr != null) continue;
            const logs = out.trim();
            if (logs !== "") return logs;
        }
        return "";
    }

    private async runMatchesTargets(
        signal: AbortSignal | undefined,
        run: GithubRun,
        targets: Set<string>
    ): Promise<boolean> {
        for (const candidate of [run.name, run.displayTitle, run.workflowName]) {
            if (targets.has(normalizeRunName(candidate ?? ""))) return true;
        }
        if ((run.databaseId ?? 0) === 0) return false;
        const viewArgs = ["run", "view", String(run.databaseId), ...this.repoArgs()];
        viewArgs.push("--json", "jobs");
        const { out, err } = await this.cmd(signal, "gh", ...viewArgs).output();
        if (err != null) return false;
        let payload: GithubRunView;
        try {
            payload = JSON.parse(out) as GithubRunView;
        } catch {
            return false;
        }
        for (const job of payload.jobs ?? []) {
            if (!isFailedJob(job)) continue;
            if (targets.has(normalizeRunName(job.name ?? ""))) return true;
        }
        return false;
    }

    /** Returns the --repo flag pair when the slug is known, else empty. */
    private repoArgs(): string[] {
        if (this.repo === "") return [];
        return ["--repo", this.repo];
    }

    private headRef(branch: string): string {
        if (this.forkOwner === "") return branch;
        return `${this.forkOwner}:${branch}`;
    }
}

/**
 * Builds a Host. cliAvailable reports whether the `gh` binary is resolvable on
 * PATH. repo is the "owner/name" slug; when set it is passed via --repo to every
 * PR/run command so they resolve regardless of the process working directory.
 */
export function New(cmd: CmdFactory, cliAvailable: (() => boolean) | null, repo: string): Host {
    return new Host(cmd, cliAvailable, repo.trim(), "");
}

/**
 * Builds a Host that opens PRs on repo using forkRepo's owner as the head
 * repository, so `gh pr create` receives --head <owner>:<branch>.
 */
export function NewWithFork(
    cmd: CmdFactory,
    cliAvailable: (() => boolean) | null,
    repo: string,
    forkRepo: string
): Host {
    return new Host(cmd, cliAvailable, repo.trim(), repoOwner(forkRepo));
}

function repoOwner(slug: string): string {
    const trimmed = slug.trim();
    const idx = trimmed.indexOf("/");
    if (idx < 0) return "";
    return trimmed.slice(0, idx).trim();
}

function isFailedJob(job: GithubRunJob): boolean {
    let state = (job.conclusion ?? "").trim().toUpperCase();
    if (state === "") state = (job.status ?? "").trim().toUpperCase();
    switch (state) {
        case "FAILURE":
        case "FAILED":
        case "ERROR":
        case "TIMED_OUT":
        case "ACTION_REQUIRED":
        case "STARTUP_FAILURE":
            return true;
        default:
            return false;
    }
}

function normalizeRunName(name: string): string {
    return name.trim().toLowerCase();
}

function normalizePRState(raw: string): PRState {
    switch (raw.trim().toUpperCase()) {
        case "OPEN":
            return PR_STATE_OPEN;
        case "MERGED":
            return PR_STATE_MERGED;
        case "CLOSED":
            return PR_STATE_CLOSED;
        default:
            return raw;
    }
}

function normalizeMergeableState(raw: string): MergeableState {
    switch (raw.trim().toUpperCase()) {
        case "MERGEABLE":
            return MERGEABLE_OK;
        case "CONFLICTING":
            return MERGEABLE_CONFLICT;
        case "UNKNOWN":
        case "":
            return MERGEABLE_PENDING;
        default:
            return raw;
    }
}

function normalizeCheckBucket(bucket: string, state: string): CheckBucket {
    const normalized = bucket.trim();
    if (normalized !== "") return normalized;

    switch (state.trim().toUpperCase()) {
        case "SUCCESS":
            return CHECK_BUCKET_PASS;
        case "FAILURE":
        case "ERROR":
        case "TIMED_OUT":
        case "ACTION_REQUIRED":
        case "STARTUP_FAILURE":
            return CHECK_BUCKET_FAIL;
        case "PENDING":
        case "QUEUED":
        case "IN_PROGRESS":
        case "WAITING":
        case "REQUESTED":
        case "EXPECTED":
            return CHECK_BUCKET_PENDING;
        case "CANCELLED":
            return CHECK_BUCKET_CANCEL;
        case "SKIPPED":
        case "NEUTRAL":
        case "STALE":
            return CHECK_BUCKET_SKIP;
        default:
            return "";
    }
}
