/**
 * Faithful port of upstream's `internal/intent/matcher.go`: file-overlap
 * scoring, candidate acceptance rules (threshold, multi-file and stale-partial
 * gates), recency boosting, and deterministic winner selection.
 */

import { normalize } from "node:path";

import { isZeroTime } from "./reader";
import type { Session } from "./reader";
import { filePathTokens } from "./regex";

const decisiveMatchScore = 0.85;

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Match is the chosen session along with its overlap score. */
export interface Match {
    session: Session;
    score: number;
    /**
     * Confidence is the score used to rank accepted candidates after applying
     * recency. score remains the raw file-overlap score surfaced to callers.
     */
    confidence: number;
    /** Overlap lists diff files that appeared in this session (diagnostics). */
    overlap: string[];
}

/** Options controlling candidate acceptance and ranking. */
export interface MatchOptions {
    threshold: number;
    headTime: Date;
    logf?: (format: string, ...args: unknown[]) => void;
}

/** Cleans a path and converts separators to forward slashes (Go ToSlash+Clean). */
function toSlashClean(p: string): string {
    return normalize(p).replace(/\\/g, "/");
}

/**
 * score computes the share of diff files that appear anywhere in the session's
 * messages. The score is symmetric in the sense that a session that touched
 * many extra unrelated files is not penalized - only the portion of *this* diff
 * that the session covered matters.
 */
export function score(s: Session, diffFiles: string[]): [number, string[]] {
    if (diffFiles.length === 0 || s.messages.length === 0) {
        return [0, []];
    }

    const mentioned: string[] = [];
    for (const m of s.messages) {
        for (const p of m.filePaths ?? []) {
            mentioned.push(p);
        }
        // Best-effort scan of assistant text for raw filenames.
        mentioned.push(...scanFilePathsInText(m.text ?? ""));
    }

    const overlap: string[] = [];
    for (const f of diffFiles) {
        for (const p of mentioned) {
            if (pathMentionMatchesDiff(p, f)) {
                overlap.push(f);
                break;
            }
        }
    }
    return [overlap.length / diffFiles.length, overlap];
}

function pathMentionMatchesDiff(mention: string, diffFile: string): boolean {
    mention = toSlashClean(mention.trim());
    if (mention.startsWith("./")) mention = mention.slice(2);
    diffFile = toSlashClean(diffFile.trim());
    if (diffFile.startsWith("./")) diffFile = diffFile.slice(2);
    if (mention === "" || diffFile === "" || mention === "." || diffFile === ".") {
        return false;
    }
    if (mention === diffFile || mention.endsWith(`/${diffFile}`)) {
        return true;
    }
    // Basename-only mentions are useful, but pathful mentions should not match
    // unrelated files that happen to share names like update.go.
    return !mention.includes("/") && basename(diffFile) === mention;
}

/** Returns the final path segment of a forward-slash path. */
function basename(p: string): string {
    const parts = p.split("/");
    return parts[parts.length - 1];
}

/**
 * pickMatch returns the deterministic winner among accepted sessions. A single
 * decisive raw-score candidate wins before confidence ranking. Otherwise,
 * accepted candidates are ranked by confidence, with ties broken by LastActivity.
 */
export function pickMatch(sessions: Session[], diffFiles: string[], threshold: number): Match | null {
    return pickMatchWithOptions(sessions, diffFiles, { threshold, headTime: new Date(0) });
}

export function pickMatchWithOptions(sessions: Session[], diffFiles: string[], opts: MatchOptions): Match | null {
    const candidates = acceptedMatches(sessions, diffFiles, opts);
    if (candidates.length === 0) {
        return null;
    }
    return deterministicMatch(candidates);
}

export function acceptedMatches(sessions: Session[], diffFiles: string[], opts: MatchOptions): Match[] {
    const candidates: Match[] = [];
    for (const s of sessions) {
        const [sc, overlap] = score(s, diffFiles);
        const [accepted, reason, confidence] = acceptMatchCandidate(
            sc,
            overlap.length,
            diffFiles.length,
            s.lastActivity,
            opts
        );
        if (!accepted) {
            continue;
        }
        if (opts.logf) {
            opts.logf(
                "candidate agent=%s session=%s cwd=%q score %.2f confidence %.2f overlap=%d/%d decision=accepted reason=%s",
                s.agentName,
                s.sessionId,
                s.cwd,
                sc,
                confidence,
                overlap.length,
                diffFiles.length,
                reason
            );
        }
        candidates.push({ session: s, score: sc, confidence, overlap });
    }
    candidates.sort((a, b) => {
        if (a.confidence === b.confidence) {
            return b.session.lastActivity.getTime() - a.session.lastActivity.getTime();
        }
        return b.confidence - a.confidence;
    });
    return candidates;
}

export function shouldDisambiguate(candidates: Match[]): boolean {
    if (candidates.length < 2) {
        return false;
    }
    let decisive = 0;
    for (const candidate of candidates) {
        if (candidate.score >= decisiveMatchScore) {
            decisive++;
        }
    }
    return decisive !== 1;
}

function deterministicMatch(candidates: Match[]): Match {
    let singleDecisive: Match | null = null;
    for (const candidate of candidates) {
        if (candidate.score < decisiveMatchScore) {
            continue;
        }
        if (singleDecisive !== null) {
            return candidates[0];
        }
        singleDecisive = candidate;
    }
    if (singleDecisive !== null) {
        return singleDecisive;
    }
    return candidates[0];
}

function acceptMatchCandidate(
    scoreValue: number,
    overlapCount: number,
    diffCount: number,
    lastActivity: Date,
    opts: MatchOptions
): [boolean, string, number] {
    if (diffCount === 0 || overlapCount === 0) {
        return [false, "no_overlap", scoreValue];
    }
    let threshold = opts.threshold;
    if (diffCount > 1 && threshold < 0.5) {
        threshold = 0.5;
    }
    if (diffCount > 1 && overlapCount < 2) {
        return [false, "single_overlap_multi_file_diff", scoreValue];
    }
    if (scoreValue < threshold) {
        return [false, "below_threshold", scoreValue];
    }
    const confidence = scoreValue + recencyBoost(opts.headTime, lastActivity);
    if (
        !isZeroTime(opts.headTime) &&
        lastActivity.getTime() < opts.headTime.getTime() - TWENTY_FOUR_HOURS_MS &&
        scoreValue < 0.8
    ) {
        return [false, "stale_partial", confidence];
    }
    return [true, "matched", confidence];
}

function recencyBoost(headTime: Date, lastActivity: Date): number {
    if (isZeroTime(headTime) || isZeroTime(lastActivity)) {
        return 0;
    }
    let age = headTime.getTime() - lastActivity.getTime();
    if (age < 0) {
        age = -age;
    }
    if (age <= TWO_HOURS_MS) {
        return 0.15;
    }
    if (age <= TWENTY_FOUR_HOURS_MS) {
        return 0.05;
    }
    return 0;
}

/**
 * normalizedPathVariants returns a small set of normalized forms for a path so
 * that absolute, repo-relative, and basename mentions can match.
 */
export function normalizedPathVariants(p: string): string[] {
    if (p === "") {
        return [];
    }
    let cleaned = toSlashClean(p.trim());
    if (cleaned.startsWith("./")) cleaned = cleaned.slice(2);
    const variants = new Set<string>([cleaned]);
    const base = basename(cleaned);
    if (base !== "" && base !== ".") {
        variants.add(base);
    }
    return [...variants];
}

const TRIM_TOKEN_CHARS = /^["'`,;:()\[\]{}<>]+|["'`,;:()\[\]{}<>]+$/g;

/**
 * scanFilePathsInText extracts plausible file paths from prose. The regex is
 * intentionally permissive - false positives don't matter because the matcher
 * only treats them as candidates, not ground truth.
 */
export function scanFilePathsInText(text: string): string[] {
    if (text === "") {
        return [];
    }
    const out: string[] = [];
    const matches = text.match(filePathTokens);
    if (!matches) {
        return out;
    }
    for (let tok of matches) {
        tok = tok.replace(TRIM_TOKEN_CHARS, "");
        if (tok === "") {
            continue;
        }
        // Require an extension or path separator to avoid matching prose words.
        if (tok.includes("/") || tok.includes("\\") || tok.includes(".")) {
            out.push(tok);
        }
    }
    return out;
}
