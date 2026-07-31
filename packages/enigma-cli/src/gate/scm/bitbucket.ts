/**
 * Faithful 1:1 port of upstream's `internal/bitbucket` package (client.go +
 * host.go). The Bitbucket host talks to the Cloud REST API v2.0 over HTTPS using
 * the global `fetch`; Go's `*http.Client` (30s timeout) maps to an
 * `AbortSignal.timeout` combined with the caller's `AbortSignal`.
 *
 * Credentials are sourced ONLY from the environment (email + API token + optional
 * base URL); nothing is hardcoded. Go threaded `context.Context`; here it is an
 * optional trailing `AbortSignal`. Go's `(value, error)` returns map to: throw on
 * error, and return `null` where Go returned a nil pointer with a nil error.
 */

import * as types from "./types";
import { PROVIDER_BITBUCKET, type Provider } from "./host";

const DEFAULT_API_BASE_URL = "https://api.bitbucket.org";
const ENV_EMAIL = "ENIGMA_BITBUCKET_EMAIL";
const ENV_TOKEN = "ENIGMA_BITBUCKET_API_TOKEN";
const ENV_API_BASE_URL = "ENIGMA_BITBUCKET_API_BASE_URL";
const MAX_STEP_LOG_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/** RepoRef identifies a Bitbucket repository by workspace and slug. */
export interface RepoRef {
    workspace: string;
    repoSlug: string;
}

/** PullRequest is the decoded Bitbucket pull request the host cares about. */
export interface PullRequest {
    id: number;
    url: string;
    state: string;
    sourceCommitHash: string;
}

/** CommitStatus is a single commit/build status attached to a PR. */
export interface CommitStatus {
    name: string;
    key: string;
    state: string;
    description: string;
    url: string;
}

/** Pipeline identifies a Bitbucket Pipelines run by UUID. */
export interface Pipeline {
    uuid: string;
}

/** PipelineStep is a single step within a pipeline run plus its state. */
export interface PipelineStep {
    uuid: string;
    state: {
        name: string;
        result: {
            name: string;
        };
    };
}

/** Client is a thin Bitbucket Cloud REST API v2.0 client. */
export class Client {
    private readonly baseURL: string;
    private readonly email: string;
    private readonly token: string;

    constructor(baseURL: string, email: string, token: string) {
        this.baseURL = baseURL;
        this.email = email;
        this.token = token;
    }

    async findOpenPRBySourceBranch(
        repo: RepoRef,
        branch: string,
        destBranch: string,
        signal?: AbortSignal
    ): Promise<PullRequest | null> {
        const query = new URLSearchParams();
        const clauses = [
            `source.branch.name=${goQuote(branch)}`,
            `source.repository.full_name=${goQuote(`${repo.workspace}/${repo.repoSlug}`)}`
        ];
        if (destBranch.trim() !== "") {
            clauses.push(`destination.branch.name=${goQuote(destBranch)}`);
        }
        clauses.push(`state=${goQuote("OPEN")}`);
        query.set("q", clauses.join(" AND "));

        const response = await this.doJSON<{ values?: unknown[]; }>("GET", repoPRPath(repo), query, null, signal);
        const values = response.values ?? [];
        if (values.length === 0) return null;
        return toPullRequest(values[0]);
    }

    async createPR(
        repo: RepoRef,
        sourceBranch: string,
        destBranch: string,
        title: string,
        body: string,
        signal?: AbortSignal
    ): Promise<PullRequest> {
        const requestBody = {
            title,
            description: body,
            source: { branch: { name: sourceBranch } },
            destination: { branch: { name: destBranch } }
        };
        const response = await this.doJSON<unknown>("POST", repoPRPath(repo), null, requestBody, signal);
        return toPullRequest(response);
    }

    async updatePR(
        repo: RepoRef,
        prID: number,
        title: string,
        body: string,
        signal?: AbortSignal
    ): Promise<PullRequest> {
        const requestBody = { title, description: body };
        const response = await this.doJSON<unknown>("PUT", `${repoPRPath(repo)}/${prID}`, null, requestBody, signal);
        return toPullRequest(response);
    }

    async getPR(repo: RepoRef, prID: number, signal?: AbortSignal): Promise<PullRequest | null> {
        const response = await this.doJSON<unknown>("GET", `${repoPRPath(repo)}/${prID}`, null, null, signal);
        return toPullRequest(response);
    }

    async listPRStatuses(repo: RepoRef, prID: number, signal?: AbortSignal): Promise<CommitStatus[]> {
        const query = new URLSearchParams();
        query.set("sort", "-created_on");

        let next = `${repoPRPath(repo)}/${prID}/statuses?${query.toString()}`;
        const statuses: CommitStatus[] = [];
        while (next !== "") {
            const response = await this.doJSONPathOrURL<{ values?: unknown[]; next?: string; }>(
                "GET",
                next,
                null,
                signal
            );
            for (const value of response.values ?? []) {
                statuses.push(toCommitStatus(value));
            }
            const responseNext = response.next ?? "";
            if (responseNext !== "") {
                next = this.validatePaginationURL(responseNext);
                continue;
            }
            next = responseNext;
        }
        return statuses;
    }

    async listPipelinesByCommit(repo: RepoRef, commitSHA: string, signal?: AbortSignal): Promise<Pipeline[]> {
        const query = new URLSearchParams();
        query.set("target.commit.hash", commitSHA);
        query.set("sort", "-created_on");

        let next = `${this.baseURL}/2.0/repositories/${repo.workspace}/${repo.repoSlug}/pipelines?${query.toString()}`;
        const pipelines: Pipeline[] = [];
        while (next !== "") {
            const response = await this.doJSONPathOrURL<{ values?: unknown[]; next?: string; }>(
                "GET",
                next,
                null,
                signal
            );
            for (const value of response.values ?? []) {
                pipelines.push(toPipeline(value));
            }
            const responseNext = response.next ?? "";
            if (responseNext === "") {
                next = "";
                continue;
            }
            next = this.validatePaginationURL(responseNext);
        }
        return pipelines;
    }

    async listPipelineSteps(repo: RepoRef, pipelineUUID: string, signal?: AbortSignal): Promise<PipelineStep[]> {
        let next = `${this.baseURL}/2.0/repositories/${repo.workspace}/${repo.repoSlug}/pipelines/${pipelineUUID}/steps`;
        const steps: PipelineStep[] = [];
        while (next !== "") {
            const response = await this.doJSONPathOrURL<{ values?: unknown[]; next?: string; }>(
                "GET",
                next,
                null,
                signal
            );
            for (const value of response.values ?? []) {
                steps.push(toPipelineStep(value));
            }
            const responseNext = response.next ?? "";
            if (responseNext === "") {
                next = "";
                continue;
            }
            next = this.validatePaginationURL(responseNext);
        }
        return steps;
    }

    async getStepLog(repo: RepoRef, pipelineUUID: string, stepUUID: string, signal?: AbortSignal): Promise<string> {
        const path = `/2.0/repositories/${repo.workspace}/${repo.repoSlug}/pipelines/${pipelineUUID}/steps/${stepUUID}/log`;
        let resp: Response;
        try {
            resp = await fetch(this.baseURL + path, {
                method: "GET",
                headers: { Authorization: basicAuth(this.email, this.token) },
                signal: withTimeout(signal)
            });
        } catch (err) {
            throw new Error(`Bitbucket GET ${path}: ${errMessage(err)}`);
        }
        if (resp.status < 200 || resp.status >= 300) {
            const data = await resp.text().catch(() => "");
            throw new Error(`Bitbucket GET ${path}: status ${resp.status}: ${data.trim()}`);
        }
        let data: string;
        try {
            data = await readTail(resp, MAX_STEP_LOG_BYTES);
        } catch (err) {
            throw new Error(`read Bitbucket step log: ${errMessage(err)}`);
        }
        return data.trim();
    }

    private validatePaginationURL(rawURL: string): string {
        let base: URL;
        try {
            base = new URL(this.baseURL);
        } catch (err) {
            throw new Error(`parse Bitbucket base URL: ${errMessage(err)}`);
        }
        let nextURL: URL;
        try {
            nextURL = new URL(rawURL);
        } catch {
            // Go treats a non-absolute pagination URL as safe and returns it as-is.
            return rawURL;
        }
        if (
            nextURL.protocol.toLowerCase() !== base.protocol.toLowerCase() ||
            nextURL.host.toLowerCase() !== base.host.toLowerCase()
        ) {
            throw new Error(`reject cross-origin Bitbucket pagination URL ${goQuote(rawURL)}`);
        }
        return rawURL;
    }

    private doJSON<T>(
        method: string,
        path: string,
        query: URLSearchParams | null,
        requestBody: unknown,
        signal: AbortSignal | undefined
    ): Promise<T> {
        let endpoint = this.baseURL + path;
        if (query !== null && [...query].length > 0) {
            endpoint += `?${query.toString()}`;
        }
        return this.doJSONPathOrURL<T>(method, endpoint, requestBody, signal);
    }

    private async doJSONPathOrURL<T>(
        method: string,
        pathOrURL: string,
        requestBody: unknown,
        signal: AbortSignal | undefined
    ): Promise<T> {
        const headers: Record<string, string> = {
            Accept: "application/json",
            Authorization: basicAuth(this.email, this.token)
        };
        const init: RequestInit = { method, signal: withTimeout(signal) };
        if (requestBody !== null && requestBody !== undefined) {
            init.body = JSON.stringify(requestBody);
            headers["Content-Type"] = "application/json";
        }
        init.headers = headers;

        let endpoint = pathOrURL;
        const requestLabel = pathOrURL;
        if (!pathOrURL.startsWith("http://") && !pathOrURL.startsWith("https://")) {
            endpoint = this.baseURL + pathOrURL;
        }

        let resp: Response;
        try {
            resp = await fetch(endpoint, init);
        } catch (err) {
            throw new Error(`Bitbucket ${method} ${requestLabel}: ${errMessage(err)}`);
        }
        if (resp.status < 200 || resp.status >= 300) {
            const data = await resp.text().catch(() => "");
            throw new Error(`Bitbucket ${method} ${requestLabel}: status ${resp.status}: ${data.trim()}`);
        }
        try {
            return (await resp.json()) as T;
        } catch (err) {
            throw new Error(`decode Bitbucket response: ${errMessage(err)}`);
        }
    }
}

/** NewClientFromEnv reads credentials from `env` entries first, then process.env. */
export function newClientFromEnv(env: string[]): Client {
    const email = lookupEnv(env, ENV_EMAIL);
    if (email.trim() === "") throw new Error(`missing ${ENV_EMAIL}`);
    const token = lookupEnv(env, ENV_TOKEN);
    if (token.trim() === "") throw new Error(`missing ${ENV_TOKEN}`);
    let baseURL = lookupEnv(env, ENV_API_BASE_URL);
    if (baseURL.trim() === "") baseURL = DEFAULT_API_BASE_URL;
    return new Client(baseURL.replace(/\/+$/, ""), email, token);
}

export function parseRepoRef(raw: string): RepoRef {
    let trimmed = raw.trim();
    if (trimmed.endsWith(".git")) trimmed = trimmed.slice(0, -".git".length);

    if (trimmed.startsWith("git@bitbucket.org:")) {
        const path = trimmed.slice("git@bitbucket.org:".length);
        return parseRepoPath(path);
    }

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch (err) {
        throw new Error(`parse bitbucket repo URL: ${errMessage(err)}`);
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== "bitbucket.org" && !host.endsWith(".bitbucket.org")) {
        throw new Error(`unsupported Bitbucket host ${goQuote(parsed.host)}`);
    }
    return parseRepoPath(parsed.pathname.replace(/^\//, ""));
}

function parseRepoPath(path: string): RepoRef {
    const parts = path.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2 || parts[0].trim() === "" || parts[1].trim() === "") {
        throw new Error(`invalid Bitbucket repository path ${goQuote(path)}`);
    }
    return { workspace: parts[0], repoSlug: parts[1] };
}

async function readTail(resp: Response, maxBytes: number): Promise<string> {
    if (maxBytes <= 0) return "";
    const buf = Buffer.from(await resp.arrayBuffer());
    const tail = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
    return tail.toString("utf8");
}

function toPullRequest(raw: unknown): PullRequest {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const source = (obj.source ?? {}) as Record<string, unknown>;
    const commit = (source.commit ?? {}) as Record<string, unknown>;
    const links = (obj.links ?? {}) as Record<string, unknown>;
    const html = (links.html ?? {}) as Record<string, unknown>;
    return {
        id: typeof obj.id === "number" ? obj.id : 0,
        url: typeof html.href === "string" ? html.href.trim() : "",
        state: typeof obj.state === "string" ? obj.state.trim() : "",
        sourceCommitHash: typeof commit.hash === "string" ? commit.hash.trim() : ""
    };
}

function toCommitStatus(raw: unknown): CommitStatus {
    const obj = (raw ?? {}) as Record<string, unknown>;
    return {
        name: typeof obj.name === "string" ? obj.name : "",
        key: typeof obj.key === "string" ? obj.key : "",
        state: typeof obj.state === "string" ? obj.state : "",
        description: typeof obj.description === "string" ? obj.description : "",
        url: typeof obj.url === "string" ? obj.url : ""
    };
}

function toPipeline(raw: unknown): Pipeline {
    const obj = (raw ?? {}) as Record<string, unknown>;
    return { uuid: typeof obj.uuid === "string" ? obj.uuid : "" };
}

function toPipelineStep(raw: unknown): PipelineStep {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const state = (obj.state ?? {}) as Record<string, unknown>;
    const result = (state.result ?? {}) as Record<string, unknown>;
    return {
        uuid: typeof obj.uuid === "string" ? obj.uuid : "",
        state: {
            name: typeof state.name === "string" ? state.name : "",
            result: { name: typeof result.name === "string" ? result.name : "" }
        }
    };
}

function repoPRPath(repo: RepoRef): string {
    return `/2.0/repositories/${repo.workspace}/${repo.repoSlug}/pullrequests`;
}

function lookupEnv(env: string[], key: string): string {
    const prefix = `${key}=`;
    for (const entry of env) {
        if (entry.startsWith(prefix)) return entry.slice(prefix.length);
    }
    const value = process.env[key];
    if (value !== undefined) return value;
    return "";
}

/** Host implements the SCM Host contract for Bitbucket via the REST API client. */
export class BitbucketHost implements types.Host {
    private readonly client: Client | null;
    private readonly repo: RepoRef;

    constructor(client: Client | null, repo: RepoRef) {
        this.client = client;
        this.repo = repo;
    }

    provider(): Provider {
        return PROVIDER_BITBUCKET;
    }

    // Bitbucket's REST API does not expose a reliable merge-conflict probe, so
    // MergeableState is off.
    capabilities(): types.Capabilities {
        return { mergeableState: false, failedCheckLogs: true };
    }

    async available(_signal?: AbortSignal): Promise<void> {
        if (this.client === null) throw new Error("bitbucket client is not configured");
    }

    async findPR(branch: string, base: string, signal?: AbortSignal): Promise<types.PR | null> {
        const pr = await this.client!.findOpenPRBySourceBranch(this.repo, branch, base, signal);
        if (pr === null) return null;
        return this.toPR(pr);
    }

    async createPR(branch: string, base: string, content: types.PRContent, signal?: AbortSignal): Promise<types.PR | null> {
        const pr = await this.client!.createPR(this.repo, branch, base, content.title, content.body, signal);
        return this.toPR(pr);
    }

    async updatePR(pr: types.PR, content: types.PRContent, signal?: AbortSignal): Promise<types.PR | null> {
        let id: number;
        try {
            id = atoi(pr.number);
        } catch (err) {
            throw new Error(`invalid Bitbucket PR number ${goQuote(pr.number)}: ${errMessage(err)}`);
        }
        const updated = await this.client!.updatePR(this.repo, id, content.title, content.body, signal);
        return this.toPR(updated);
    }

    async getPRState(pr: types.PR, signal?: AbortSignal): Promise<types.PRState> {
        const id = atoi(pr.number);
        const got = await this.client!.getPR(this.repo, id, signal);
        if (got === null) return "";
        return normalizePRState(got.state);
    }

    async getChecks(pr: types.PR, signal?: AbortSignal): Promise<types.Check[]> {
        const id = atoi(pr.number);
        const statuses = latestStatuses(await this.client!.listPRStatuses(this.repo, id, signal));
        return statuses.map((status) => ({
            name: statusName(status),
            bucket: statusBucket(status.state)
        }));
    }

    async getMergeableState(_pr: types.PR, _signal?: AbortSignal): Promise<types.MergeableState> {
        throw types.ERR_UNSUPPORTED;
    }

    async fetchFailedCheckLogs(
        pr: types.PR,
        _branch: string,
        headSHA: string,
        failingNames: string[],
        signal?: AbortSignal
    ): Promise<string> {
        if (this.client === null) return "";
        const client = this.client;
        const id = atoi(pr.number);
        let commitSHA = headSHA.trim();
        let targets: Set<string> | null = null;
        try {
            const got = await client.getPR(this.repo, id, signal);
            if (got !== null && got.sourceCommitHash.trim() !== "") {
                commitSHA = got.sourceCommitHash.trim();
            }
        } catch {
            // Go ignores a PR lookup error here.
        }
        try {
            const statuses = await client.listPRStatuses(this.repo, id, signal);
            targets = failedPipelineUUIDs(statuses, failingNames);
        } catch {
            // Go ignores a status lookup error here.
        }
        if (commitSHA.trim() === "") return "";
        let pipelines: Pipeline[];
        try {
            pipelines = await client.listPipelinesByCommit(this.repo, commitSHA, signal);
        } catch {
            return "";
        }
        for (const pipelineRun of pipelines) {
            if (targets !== null && targets.size > 0) {
                if (!targets.has(normalizePipelineUUID(pipelineRun.uuid))) continue;
            }
            let steps: PipelineStep[];
            try {
                steps = await client.listPipelineSteps(this.repo, pipelineRun.uuid, signal);
            } catch {
                continue;
            }
            for (const step of steps) {
                if (step.state.result.name.toUpperCase() !== "FAILED") continue;
                let logOutput: string;
                try {
                    logOutput = await client.getStepLog(this.repo, pipelineRun.uuid, step.uuid, signal);
                } catch {
                    continue;
                }
                if (logOutput.trim() === "") continue;
                return logOutput.trim();
            }
        }
        return "";
    }

    private toPR(pr: PullRequest | null): types.PR | null {
        if (pr === null) return null;
        return { number: String(pr.id), url: prURL(this.repo, pr.id, pr.url) };
    }
}

function prURL(repo: RepoRef, prID: number, rawURL: string): string {
    const url = rawURL.trim();
    if (url !== "") return url;
    if (prID <= 0 || repo.workspace.trim() === "" || repo.repoSlug.trim() === "") return "";
    return `https://bitbucket.org/${repo.workspace}/${repo.repoSlug}/pull-requests/${prID}`;
}

function normalizePRState(raw: string): types.PRState {
    switch (raw.trim().toUpperCase()) {
        case "OPEN":
            return types.PR_STATE_OPEN;
        case "MERGED":
            return types.PR_STATE_MERGED;
        case "DECLINED":
        case "CLOSED":
        case "SUPERSEDED":
            return types.PR_STATE_CLOSED;
        default:
            return raw;
    }
}

/**
 * LatestStatuses keeps only the newest status per unique key/name. Exported
 * because legacy step code still calls it by name during the migration.
 */
export function latestStatuses(statuses: CommitStatus[]): CommitStatus[] {
    const latest: CommitStatus[] = [];
    const seen = new Set<string>();
    for (const status of statuses) {
        let id = status.key.trim();
        if (id === "") id = statusName(status);
        if (id === "") {
            latest.push(status);
            continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        latest.push(status);
    }
    return latest;
}

function statusName(status: CommitStatus): string {
    const name = status.name.trim();
    if (name !== "") return name;
    return status.key.trim();
}

function statusBucket(state: string): types.CheckBucket {
    switch (state.trim().toUpperCase()) {
        case "SUCCESSFUL":
        case "SUCCESS":
            return types.CHECK_BUCKET_PASS;
        case "FAILED":
        case "FAILURE":
        case "ERROR":
            return types.CHECK_BUCKET_FAIL;
        case "STOPPED":
            return types.CHECK_BUCKET_CANCEL;
        case "INPROGRESS":
        case "IN_PROGRESS":
        case "PENDING":
            return types.CHECK_BUCKET_PENDING;
        default:
            return "";
    }
}

function normalizePipelineUUID(raw: string): string {
    const trimmed = raw.trim().replace(/^[{}]+|[{}]+$/g, "");
    if (trimmed === "") return "";
    return trimmed.toLowerCase();
}

function pipelineUUIDFromStatusURL(raw: string): string {
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        return "";
    }
    const fragments = [parsed.hash.replace(/^#/, ""), parsed.pathname];
    for (const fragment of fragments) {
        const idx = fragment.lastIndexOf("/results/");
        if (idx < 0) continue;
        let uuid = fragment.slice(idx + "/results/".length);
        uuid = uuid.split("?", 1)[0].trim();
        uuid = uuid.split("/", 1)[0].trim();
        return normalizePipelineUUID(uuid);
    }
    return "";
}

function failedPipelineUUIDs(statuses: CommitStatus[], failingNames: string[]): Set<string> | null {
    if (failingNames.length === 0) return null;
    const failing = new Set<string>();
    for (const name of failingNames) {
        const trimmed = name.trim();
        if (trimmed !== "") failing.add(trimmed);
    }
    if (failing.size === 0) return null;
    const targets = new Set<string>();
    for (const status of latestStatuses(statuses)) {
        if (!failing.has(statusName(status))) continue;
        const uuid = pipelineUUIDFromStatusURL(status.url);
        if (uuid !== "") targets.add(uuid);
    }
    if (targets.size === 0) return null;
    return targets;
}

/** Parses a base-10 integer, throwing a Go-style strconv error on bad input. */
function atoi(s: string): number {
    if (!/^[+-]?\d+$/.test(s)) {
        throw new Error(`strconv.Atoi: parsing ${goQuote(s)}: invalid syntax`);
    }
    return Number(s);
}

/** Combines the caller's signal with a 30s timeout, mirroring http.Client.Timeout. */
function withTimeout(signal: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    if (signal === undefined) return timeout;
    return AbortSignal.any([signal, timeout]);
}

function basicAuth(email: string, token: string): string {
    return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

/** Approximates Go's `%q` verb for the printable strings used in queries/errors. */
function goQuote(s: string): string {
    return JSON.stringify(s);
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** NewHost builds a Host from an API client and a parsed repository reference. */
export function newBitbucketHost(client: Client | null, repo: RepoRef): BitbucketHost {
    return new BitbucketHost(client, repo);
}
