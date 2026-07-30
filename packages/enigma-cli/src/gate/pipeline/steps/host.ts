/**
 * Resolves a provider-agnostic scm.Host for a pipeline step, wired to the
 * StepContext's working directory and environment. Faithful port of the
 * upstream `internal/pipeline/steps/host.go`, plus `resolveBitbucketRepoRef`
 * (Go's ci_bitbucket.go) which host.go depends on.
 *
 * Go built one `cmdFactory` returning `*exec.Cmd` for every provider client. The
 * ported TS scm clients diverged: gitlab and bitbucket implement the
 * `scm/types` Host interface directly, but github's client uses a signal-first
 * method order and a different Cmd shape. So this port builds a per-provider
 * command factory over the shared `stepCmd`, and wraps the github client in an
 * adapter that conforms it to the scm.Host interface. Go's `(host, reason)`
 * tuple maps to `[Host | null, string]`.
 */

import type { StepContext } from "../types";
import { stepCmd, stepCLIAvailable, type StepCmd } from "./commonExec";
import { newClientFromEnv, newBitbucketHost, parseRepoRef, type RepoRef } from "../../scm/bitbucket";
import { newGitLabHost, type Cmd as GitLabCmd, type CmdFactory as GitLabCmdFactory } from "../../scm/gitlab";
import {
    type Provider,
    repoSlug,
    PROVIDER_GITHUB,
    PROVIDER_GITLAB,
    PROVIDER_BITBUCKET
} from "../../scm/host";
import {
    type PR,
    type Host,
    type Check,
    type PRContent,
    type Capabilities,
    type PRState,
    type MergeableState
} from "../../scm/types";
import {
    NewWithFork as newGitHubHostWithFork,
    type Host as GitHubHost,
    type Cmd as GitHubCmd,
    type CmdFactory as GitHubCmdFactory
} from "../../scm/github";

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Wraps a StepCmd to the github client's Cmd shape ({out, err} results). */
function wrapGitHubCmd(sc: StepCmd): GitHubCmd {
    const cmd: GitHubCmd = {
        run: () => sc.run(),
        output: async () => {
            const r = await sc.output();
            return { out: r.stdout, err: r.err };
        },
        combinedOutput: () => sc.combinedOutput(),
        withStdin: (text: string) => {
            sc.withStdin(text);
            return cmd;
        }
    };
    return cmd;
}

/** Wraps a StepCmd to the gitlab client's Cmd shape ([string, err] tuples). */
function wrapGitLabCmd(sc: StepCmd): GitLabCmd {
    return {
        run: () => sc.run(),
        combinedOutput: async () => {
            const r = await sc.combinedOutput();
            return [r.out, r.err] as [string, Error | null];
        },
        output: async () => {
            const r = await sc.output();
            return [r.stdout, r.err] as [string, Error | null];
        }
    };
}

/**
 * Conforms the signal-first github client to the scm.Host interface (signal
 * trailing, throw-on-error available).
 */
function adaptGitHubHost(gh: GitHubHost): Host {
    return {
        provider: () => gh.provider(),
        capabilities: (): Capabilities => gh.capabilities(),
        available: async signal => {
            const err = await gh.available(signal);
            if (err !== null) throw err;
        },
        findPR: (branch, base, signal) => gh.findPR(signal, branch, base),
        createPR: (branch, base, content, signal) => gh.createPR(signal, branch, base, content),
        updatePR: (pr, content, signal) => gh.updatePR(signal, pr, content),
        getPRState: (pr, signal) => gh.getPRState(signal, pr),
        getChecks: async (pr, signal): Promise<Check[]> =>
            (await gh.getChecks(signal, pr)).map(c => ({
                name: c.name,
                bucket: c.bucket,
                completedAt: c.completedAt ?? undefined
            })),
        getMergeableState: (pr, signal) => gh.getMergeableState(signal, pr),
        fetchFailedCheckLogs: (pr, branch, headSHA, failingNames, signal) =>
            gh.fetchFailedCheckLogs(signal, pr, branch, headSHA, failingNames)
    };
}

/**
 * Parses a Bitbucket repo reference from the upstream URL, falling back to the PR
 * URL when the upstream is not a Bitbucket URL. (Ported from ci_bitbucket.go.)
 */
function resolveBitbucketRepoRef(upstreamURL: string, prURL: string | null): RepoRef {
    try {
        return parseRepoRef(upstreamURL);
    } catch {
        // Not a Bitbucket upstream URL; fall back to the PR URL.
    }
    if (prURL !== null && prURL.trim() !== "") {
        return parseRepoRef(prURL);
    }
    throw new Error(`resolve Bitbucket repository from upstream ${JSON.stringify(upstreamURL)}`);
}

/**
 * Returns an scm.Host for the given provider, wired to sctx's working directory
 * and environment. When the host cannot be constructed (unknown provider,
 * missing Bitbucket config, etc) it returns [null, reason] with a human-readable
 * skip reason suitable for logging.
 */
export function buildHost(sctx: StepContext, provider: Provider): [Host | null, string] {
    switch (provider) {
        case PROVIDER_GITHUB: {
            // Resolve the owner/name slug so gh commands carry --repo and work from
            // the daemon's fixed (non-repo) working directory. Fall back to the PR
            // URL when the upstream remote URL is unavailable.
            let repo = repoSlug(sctx.repo.upstreamUrl);
            if (repo === "" && sctx.run.prUrl !== null) {
                repo = repoSlug(sctx.run.prUrl);
            }
            let forkRepo = "";
            if (sctx.repo.forkUrl !== "") {
                forkRepo = repoSlug(sctx.repo.forkUrl);
            }
            const cmdFactory: GitHubCmdFactory = (_signal, name, ...args) =>
                wrapGitHubCmd(stepCmd(sctx, name, ...args));
            const gh = newGitHubHostWithFork(cmdFactory, () => stepCLIAvailable(sctx, provider), repo, forkRepo);
            return [adaptGitHubHost(gh), ""];
        }
        case PROVIDER_GITLAB: {
            if (sctx.repo.forkUrl !== "") {
                // Fork MR routing for GitLab is intentionally not half-wired. The
                // push step may use fork_url, but PR creation must skip until
                // GitLab source-project routing is implemented end to end.
                return [null, "fork PR routing for GitLab is not implemented"];
            }
            const cmdFactory: GitLabCmdFactory = (_signal, name, ...args) =>
                wrapGitLabCmd(stepCmd(sctx, name, ...args));
            return [newGitLabHost(cmdFactory, () => stepCLIAvailable(sctx, provider)), ""];
        }
        case PROVIDER_BITBUCKET: {
            if (sctx.repo.forkUrl !== "") {
                // Fork PR routing for Bitbucket is intentionally not half-wired. The
                // API needs distinct source and destination repositories before
                // this provider can safely consume fork_url for PR creation.
                return [null, "fork PR routing for Bitbucket is not implemented"];
            }
            let client;
            try {
                client = newClientFromEnv(sctx.env);
            } catch (err) {
                return [null, errMessage(err)];
            }
            let repo: RepoRef;
            try {
                repo = resolveBitbucketRepoRef(sctx.repo.upstreamUrl, sctx.run.prUrl);
            } catch (err) {
                return [null, errMessage(err)];
            }
            return [newBitbucketHost(client, repo), ""];
        }
        default:
            return [null, `provider ${provider} is not supported yet`];
    }
}
