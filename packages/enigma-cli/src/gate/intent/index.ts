/**
 * Faithful port of upstream's `internal/intent/intent.go`: the top-level
 * `extract` orchestrator that runs the discover -> match -> optional
 * disambiguate -> cache -> summarize pipeline for a single run, plus the
 * `ExtractParams`/`Result` contract the intent step and daemon use.
 *
 * Go returned `(*Result, error)`; here `extract` resolves to a `Result` and
 * rejects with `ErrNoMatch` (a shared sentinel) when no transcript matches, or
 * with a wrapped error on summarization/disambiguation failure. Go's
 * `context.Context` is an optional trailing `AbortSignal`.
 */

import { log } from "../log";
import type { Cache } from "./cache";
import { newMemCache } from "./cache";
import { cacheKeyFor } from "./cache";
import type { Match } from "./matcher";
import { canonicalPath } from "./paths";
import type { Summarizer } from "./summarizer";
import type { Disambiguator } from "./disambiguator";
import { isDisambiguatorCleanup } from "./disambiguator";
import type { Reader, Session, DiscoverOpts } from "./reader";
import { pickMatchWithOptions, acceptedMatches, shouldDisambiguate } from "./matcher";

/**
 * Result is what extract returns when it successfully attaches an intent to a
 * run. agentName/sessionId/score are surfaced for telemetry and DB persistence;
 * callers store the summary onto the run's intent field.
 */
export interface Result {
    summary: string;
    agentName: string;
    sessionId: string;
    score: number;
}

/** Configures a single extract call. */
export interface ExtractParams {
    /** Overrides the user's home directory. Empty means use os.homedir. */
    homeDir: string;
    /**
     * The user's actual repo directory. The caller passes the original working
     * path, NOT the enigma worktree.
     */
    originCwd: string;
    /** The repo-relative file set used for matching and scoring. */
    diffFiles: string[];
    /** The committer time of the base SHA. */
    baseTime: Date;
    /** The committer time of the head SHA. */
    headTime: Date;
    /** Extends windowStart backwards. The plan called for 3 days. */
    slackDays: number;
    /**
     * The minimum raw file-overlap score required before applying stricter
     * multi-file and stale-partial acceptance rules.
     */
    threshold: number;
    /**
     * The per-agent transcript readers to consult. Order is insignificant;
     * matching accepts plausible candidates, prefers a single decisive raw-score
     * match, and otherwise ranks by confidence or an optional disambiguator.
     */
    readers: Reader[];
    /** Consulted before summarization. Defaults to a fresh in-memory cache. */
    cache?: Cache;
    /** Turns the chosen session's text into a short summary. Required. */
    summarizer?: Summarizer;
    /**
     * Optionally chooses among multiple plausible sessions when file-overlap
     * scoring is not decisive enough to pick one safely.
     */
    disambiguator?: Disambiguator;
    /** Receives best-effort accepted candidate diagnostics. Absent disables it. */
    logf?: (format: string, ...args: unknown[]) => void;
}

/**
 * Indicates no agent transcript matched the change. Callers should treat this
 * as a normal "no intent attached" outcome, not an error.
 */
export const ErrNoMatch = new Error("intent: no matching transcript");

/** Reports whether `err` is the no-match sentinel. */
export function isNoMatch(err: unknown): boolean {
    return err === ErrNoMatch;
}

/**
 * Runs the discover -> match -> optional disambiguate -> cache -> summarize
 * pipeline and returns the final intent. Rejects with ErrNoMatch when no session
 * satisfies the matcher's threshold, overlap, and freshness acceptance rules.
 * Disambiguation failures fall back to the deterministic match, except cleanup
 * failures are surfaced because worktree side effects may remain.
 */
export async function extract(p: ExtractParams, signal?: AbortSignal): Promise<Result> {
    if (p.originCwd === "") {
        throw new Error("intent: OriginCWD is required");
    }
    if (p.diffFiles.length === 0) {
        throw ErrNoMatch;
    }
    const cache: Cache = p.cache ?? newMemCache();
    if (!p.summarizer) {
        throw new Error("intent: Summarizer is required");
    }

    const slackMs = Math.max(p.slackDays, 0) * 24 * 60 * 60 * 1000;
    const opts: DiscoverOpts = {
        homeDir: p.homeDir,
        originCwd: canonicalPath(p.originCwd),
        windowStart: new Date(p.baseTime.getTime() - slackMs),
        windowEnd: p.headTime
    };

    const sessions: Session[] = [];
    for (const r of p.readers) {
        if (!r) continue;
        let discovered: Session[];
        try {
            discovered = await r.discover(opts, signal);
        } catch (err) {
            log.debug("intent reader discover failed", "agent", r.name(), "error", errMessage(err));
            continue;
        }
        for (const s of discovered) {
            s.agentName = r.name();
        }
        sessions.push(...discovered);
    }

    if (sessions.length === 0) {
        throw ErrNoMatch;
    }

    // Load message bodies only for sessions that look promising on metadata. At
    // this stage we cannot score yet (need messages), so we load them all.
    // Discover keeps the candidate set small via the time/cwd filter; if that
    // holds, this is cheap.
    const loaded: Session[] = [];
    for (const s of sessions) {
        let reader: Reader | undefined;
        for (const r of p.readers) {
            if (r && r.name() === s.agentName) {
                reader = r;
                break;
            }
        }
        if (!reader) continue;
        try {
            await reader.load(s, signal);
        } catch (err) {
            log.debug(
                "intent reader load failed",
                "agent",
                s.agentName,
                "session",
                s.sessionId,
                "error",
                errMessage(err)
            );
            continue;
        }
        loaded.push(s);
    }

    let match = pickMatchWithOptions(loaded, p.diffFiles, {
        threshold: p.threshold,
        headTime: p.headTime,
        logf: p.logf
    });
    if (match === null) {
        throw ErrNoMatch;
    }
    match = await disambiguateMatch(p, match, loaded, signal);

    const key = cacheKeyFor(match.session);
    const [cached, ok] = cache.get(key);
    if (ok && cached !== "") {
        return {
            summary: cached,
            agentName: match.session.agentName,
            sessionId: match.session.sessionId,
            score: match.score
        };
    }

    let summary: string;
    try {
        summary = await p.summarizer.summarize(match.session, signal);
    } catch (err) {
        throw new Error(`intent: summarize: ${errMessage(err)}`);
    }
    cache.put(key, summary, match.session.agentName, match.session.sessionId);

    return {
        summary,
        agentName: match.session.agentName,
        sessionId: match.session.sessionId,
        score: match.score
    };
}

async function disambiguateMatch(
    p: ExtractParams,
    fallback: Match,
    loaded: Session[],
    signal?: AbortSignal
): Promise<Match> {
    if (!p.disambiguator) {
        return fallback;
    }
    const candidates = acceptedMatches(loaded, p.diffFiles, {
        threshold: p.threshold,
        headTime: p.headTime
    });
    if (!shouldDisambiguate(candidates)) {
        return fallback;
    }
    let choice;
    try {
        choice = await p.disambiguator.disambiguate(p.diffFiles, candidates, signal);
    } catch (err) {
        if (isDisambiguatorCleanup(err)) {
            throw new Error(`intent: disambiguator cleanup: ${errMessage(err)}`);
        }
        if (p.logf) {
            p.logf("disambiguator failed: %v", err);
        }
        return fallback;
    }
    for (const candidate of candidates) {
        if (candidate.session.agentName === choice.agentName && candidate.session.sessionId === choice.sessionId) {
            return candidate;
        }
    }
    if (p.logf) {
        p.logf("disambiguator returned unknown session %q/%q", choice.agentName, choice.sessionId);
    }
    return fallback;
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
