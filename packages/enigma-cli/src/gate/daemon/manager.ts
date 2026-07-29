/**
 * The run manager: tracks active pipeline executors and drives run lifecycle
 * (push-received, rerun, respond, cancel, shutdown) plus the event subscriber
 * fan-out. Faithful port of the Go `internal/daemon/manager.go` `RunManager`.
 *
 * Concurrency mapping (Go -> TS):
 * - `context.WithCancelCause` -> an `AbortController` per run; the cancel cause
 *   is the abort `reason` (an `Error` whose message is the cancel reason), which
 *   the executor reads to set the run's cancelled/failed error message.
 * - per-run goroutine + `done` channel -> an async task tracked in `dones` as a
 *   Promise that settles when the task finishes; `cancelActiveRuns`/`shutdown`
 *   await those with a 30s timeout.
 * - `branchLocks` (`sync.Map` of `sync.Mutex`) -> a per-key async lock that
 *   serializes the synchronous setup of `startRun` so two concurrent pushes to
 *   the same repo+branch cannot both create a pipeline.
 * - `subscribers` channels -> per-run subscriber records with a bounded (64)
 *   queue + a single waiter, drained by an async iterator; a full queue drops
 *   the event (Go's buffered-channel `default`).
 *
 * SECURITY (the run trust boundary): `startRun` fetches the repo's default
 * branch, resolves it to an exact commit SHA, and reads `.enigma-gate.yaml` at
 * that PINNED SHA. On any fetch/resolve failure the trusted SHA stays empty,
 * `loadTrustedRepoConfig` returns null, and `effectiveRepoConfig` forces empty
 * commands/agent - fail closed. The pushed branch can never inject commands/agent
 * or self-enable `allow_repo_commands`.
 */

import { log } from "../log";
import { track } from "../telemetry";
import type { Paths } from "../paths";
import { writeSnapshot } from "./snapshot";
import { type Agent } from "../agent/agent";
import type { Step } from "../pipeline/types";
import { Executor } from "../pipeline/executor";
import { withSteering } from "../agent/steering";
import { allPipelineSteps } from "../pipeline/steps";
import { createAgent, lookPath } from "../agent/factory";
import type { PushReceivedParams } from "../ipc/protocol";
import { EventLogChunk, type Event } from "../ipc/protocol";
import {
    merge,
    loadRepo,
    loadGlobal,
    resolveAgent,
    type RepoConfig,
    effectiveRepoConfig,
    loadRepoFromBytes
} from "../config";
import {
    type StepName,
    type Finding,
    type ApprovalAction,
    RUN_CANCEL_REASON_SUPERSEDED,
    RUN_CANCEL_REASON_ABORTED_BY_USER
} from "../types";
import {
    run as gitRun,
    showFile,
    isZeroSHA,
    resolveRef,
    worktreeAdd,
    worktreeRemove,
    fetchRemoteBranch,
    copyLocalUserIdentity
} from "../git";
import {
    type Run,
    type Repo,
    type Database,
    getRepo,
    insertRun,
    getStepsByRun,
    updateRunError,
    updateRunIntent,
    getRunsByRepo,
    updateRunErrorStatus
} from "../db";

/** Builds the pipeline steps for a run; defaults to `allPipelineSteps`. */
export type StepFactory = () => Step[];

/** A registered event subscriber: a bounded queue feeding one async iterator. */
interface Subscriber {
    queue: Event[];
    waiting: ((r: IteratorResult<Event>) => void) | null;
    done: boolean;
}

/** A live subscription: an async event stream plus an unsubscribe function. */
export interface Subscription {
    events: AsyncIterableIterator<Event>;
    unsubscribe: () => void;
}

const MAX_SUBSCRIBER_QUEUE = 64;
const CANCEL_WAIT_TIMEOUT_MS = 30_000;
const SHUTDOWN_WAIT_TIMEOUT_MS = 30_000;

/** Tracks active pipeline executors and manages run lifecycle. */
export class RunManager {
    private readonly executors = new Map<string, Executor>();
    private readonly cancels = new Map<string, AbortController>();
    private readonly dones = new Map<string, Promise<void>>();
    private readonly branchChains = new Map<string, Promise<void>>();
    private shuttingDown = false;

    private readonly subscribers = new Map<string, Subscriber[]>();
    private readonly completedRuns = new Set<string>();
    private completedOrder: string[] = [];

    private readonly steps: StepFactory;

    /** Creates a RunManager. Pass undefined for stepFactory to use default steps. */
    constructor(
        private readonly db: Database,
        private readonly paths: Paths,
        stepFactory?: StepFactory
    ) {
        this.steps = stepFactory ?? allPipelineSteps;
    }

    /**
     * Registers a subscription to a run's events. If the run already completed,
     * the returned stream is immediately closed (an empty iterator).
     */
    subscribe(runID: string): Subscription {
        if (this.completedRuns.has(runID)) {
            return { events: closedIterator(), unsubscribe: () => {} };
        }
        const sub: Subscriber = { queue: [], waiting: null, done: false };
        const list = this.subscribers.get(runID);
        if (list) list.push(sub);
        else this.subscribers.set(runID, [sub]);

        const unsubscribe = (): void => {
            const subs = this.subscribers.get(runID);
            if (!subs) return;
            const i = subs.indexOf(sub);
            if (i !== -1) subs.splice(i, 1);
        };

        const events: AsyncIterableIterator<Event> = {
            [Symbol.asyncIterator]() {
                return this;
            },
            next(): Promise<IteratorResult<Event>> {
                if (sub.queue.length > 0) return Promise.resolve({ value: sub.queue.shift()!, done: false });
                if (sub.done) return Promise.resolve({ value: undefined as unknown as Event, done: true });
                return new Promise(resolve => {
                    sub.waiting = resolve;
                });
            },
            return(): Promise<IteratorResult<Event>> {
                unsubscribe();
                return Promise.resolve({ value: undefined as unknown as Event, done: true });
            }
        };
        return { events, unsubscribe };
    }

    /**
     * Sends an event to all subscribers of the event's run (drops to slow ones),
     * and refreshes the status-bar snapshot. The snapshot is updated before the
     * fan-out and regardless of whether anyone is subscribed, because the status
     * bar is a file reader rather than an IPC subscriber. Log chunks are skipped:
     * they carry no state the bar shows and arrive far too often to rewrite on.
     */
    private broadcast = (event: Event): void => {
        if (event.type !== EventLogChunk) writeSnapshot(this.db, this.paths, event.runId);
        const subs = this.subscribers.get(event.runId);
        if (!subs) return;
        for (const sub of subs) this.pushEvent(sub, event);
    };

    private pushEvent(sub: Subscriber, event: Event): void {
        if (sub.waiting) {
            const resolve = sub.waiting;
            sub.waiting = null;
            resolve({ value: event, done: false });
            return;
        }
        if (sub.queue.length < MAX_SUBSCRIBER_QUEUE) {
            sub.queue.push(event);
            return;
        }
        log.debug("dropped event for slow subscriber", "run_id", event.runId, "type", event.type);
    }

    /**
     * Closes all subscribers for a run and marks it completed, so future
     * `subscribe` calls return an immediately-closed stream. Evicts the oldest
     * half of the completed set once it exceeds 1000 entries.
     */
    private closeSubscribers(runID: string): void {
        const subs = this.subscribers.get(runID);
        if (subs) {
            for (const sub of subs) {
                sub.done = true;
                if (sub.waiting) {
                    const resolve = sub.waiting;
                    sub.waiting = null;
                    resolve({ value: undefined as unknown as Event, done: true });
                }
            }
        }
        this.subscribers.delete(runID);
        this.completedRuns.add(runID);
        this.completedOrder.push(runID);
        if (this.completedOrder.length > 1000) {
            const half = Math.floor(this.completedOrder.length / 2);
            for (const id of this.completedOrder.slice(0, half)) this.completedRuns.delete(id);
            this.completedOrder = this.completedOrder.slice(half);
        }
    }

    /**
     * Processes a push notification from the post-receive hook: creates a run,
     * provisions a worktree, and launches the pipeline. A ref-deletion push
     * (all-zeros new SHA) is rejected with no pipeline to run.
     */
    async handlePushReceived(params: PushReceivedParams): Promise<string> {
        if (isZeroSHA(params.new)) {
            throw new Error("ref deletion push, no pipeline to run");
        }
        const repoID = repoIDFromGatePath(params.gate);
        let repo: Repo | null;
        try {
            repo = getRepo(this.db, repoID);
        } catch (err) {
            throw new Error(`get repo: ${errMessage(err)}`);
        }
        if (repo === null) throw new Error(`unknown repo for gate ${params.gate}`);

        const branch = branchFromRef(params.ref);
        return this.startRun(repo, branch, params.new, params.old, "push", params.skipSteps ?? [], params.intent ?? "");
    }

    /**
     * Creates a new run for the latest gate head on a branch, carrying an optional
     * agent-supplied intent. The base SHA reuses the matching prior run's base
     * when one exists, else the latest run's base for that branch.
     */
    async handleRerun(repoID: string, branch: string, skipSteps: StepName[], intent: string): Promise<string> {
        let repo: Repo | null;
        try {
            repo = getRepo(this.db, repoID);
        } catch (err) {
            throw new Error(`get repo: ${errMessage(err)}`);
        }
        if (repo === null) throw new Error(`unknown repo ${repoID}`);

        const gateDir = this.paths.repoDir(repo.id);
        let headSHA: string;
        try {
            headSHA = await gitRun(gateDir, ["rev-parse", `refs/heads/${branch}^{commit}`]);
        } catch (err) {
            throw new Error(`resolve gate head: ${errMessage(err)}`);
        }

        let runs: Run[];
        try {
            runs = getRunsByRepo(this.db, repoID);
        } catch (err) {
            throw new Error(`get runs: ${errMessage(err)}`);
        }

        let latestForBranch: Run | null = null;
        let matchingHead: Run | null = null;
        for (const run of runs) {
            if (run.branch !== branch) continue;
            if (latestForBranch === null) latestForBranch = run;
            if (run.headSha === headSHA) {
                matchingHead = run;
                break;
            }
        }
        if (latestForBranch === null) throw new Error(`no previous run for branch ${branch}`);

        const baseSHA = matchingHead !== null ? matchingHead.baseSha : latestForBranch.baseSha;
        return this.startRun(repo, branch, headSHA, baseSHA, "rerun", skipSteps, intent);
    }

    /**
     * Creates a run, sets up a disposable worktree, resolves the effective config
     * (fail-closed on the trust boundary), builds the agent, and launches the
     * pipeline in the background. Serialized per repo+branch.
     */
    private async startRun(
        repo: Repo,
        branch: string,
        headSHA: string,
        baseSHA: string,
        trigger: string,
        skipSteps: StepName[],
        intent: string
    ): Promise<string> {
        const branchRole = telemetryBranchRole(branch, repo.defaultBranch);
        const trackStartFailure = (stage: string): void => {
            track("run", { action: "start_failed", trigger, branch_role: branchRole, stage });
        };

        if (this.shuttingDown) {
            trackStartFailure("daemon_shutdown");
            throw new Error("daemon is shutting down");
        }

        // Serialize per repo+branch so two concurrent pushes cannot both pass
        // cancelActiveRuns and create duplicate pipelines.
        const lockKey = `${repo.id}/${branch}`;
        const release = await this.acquireBranchLock(lockKey);
        try {
            return await this.startRunLocked(repo, branch, headSHA, baseSHA, trigger, skipSteps, intent, branchRole, trackStartFailure);
        } finally {
            release();
        }
    }

    private async startRunLocked(
        repo: Repo,
        branch: string,
        headSHA: string,
        baseSHA: string,
        trigger: string,
        skipSteps: StepName[],
        intent: string,
        branchRole: string,
        trackStartFailure: (stage: string) => void
    ): Promise<string> {
        // Cancel any active run for this repo+branch and wait for it to exit.
        await this.cancelActiveRuns(repo.id, branch);

        let run: Run;
        try {
            run = insertRun(this.db, repo.id, branch, headSHA, baseSHA);
        } catch (err) {
            trackStartFailure("create_run");
            throw new Error(`create run: ${errMessage(err)}`);
        }

        // Stamp an agent-supplied intent before the pipeline starts so the intent
        // step uses it instead of inferring. A persist failure is non-fatal.
        const trimmed = intent.trim();
        if (trimmed !== "") {
            try {
                updateRunIntent(this.db, run.id, { summary: trimmed, source: "agent", sessionId: "", score: 1 });
                run.intent = trimmed;
                run.intentSource = "agent";
                run.intentScore = 1;
            } catch (err) {
                log.warn("failed to persist agent-supplied intent", "run_id", run.id, "error", errMessage(err));
            }
        }

        // Provision a disposable worktree from the gate bare repo.
        const gateDir = this.paths.repoDir(repo.id);
        const wtDir = this.paths.worktreeDir(repo.id, run.id);
        try {
            await worktreeAdd(gateDir, wtDir, headSHA);
        } catch (err) {
            updateRunError(this.db, run.id, `create worktree: ${errMessage(err)}`);
            trackStartFailure("create_worktree");
            throw new Error(`create worktree: ${errMessage(err)}`);
        }
        // Matches Go: an identity-copy failure here does NOT remove the worktree
        // (the cleanup is registered only below). A leaked worktree is reclaimed
        // by removeOrphanedWorktrees on the next daemon start.
        try {
            await copyLocalUserIdentity(repo.workingPath, wtDir);
        } catch (err) {
            updateRunError(this.db, run.id, `configure worktree git identity: ${errMessage(err)}`);
            trackStartFailure("configure_worktree_identity");
            throw new Error(`configure worktree git identity: ${errMessage(err)}`);
        }

        // From here on, on any setup failure we must remove the worktree, unless
        // the background task took ownership of cleanup.
        let bgOwnsWorktree = false;
        const cleanupWorktree = async (): Promise<void> => {
            if (bgOwnsWorktree) return;
            try {
                await worktreeRemove(gateDir, wtDir);
            } catch (rmErr) {
                log.warn("failed to remove worktree during setup cleanup", "path", wtDir, "error", errMessage(rmErr));
            }
        };

        try {
            // SECURITY: fetch the trusted default branch and resolve it to an
            // exact commit SHA before any read. Reading the trusted config at this
            // PINNED SHA (not the origin/<defaultBranch> ref name) is what makes a
            // fetch/resolve failure fail closed: trustedSHA stays empty,
            // loadTrustedRepoConfig returns null, and effectiveRepoConfig drops the
            // pushed branch's commands/agent.
            let trustedSHA = "";
            if (repo.defaultBranch !== "") {
                try {
                    await fetchRemoteBranch(wtDir, "origin", repo.defaultBranch);
                    try {
                        trustedSHA = await resolveRef(wtDir, `refs/remotes/origin/${repo.defaultBranch}`);
                    } catch (err) {
                        log.warn("failed to resolve fetched default-branch ref; trusted config disabled", "run_id", run.id, "branch", repo.defaultBranch, "error", errMessage(err));
                    }
                } catch (err) {
                    log.warn("failed to fetch default branch into worktree; trusted config disabled (commands/agent from pushed branch will be dropped)", "run_id", run.id, "branch", repo.defaultBranch, "error", errMessage(err));
                }
            }

            let globalCfg;
            try {
                globalCfg = loadGlobal(this.paths.configFile());
            } catch (err) {
                updateRunError(this.db, run.id, `load config: ${errMessage(err)}`);
                trackStartFailure("load_global_config");
                throw new Error(`load global config: ${errMessage(err)}`);
            }
            let repoCfg: RepoConfig;
            try {
                repoCfg = loadRepo(wtDir);
            } catch (err) {
                updateRunError(this.db, run.id, `load config: ${errMessage(err)}`);
                trackStartFailure("load_repo_config");
                throw new Error(`load repo config: ${errMessage(err)}`);
            }

            // SECURITY: the code-executing fields (commands.* and agent) come ONLY
            // from the trusted default-branch copy. allow_repo_commands is itself
            // read only from the trusted copy, so a contributor cannot self-enable
            // it from the pushed branch. No trusted copy -> forced empty.
            const trustedRepoCfg = await loadTrustedRepoConfig(wtDir, trustedSHA, run.id);
            const allowRepoCommands = trustedRepoCfg !== null && trustedRepoCfg.allowRepoCommands;
            const effectiveRepoCfg = effectiveRepoConfig(repoCfg, trustedRepoCfg, allowRepoCommands);
            if (allowRepoCommands) {
                log.warn("allow_repo_commands is enabled on the default branch: honoring commands/agent from pushed branch", "run_id", run.id, "branch", branch);
            } else if (!commandsEqual(repoCfg, effectiveRepoCfg) || repoCfg.agent !== effectiveRepoCfg.agent) {
                log.info("repo commands/agent loaded from default branch, not pushed branch", "run_id", run.id, "branch", branch, "default_branch", repo.defaultBranch);
            }
            const cfg = merge(globalCfg, effectiveRepoCfg);

            // Resolve the agent selector, build the backend, and steer it. Steering
            // is applied HERE, exactly where Go's startRun wraps it.
            let ag: Agent;
            try {
                await resolveAgent(cfg, lookPath);
            } catch (err) {
                updateRunError(this.db, run.id, errMessage(err));
                trackStartFailure("resolve_agent");
                throw err;
            }
            try {
                ag = createAgent(cfg, this.paths, { acpRegistryOverrides: cfg.acpRegistryOverrides });
            } catch (err) {
                updateRunError(this.db, run.id, `create agent: ${errMessage(err)}`);
                trackStartFailure("create_agent");
                throw new Error(`create agent: ${errMessage(err)}`);
            }
            ag = withSteering(ag) as Agent;

            const execSteps = this.steps();
            track("run", {
                action: "started",
                trigger,
                agent: cfg.agent,
                branch_role: branchRole,
                step_count: execSteps.length,
                demo_mode: false
            });

            // Create the executor with a cancellable controller (the cancel cause
            // drives the run's cancelled/failed message).
            const controller = new AbortController();
            const executor = new Executor(this.db, this.paths, cfg, ag, execSteps, this.broadcast);
            executor.setSkippedSteps(skipSteps);

            this.executors.set(run.id, executor);
            this.cancels.set(run.id, controller);

            // The background task now owns worktree cleanup.
            bgOwnsWorktree = true;
            const task = this.runPipeline(executor, controller, ag, run, repo, gateDir, wtDir, trigger, branchRole, cfg.agent, execSteps.length);
            this.dones.set(run.id, task);

            return run.id;
        } finally {
            await cleanupWorktree();
        }
    }

    /**
     * Background pipeline task: runs the executor, records terminal telemetry,
     * then (always) closes the agent, ends subscribers, removes the worktree, and
     * clears tracking - the TS equivalent of the Go goroutine's deferred cleanup.
     */
    private async runPipeline(
        executor: Executor,
        controller: AbortController,
        ag: Agent,
        run: Run,
        repo: Repo,
        gateDir: string,
        wtDir: string,
        trigger: string,
        branchRole: string,
        agentName: string,
        stepCount: number
    ): Promise<void> {
        const startedAt = Date.now();
        const finishedFields = () => ({
            action: "finished",
            trigger,
            agent: agentName,
            branch_role: branchRole,
            status: run.status,
            duration_ms: Date.now() - startedAt,
            step_count: stepCount,
            pr_created: run.prUrl != null && run.prUrl !== ""
        });
        try {
            await executor.execute(controller.signal, run, repo, wtDir);
            track("run", finishedFields());
            log.info("pipeline completed", "run_id", run.id);
        } catch (err) {
            // The executor persists the run status before throwing; mirror Go's
            // panic-recover safety for an unexpected throw that left a non-terminal
            // status by recording the failure.
            if (run.status !== "failed" && run.status !== "cancelled" && run.status !== "completed") {
                const msg = `internal error: ${errMessage(err)}`;
                log.error("panic in pipeline task", "run_id", run.id, "error", errMessage(err));
                run.status = "failed";
                run.error = msg;
                try {
                    updateRunErrorStatus(this.db, run.id, msg, "failed");
                } catch (dbErr) {
                    log.error("failed to update run after panic", "run_id", run.id, "error", errMessage(dbErr));
                }
            }
            const fields = finishedFields();
            const failedStep = this.failedStepName(run.id);
            track("run", failedStep !== "" ? { ...fields, failed_step: failedStep } : fields);
            log.error("pipeline failed", "run_id", run.id, "error", errMessage(err));
        } finally {
            try {
                await ag.close();
            } catch {
                // Agent close is best-effort.
            }
            this.closeSubscribers(run.id);
            try {
                await worktreeRemove(gateDir, wtDir);
            } catch (rmErr) {
                log.warn("failed to remove worktree", "path", wtDir, "error", errMessage(rmErr));
            }
            this.executors.delete(run.id);
            this.cancels.delete(run.id);
            this.dones.delete(run.id);
        }
    }

    /** Routes a user approval action to the executor for the given run. */
    handleRespond(runID: string, step: StepName, action: ApprovalAction, findingIDs: string[]): void {
        this.handleRespondWithOverrides(runID, step, action, findingIDs, null, null);
    }

    /** Like handleRespond but also forwards user instructions and added findings. */
    handleRespondWithOverrides(
        runID: string,
        step: StepName,
        action: ApprovalAction,
        findingIDs: string[],
        instructions: Record<string, string> | null,
        addedFindings: Finding[] | null
    ): void {
        const exec = this.executors.get(runID);
        if (!exec) throw new Error(`no active executor for run ${runID}`);
        exec.respondWithOverrides(step, action, findingIDs, instructions, addedFindings);
    }

    /** Stops an active run, propagating an aborted-by-user cancel to the executor. */
    handleCancel(runID: string): void {
        const controller = this.cancels.get(runID);
        if (!controller) throw new Error(`no active run ${runID}`);
        controller.abort(new Error(RUN_CANCEL_REASON_ABORTED_BY_USER));
    }

    /**
     * Cancels all active runs and waits (bounded) for their tasks to finish.
     * Called during daemon shutdown to stop orphaned agent calls and git ops.
     */
    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        const tasks: Promise<void>[] = [];
        for (const [id, controller] of this.cancels) {
            controller.abort(new Error("daemon shutting down"));
            log.info("cancelled run on shutdown", "run_id", id);
            const done = this.dones.get(id);
            if (done) tasks.push(done);
        }
        await waitWithTimeout(tasks, SHUTDOWN_WAIT_TIMEOUT_MS, () => {
            log.warn("timed out waiting for runs to finish during shutdown");
        });
    }

    /**
     * Cancels any in-progress runs for the repo+branch (cause: superseded) and
     * waits for their tasks to finish, preventing concurrent pushes to upstream.
     */
    private async cancelActiveRuns(repoID: string, branch: string): Promise<void> {
        let runs: Run[];
        try {
            runs = getRunsByRepo(this.db, repoID);
        } catch (err) {
            log.error("failed to query active runs for cancellation", "repo", repoID, "branch", branch, "error", errMessage(err));
            return;
        }
        const toWait: Promise<void>[] = [];
        for (const run of runs) {
            if (run.branch !== branch) continue;
            if (run.status !== "pending" && run.status !== "running") continue;
            const controller = this.cancels.get(run.id);
            const done = this.dones.get(run.id);
            if (!controller) continue;
            controller.abort(new Error(RUN_CANCEL_REASON_SUPERSEDED));
            log.info("cancelled active run", "run_id", run.id, "repo_id", repoID, "branch", branch);
            if (done) toWait.push(done);
        }
        await waitWithTimeout(toWait, CANCEL_WAIT_TIMEOUT_MS, () => {
            log.warn("timed out waiting for cancelled runs to finish");
        });
    }

    /** Returns the name of the first failed step of a run, or "" when none. */
    private failedStepName(runID: string): string {
        try {
            const steps = getStepsByRun(this.db, runID);
            for (const step of steps) {
                if (step.status === "failed") return step.stepName;
            }
        } catch {
            return "";
        }
        return "";
    }

    /** Acquires the per-key serialization lock, returning its release function. */
    private acquireBranchLock(key: string): Promise<() => void> {
        const prev = this.branchChains.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        this.branchChains.set(key, prev.then(() => gate));
        return prev.then(() => release);
    }
}

/**
 * Reads `.enigma-gate.yaml` from the trusted default-branch commit (`trustedSHA`,
 * the exact SHA startRun fetched and resolved) and parses it. Returns null when
 * the SHA is empty (fetch failed / no default branch / unresolved ref), the file
 * is absent at that SHA, or it fails to parse - every failure makes the caller
 * fail closed by dropping the pushed branch's commands/agent.
 */
export async function loadTrustedRepoConfig(wtDir: string, trustedSHA: string, runID: string): Promise<RepoConfig | null> {
    if (trustedSHA === "") return null;
    let content: string;
    try {
        content = await showFile(wtDir, trustedSHA, ".enigma-gate.yaml");
    } catch (err) {
        // Path absent on the default branch is the common "no trusted commands"
        // case (logged at debug); any read error still fails closed (null).
        log.debug("trusted repo config: not present on default branch", "run_id", runID, "sha", trustedSHA, "error", errMessage(err));
        return null;
    }
    try {
        return loadRepoFromBytes(content);
    } catch (err) {
        log.warn("trusted repo config: parse failed; commands/agent from pushed branch will be disabled", "run_id", runID, "sha", trustedSHA, "error", errMessage(err));
        return null;
    }
}

/** Extracts the repo ID from a gate bare repo path (`<root>/repos/<id>.git`). */
export function repoIDFromGatePath(gatePath: string): string {
    const base = baseName(gatePath);
    if (!base.endsWith(".git")) throw new Error(`invalid gate path: ${gatePath}`);
    return base.slice(0, -".git".length);
}

/** Extracts the branch name from a full git ref (`refs/heads/main` -> `main`). */
export function branchFromRef(ref: string): string {
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function telemetryBranchRole(branch: string, defaultBranch: string): string {
    if (branch === "") return "unknown";
    if (defaultBranch !== "" && branch === defaultBranch) return "default";
    return "feature";
}

function commandsEqual(a: RepoConfig, b: RepoConfig): boolean {
    return a.commands.lint === b.commands.lint && a.commands.test === b.commands.test && a.commands.format === b.commands.format;
}

/** Awaits all tasks, invoking onTimeout when the bound elapses first. */
async function waitWithTimeout(tasks: Promise<void>[], ms: number, onTimeout: () => void): Promise<void> {
    if (tasks.length === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<"timeout">(resolve => {
        timer = setTimeout(() => resolve("timeout"), ms);
        timer.unref?.();
    });
    const all = Promise.all(tasks).then(() => "done" as const);
    const result = await Promise.race([all, timeout]);
    clearTimeout(timer!);
    if (result === "timeout") onTimeout();
}

/** Returns an already-exhausted async iterator (for completed runs). */
function closedIterator(): AsyncIterableIterator<Event> {
    return {
        [Symbol.asyncIterator]() {
            return this;
        },
        next(): Promise<IteratorResult<Event>> {
            return Promise.resolve({ value: undefined as unknown as Event, done: true });
        }
    };
}

function baseName(p: string): string {
    const normalized = p.replace(/[\\/]+$/, "");
    const i = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    return i === -1 ? normalized : normalized.slice(i + 1);
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
