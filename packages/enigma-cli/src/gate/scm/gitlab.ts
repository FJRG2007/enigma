/**
 * Faithful 1:1 port of upstream's `internal/scm/gitlab` package (gitlab.go).
 * The GitLab host shells out to the `glab` CLI; every invocation goes through
 * `node:child_process` execFile with an argv array (never a shell string), to
 * mirror Go's `exec.CommandContext(ctx, "glab", args...)` and stay injection-safe.
 *
 * Go's `CmdFactory` abstraction is preserved so callers can inject commands in
 * tests; `defaultCmdFactory` is the production factory Go built inline at the
 * call site. Go threaded `context.Context`; here it is an optional trailing
 * `AbortSignal`. Go's `(value, error)` returns map to: throw on error, and
 * return `null` where Go returned a nil pointer with a nil error ("not found").
 */

import * as types from "./types";
import { execFile } from "node:child_process";
import { PROVIDER_GITLAB, type Provider } from "./host";

/** Cap on captured glab output; pipeline JSON can be large, so this is generous. */
const MAX_BUFFER = 32 * 1024 * 1024;

/** A built command, mirroring the subset of Go's `exec.Cmd` the GitLab host uses. */
export interface Cmd {
    /** Runs the command, resolving to the failure Error or null on success. */
    run(): Promise<Error | null>;
    /** Runs and resolves to combined stdout+stderr plus any failure Error. */
    combinedOutput(): Promise<[string, Error | null]>;
    /** Runs and resolves to stdout plus any failure Error. */
    output(): Promise<[string, Error | null]>;
}

/** Builds a Cmd for `name args...`, mirroring Go's CmdFactory signature. */
export type CmdFactory = (signal: AbortSignal | undefined, name: string, ...args: string[]) => Cmd;

interface ExecOutcome {
    stdout: string;
    stderr: string;
    error: Error | null;
}

function execCmd(name: string, args: string[], signal: AbortSignal | undefined): Promise<ExecOutcome> {
    return new Promise((resolvePromise) => {
        execFile(
            name,
            args,
            { signal, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8" },
            (err, stdout, stderr) => {
                const out = stdout ?? "";
                const errOut = stderr ?? "";
                if (err === null) {
                    resolvePromise({ stdout: out, stderr: errOut, error: null });
                    return;
                }
                const e = err as NodeJS.ErrnoException;
                let message: string;
                if (e.code === "ENOENT") {
                    message = `exec: "${name}": executable file not found in $PATH`;
                } else if (typeof e.code === "number") {
                    message = `exit status ${e.code}`;
                } else {
                    message = e.message;
                }
                resolvePromise({ stdout: out, stderr: errOut, error: new Error(message) });
            }
        );
    });
}

function makeCmd(signal: AbortSignal | undefined, name: string, args: string[]): Cmd {
    return {
        run: async () => (await execCmd(name, args, signal)).error,
        combinedOutput: async () => {
            const r = await execCmd(name, args, signal);
            return [r.stdout + r.stderr, r.error];
        },
        output: async () => {
            const r = await execCmd(name, args, signal);
            return [r.stdout, r.error];
        }
    };
}

/** Production CmdFactory that runs `name args...` via execFile (no shell). */
export const defaultCmdFactory: CmdFactory = (signal, name, ...args) => makeCmd(signal, name, args);

/** Decoded subset of a glab merge-request JSON object. */
interface MrPayload {
    iid: number;
    webUrl: string;
    url: string;
    state: string;
    hasConflicts: boolean;
    detailedMergeStatus: string;
    mergeStatus: string;
}

function toMrPayload(obj: Record<string, unknown>): MrPayload {
    return {
        iid: typeof obj.iid === "number" ? obj.iid : 0,
        webUrl: typeof obj.web_url === "string" ? obj.web_url : "",
        url: typeof obj.url === "string" ? obj.url : "",
        state: typeof obj.state === "string" ? obj.state : "",
        hasConflicts: obj.has_conflicts === true,
        detailedMergeStatus: typeof obj.detailed_merge_status === "string" ? obj.detailed_merge_status : "",
        mergeStatus: typeof obj.merge_status === "string" ? obj.merge_status : ""
    };
}

function mrToPR(p: MrPayload): types.PR {
    let url = p.webUrl.trim();
    if (url === "") url = p.url.trim();
    const pr: types.PR = { number: "", url };
    if (p.iid > 0) pr.number = String(p.iid);
    return pr;
}

/** glab may emit a banner line before JSON; skip until the first '{' or '['. */
function bytesTrimToJSON(out: string): string {
    for (let i = 0; i < out.length; i++) {
        const c = out[i];
        if (c === "{" || c === "[") return out.slice(i);
    }
    return "";
}

/** Parses a JSON object, rejecting null/array values (Go unmarshal-into-struct). */
function parseJSONObject(trimmed: string): Record<string, unknown> | null {
    let value: unknown;
    try {
        value = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function parseMRPayload(out: string): MrPayload | null {
    const trimmed = bytesTrimToJSON(out);
    if (trimmed === "") return null;
    const obj = parseJSONObject(trimmed);
    if (obj === null) return null;
    return toMrPayload(obj);
}

interface GitlabJob {
    id: number;
    name: string;
    status: string;
    stage: string;
}

function toJobs(arr: unknown[]): GitlabJob[] {
    return arr.map((raw) => {
        const job = (raw ?? {}) as Record<string, unknown>;
        return {
            id: typeof job.id === "number" ? job.id : 0,
            name: typeof job.name === "string" ? job.name : "",
            status: typeof job.status === "string" ? job.status : "",
            stage: typeof job.stage === "string" ? job.stage : ""
        };
    });
}

function jobsToChecks(jobs: GitlabJob[]): types.Check[] {
    return jobs.map((job) => ({ name: job.name, bucket: gitlabStatusBucket(job.status) }));
}

/** glab may return a single pipeline object with nested jobs, or a bare job array. */
function parseGitlabJobs(out: string): types.Check[] {
    const trimmed = bytesTrimToJSON(out);
    if (trimmed === "") return [];
    let value: unknown;
    try {
        value = JSON.parse(trimmed);
    } catch {
        return [];
    }
    if (Array.isArray(value) && value.length > 0) {
        return jobsToChecks(toJobs(value));
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const jobs = (value as Record<string, unknown>).jobs;
        if (Array.isArray(jobs) && jobs.length > 0) {
            return jobsToChecks(toJobs(jobs));
        }
    }
    return [];
}

function headPipelineID(payload: Record<string, unknown>): number {
    const hp = payload.head_pipeline;
    if (hp === null || typeof hp !== "object") return 0;
    const id = (hp as Record<string, unknown>).id;
    return typeof id === "number" ? id : 0;
}

function findFailedJobID(out: string, failingNames: string[]): number {
    const trimmed = bytesTrimToJSON(out);
    if (trimmed === "") return 0;
    const targets = new Set<string>();
    for (const name of failingNames) {
        const n = name.trim();
        if (n !== "") targets.add(n);
    }
    let value: unknown;
    try {
        value = JSON.parse(trimmed);
    } catch {
        value = undefined;
    }
    let jobs: GitlabJob[] = [];
    if (Array.isArray(value) && value.length > 0) {
        jobs = toJobs(value);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const raw = (value as Record<string, unknown>).jobs;
        if (Array.isArray(raw)) jobs = toJobs(raw);
    }
    for (const job of jobs) {
        if (job.status.toLowerCase() !== "failed") continue;
        if (targets.has(job.name) || targets.size === 0) return job.id;
    }
    return 0;
}

function gitlabStatusBucket(state: string): types.CheckBucket {
    switch (state.trim().toLowerCase()) {
        case "success":
            return types.CHECK_BUCKET_PASS;
        case "failed":
            return types.CHECK_BUCKET_FAIL;
        case "canceled":
        case "cancelled":
            return types.CHECK_BUCKET_CANCEL;
        case "skipped":
            return types.CHECK_BUCKET_SKIP;
        case "manual":
            return types.CHECK_BUCKET_SKIP;
        case "pending":
        case "running":
        case "created":
        case "waiting_for_resource":
        case "preparing":
        case "scheduled":
            return types.CHECK_BUCKET_PENDING;
        default:
            return "";
    }
}

function normalizePRState(raw: string): types.PRState {
    switch (raw.trim().toLowerCase()) {
        case "opened":
        case "open":
            return types.PR_STATE_OPEN;
        case "merged":
            return types.PR_STATE_MERGED;
        case "closed":
        case "locked":
            return types.PR_STATE_CLOSED;
        default:
            return raw.toUpperCase();
    }
}

function extractMRURL(raw: string): string {
    const text = raw.trim();
    for (const lineRaw of text.split("\n")) {
        const line = lineRaw.trim();
        if (line.startsWith("http://") || line.startsWith("https://")) return line;
    }
    const trimmed = bytesTrimToJSON(raw);
    if (trimmed === "") return "";
    const payload = parseJSONObject(trimmed);
    if (payload === null) return "";
    for (const key of ["web_url", "url", "webUrl"]) {
        const value = payload[key];
        if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return "";
}

function isUnsupportedMRFlagError(out: string): boolean {
    const msg = out.trim().toLowerCase();
    if (!msg.includes("--mr")) return false;
    const markers = [
        "unknown flag",
        "unknown option",
        "unsupported flag",
        "unsupported option",
        "unrecognized argument",
        "unrecognized arguments",
        "unrecognized option",
        "unknown argument",
        "unexpected argument",
        "flag provided but not defined"
    ];
    for (const marker of markers) {
        if (msg.includes(marker)) return true;
    }
    return false;
}

/** Host talks to GitLab through the glab CLI. */
export class GitLabHost implements types.Host {
    private readonly cmd: CmdFactory;
    private readonly cliAvailable: (() => boolean) | null;

    constructor(cmd: CmdFactory, cliAvailable: (() => boolean) | null) {
        this.cmd = cmd;
        this.cliAvailable = cliAvailable;
    }

    provider(): Provider {
        return PROVIDER_GITLAB;
    }

    capabilities(): types.Capabilities {
        return { mergeableState: true, failedCheckLogs: true };
    }

    async available(signal?: AbortSignal): Promise<void> {
        if (this.cliAvailable !== null && !this.cliAvailable()) {
            throw new Error("glab CLI is not installed");
        }
        const err = await this.cmd(signal, "glab", "auth", "status").run();
        if (err !== null) throw new Error("glab CLI is not authenticated");
    }

    async findPR(branch: string, base: string, signal?: AbortSignal): Promise<types.PR | null> {
        const args = ["mr", "list", "--source-branch", branch];
        if (base.trim() !== "") args.push("--target-branch", base);
        args.push("--state", "opened", "--output", "json");
        const [out, err] = await this.cmd(signal, "glab", ...args).combinedOutput();
        if (err !== null) throw new Error(`glab mr list: ${out.trim()}: ${err.message}`);
        const trimmed = bytesTrimToJSON(out);
        if (trimmed === "") return null;
        let mrs: unknown;
        try {
            mrs = JSON.parse(trimmed);
        } catch {
            return null;
        }
        if (!Array.isArray(mrs) || mrs.length === 0) return null;
        const first = mrs[0];
        if (first === null || typeof first !== "object" || Array.isArray(first)) return null;
        const pr = mrToPR(toMrPayload(first as Record<string, unknown>));
        if (pr.url === "") return null;
        return pr;
    }

    async createPR(branch: string, base: string, content: types.PRContent, signal?: AbortSignal): Promise<types.PR | null> {
        const [out, err] = await this.cmd(
            signal,
            "glab",
            "mr",
            "create",
            "--source-branch",
            branch,
            "--target-branch",
            base,
            "--title",
            content.title,
            "--description",
            content.body,
            "--yes"
        ).combinedOutput();
        if (err !== null) throw new Error(`glab mr create: ${out.trim()}: ${err.message}`);
        const url = extractMRURL(out);
        const pr: types.PR = { number: "", url };
        try {
            pr.number = types.extractPRNumber(url);
        } catch {
            // Go leaves Number empty when ExtractPRNumber fails.
        }
        return pr;
    }

    async updatePR(pr: types.PR, content: types.PRContent, signal?: AbortSignal): Promise<types.PR | null> {
        let id = pr.number;
        if (id === "") {
            try {
                id = types.extractPRNumber(pr.url);
            } catch {
                // Go keeps the empty id, then falls through to the URL.
            }
        }
        if (id === "") id = pr.url;
        const [out, err] = await this.cmd(
            signal,
            "glab",
            "mr",
            "update",
            id,
            "--title",
            content.title,
            "--description",
            content.body,
            "--yes"
        ).combinedOutput();
        if (err !== null) throw new Error(`glab mr update: ${out.trim()}: ${err.message}`);
        return pr;
    }

    async getPRState(pr: types.PR, signal?: AbortSignal): Promise<types.PRState> {
        const mr = await this.viewMR(pr.number, signal);
        return normalizePRState(mr.state);
    }

    async getMergeableState(pr: types.PR, signal?: AbortSignal): Promise<types.MergeableState> {
        const mr = await this.viewMR(pr.number, signal);
        if (mr.hasConflicts) return types.MERGEABLE_CONFLICT;
        // detailed_merge_status is preferred; merge_status is the legacy field.
        let status = mr.detailedMergeStatus.trim().toLowerCase();
        if (status === "") status = mr.mergeStatus.trim().toLowerCase();
        switch (status) {
            case "mergeable":
            case "can_be_merged":
                return types.MERGEABLE_OK;
            case "broken_status":
            case "cannot_be_merged":
                return types.MERGEABLE_CONFLICT;
            case "checking":
            case "unchecked":
            case "ci_still_running":
            case "":
                return types.MERGEABLE_PENDING;
            default:
                return types.MERGEABLE_OK;
        }
    }

    /**
     * Merges the MR. `--yes` suppresses glab's confirmation prompt, which would
     * otherwise hang a non-interactive call. GitLab's default is a merge commit, so
     * only squash and rebase carry a flag.
     */
    async mergePR(pr: types.PR, method: types.MergeMethod, signal?: AbortSignal): Promise<void> {
        const args = ["mr", "merge", pr.number, "--yes"];
        if (method === "squash") args.push("--squash");
        else if (method === "rebase") args.push("--rebase");
        const [out, err] = await this.cmd(signal, "glab", ...args).combinedOutput();
        if (err !== null) throw new Error(`glab mr merge: ${out.trim()}: ${err.message}`);
    }

    private async viewMR(id: string, signal?: AbortSignal): Promise<MrPayload> {
        const [out, err] = await this.cmd(signal, "glab", "mr", "view", id, "--output", "json").combinedOutput();
        if (err !== null) throw new Error(`glab mr view: ${out.trim()}: ${err.message}`);
        const mr = parseMRPayload(out);
        if (mr === null) throw new Error(`glab mr view: invalid JSON output: ${out.trim()}`);
        return mr;
    }

    async getChecks(pr: types.PR, signal?: AbortSignal): Promise<types.Check[]> {
        // glab ci status --mr <id> --output json lists jobs for the MR's latest pipeline.
        // Not all glab versions support --mr; fall back to listing pipeline jobs via view.
        const [out, err] = await this.cmd(
            signal,
            "glab",
            "ci",
            "status",
            "--mr",
            pr.number,
            "--output",
            "json"
        ).combinedOutput();
        if (err !== null) {
            if (!isUnsupportedMRFlagError(out)) {
                throw new Error(`glab ci status: ${out.trim()}: ${err.message}`);
            }
            return this.getChecksFallback(pr, signal);
        }
        return parseGitlabJobs(out);
    }

    private async getChecksFallback(pr: types.PR, signal?: AbortSignal): Promise<types.Check[]> {
        // Try fetching the MR's pipeline and listing its jobs.
        const [out, err] = await this.cmd(signal, "glab", "mr", "view", pr.number, "--output", "json").combinedOutput();
        if (err !== null) throw new Error(`glab mr view: ${out.trim()}: ${err.message}`);
        const trimmed = bytesTrimToJSON(out);
        if (trimmed === "") throw new Error(`glab mr view: invalid JSON output: ${out.trim()}`);
        const payload = parseJSONObject(trimmed);
        if (payload === null) throw new Error(`glab mr view: invalid JSON output: ${out.trim()}`);
        const pipelineID = headPipelineID(payload);
        if (pipelineID === 0) return [];
        const [jobsOut, jobsErr] = await this.cmd(
            signal,
            "glab",
            "ci",
            "get",
            "--pipeline-id",
            String(pipelineID),
            "--output",
            "json",
            "--with-job-details"
        ).combinedOutput();
        if (jobsErr !== null) throw new Error(`glab ci get: ${jobsOut.trim()}: ${jobsErr.message}`);
        return parseGitlabJobs(jobsOut);
    }

    async fetchFailedCheckLogs(
        pr: types.PR,
        _branch: string,
        _headSHA: string,
        failingNames: string[],
        signal?: AbortSignal
    ): Promise<string> {
        if (failingNames.length === 0) return "";
        // Get the MR's pipeline jobs, find a failed one whose name matches, trace it.
        const [viewOut, viewErr] = await this.cmd(
            signal,
            "glab",
            "mr",
            "view",
            pr.number,
            "--output",
            "json"
        ).combinedOutput();
        if (viewErr !== null) return "";
        const trimmed = bytesTrimToJSON(viewOut);
        if (trimmed === "") return "";
        const payload = parseJSONObject(trimmed);
        if (payload === null) return "";
        const pipelineID = headPipelineID(payload);
        if (pipelineID === 0) return "";
        const [jobsOut, jobsErr] = await this.cmd(
            signal,
            "glab",
            "ci",
            "get",
            "--pipeline-id",
            String(pipelineID),
            "--output",
            "json",
            "--with-job-details"
        ).combinedOutput();
        if (jobsErr !== null) return "";
        const jobID = findFailedJobID(jobsOut, failingNames);
        if (jobID === 0) return "";
        const [traceOut] = await this.cmd(signal, "glab", "ci", "trace", String(jobID)).output();
        return traceOut.trim();
    }
}

/** New builds a GitLab Host backed by the glab CLI (faithful port of Go's New). */
export function newGitLabHost(cmd: CmdFactory, cliAvailable: (() => boolean) | null): GitLabHost {
    return new GitLabHost(cmd, cliAvailable);
}
