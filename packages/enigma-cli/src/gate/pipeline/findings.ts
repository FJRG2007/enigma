/**
 * Findings algebra over JSON-string payloads, used by the executor and steps to
 * normalize, select, merge, and diff findings between pipeline rounds. Faithful
 * port of the Go `internal/pipeline/findings.go`.
 *
 * Go keys maps by a zeroed Finding struct (value equality); the port reproduces
 * that with a deterministic string key over the identity fields.
 *
 * It also owns the one predicate deciding which findings HALT a run, so the two
 * layers that can park - the steps, through `needsApproval`, and the executor,
 * through an `ask-user` action - answer that question the same way.
 */

import * as types from "../types";
import { readConfigAt } from "@/config";

/** Severity order used to compare a finding against the configured threshold. */
const SEVERITY_RANK: Record<string, number> = { info: 1, warning: 2, error: 3 };

/** The repo's blocking severity as a rank, read once per predicate call rather than per finding. */
function blockingThreshold(repoPath: string): number {
    return SEVERITY_RANK[readConfigAt(repoPath).gateSeverity] ?? SEVERITY_RANK.warning;
}

/** Reports whether a single finding sits at or above a blocking rank. */
function meetsThreshold(item: types.Finding, threshold: number): boolean {
    return (SEVERITY_RANK[item.severity] ?? 0) >= threshold;
}

/**
 * Returns true if any finding is at or above the repo's blocking severity, which is what
 * makes a step stop and wait for the user instead of advancing. `repoPath` is the registered
 * repo rather than the worktree, so the threshold comes from the same `.enigma.json` the rest
 * of the pipeline reads. A finding below it still rides on the step outcome and is reported;
 * it just does not cost a round. An unrecognized severity never blocks.
 */
export function hasBlockingFindings(items: types.Finding[], repoPath: string): boolean {
    const threshold = blockingThreshold(repoPath);
    return items.some(item => meetsThreshold(item, threshold));
}

/**
 * Returns true if any finding carries error or warning severity, the fixed rule the threshold
 * deliberately does NOT govern. Auto-fixing is unattended and costs no approval round, so it
 * stays available at its own bar however high the halt threshold is raised - the threshold
 * buys time, not coverage.
 */
export function hasFixableSeverityFindings(items: types.Finding[]): boolean {
    return items.some(item => meetsThreshold(item, SEVERITY_RANK.warning));
}

/** Identity key ignoring id/action/source/userInstructions (Go findingKey). */
function findingKey(item: types.Finding): string {
    return JSON.stringify([item.severity, item.file ?? "", item.line ?? 0, item.description]);
}

/** Identity key also ignoring line (Go findingFingerprint). */
function findingFingerprint(item: types.Finding): string {
    return JSON.stringify([item.severity, item.file ?? "", 0, item.description]);
}

function countFindingFingerprints(items: types.Finding[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const item of items) {
        const fp = findingFingerprint(item);
        counts.set(fp, (counts.get(fp) ?? 0) + 1);
    }
    return counts;
}

function hasFindingMatch(
    item: types.Finding,
    exact: Set<string>,
    itemCounts: Map<string, number>,
    candidateCounts: Map<string, number>
): boolean {
    if (exact.has(findingKey(item))) return true;
    const fp = findingFingerprint(item);
    return itemCounts.get(fp) === 1 && candidateCounts.get(fp) === 1;
}

function carryFields(f: types.Findings): types.Findings {
    return {
        items: [],
        summary: f.summary,
        tested: f.tested,
        testingSummary: f.testingSummary,
        riskLevel: f.riskLevel,
        riskRationale: f.riskRationale
    };
}

/** Encodes the finding IDs of a payload as a JSON array string ("" if none). */
export function findingIDsJSON(raw: string): string {
    if (raw === "") return "";
    let findings: types.Findings;
    try {
        findings = types.parseFindingsJSON(raw);
    } catch {
        return "";
    }
    const ids = findings.items.map(i => i.id ?? "").filter(id => id !== "");
    return marshalFindingIDs(ids);
}

/** Encodes a list of finding IDs as a JSON array ("" for empty, so DB stays NULL). */
export function marshalFindingIDs(ids: string[]): string {
    if (ids.length === 0) return "";
    return JSON.stringify(ids);
}

/** Assigns deterministic IDs to a findings payload, returning re-encoded JSON. */
export function normalizeFindingsJSON(raw: string, prefix: string): string {
    if (raw === "") return "";
    let findings: types.Findings;
    try {
        findings = types.parseFindingsJSON(raw);
    } catch {
        return raw;
    }
    try {
        return types.marshalFindingsJSON(types.normalizeFindings(findings, prefix));
    } catch {
        return raw;
    }
}

/** Drops findings with the given IDs; "" when none remain. */
export function excludeFindingsJSON(raw: string, ids: string[]): string {
    if (raw === "" || ids.length === 0) return "";
    let findings: types.Findings;
    try {
        findings = types.parseFindingsJSON(raw);
    } catch {
        return "";
    }
    const excluded = types.excludeFindings(findings, ids);
    if (excluded.items.length === 0) return "";
    try {
        return types.marshalFindingsJSON(excluded);
    } catch {
        return "";
    }
}

/** Unions two findings payloads, deduping by identity/fingerprint match. */
export function mergeFindingsJSON(existingRaw: string, additionalRaw: string): string {
    if (existingRaw === "") return additionalRaw;
    if (additionalRaw === "") return existingRaw;
    let existing: types.Findings;
    let additional: types.Findings;
    try {
        existing = types.parseFindingsJSON(existingRaw);
    } catch {
        return additionalRaw;
    }
    try {
        additional = types.parseFindingsJSON(additionalRaw);
    } catch {
        return existingRaw;
    }
    const seen = new Set<string>();
    const existingCounts = countFindingFingerprints(existing.items);
    const additionalCounts = countFindingFingerprints(additional.items);
    const merged = carryFields(existing);
    for (const item of existing.items) {
        merged.items.push(item);
        seen.add(findingKey(item));
    }
    for (const item of additional.items) {
        if (hasFindingMatch(item, seen, additionalCounts, existingCounts)) continue;
        const key = findingKey(item);
        if (seen.has(key)) continue;
        merged.items.push(item);
        seen.add(key);
    }
    if (merged.items.length === 0) return "";
    try {
        return types.marshalFindingsJSON(merged);
    } catch {
        return existingRaw;
    }
}

/** Removes findings matching `removeRaw` from `existingRaw`. */
export function removeMatchingFindingsJSON(existingRaw: string, removeRaw: string): string {
    if (existingRaw === "" || removeRaw === "") return existingRaw;
    let existing: types.Findings;
    let remove: types.Findings;
    try {
        existing = types.parseFindingsJSON(existingRaw);
    } catch {
        return existingRaw;
    }
    try {
        remove = types.parseFindingsJSON(removeRaw);
    } catch {
        return existingRaw;
    }
    const toRemove = new Set<string>();
    const existingCounts = countFindingFingerprints(existing.items);
    const removeCounts = countFindingFingerprints(remove.items);
    for (const item of remove.items) toRemove.add(findingKey(item));
    const filtered = carryFields(existing);
    for (const item of existing.items) {
        if (hasFindingMatch(item, toRemove, existingCounts, removeCounts)) continue;
        filtered.items.push(item);
    }
    if (filtered.items.length === 0) return "";
    try {
        return types.marshalFindingsJSON(filtered);
    } catch {
        return existingRaw;
    }
}

/** Keeps only findings in `existingRaw` that match `keepRaw`. */
export function retainMatchingFindingsJSON(existingRaw: string, keepRaw: string): string {
    if (existingRaw === "" || keepRaw === "") return "";
    let existing: types.Findings;
    let keep: types.Findings;
    try {
        existing = types.parseFindingsJSON(existingRaw);
    } catch {
        return "";
    }
    try {
        keep = types.parseFindingsJSON(keepRaw);
    } catch {
        return "";
    }
    const allowed = new Set<string>();
    const existingCounts = countFindingFingerprints(existing.items);
    const keepCounts = countFindingFingerprints(keep.items);
    for (const item of keep.items) allowed.add(findingKey(item));
    const filtered = carryFields(existing);
    for (const item of existing.items) {
        if (!hasFindingMatch(item, allowed, existingCounts, keepCounts)) continue;
        filtered.items.push(item);
    }
    if (filtered.items.length === 0) return "";
    try {
        return types.marshalFindingsJSON(filtered);
    } catch {
        return "";
    }
}

/** Keeps only auto-fixable findings; "" when none. */
export function autoFixableFindingsJSON(raw: string): string {
    if (raw === "") return "";
    let findings: types.Findings;
    try {
        findings = types.parseFindingsJSON(raw);
    } catch {
        return raw;
    }
    const fixable = types.autoFixableFindings(findings);
    if (fixable.items.length === 0) return "";
    try {
        return types.marshalFindingsJSON(fixable);
    } catch {
        return raw;
    }
}

/**
 * Reports whether the payload has an ask-user finding the run must actually park on: the
 * action asks for a decision, and the severity is at or above the repo's blocking threshold.
 * An `ask-user` finding below the threshold is still reported on the outcome, it just does not
 * halt - otherwise raising `gate-severity` would leave the very loop it was added to break
 * (one more low-severity finding per round) fully intact.
 */
export function hasBlockingAskUserFindingsJSON(raw: string, repoPath: string): boolean {
    if (raw === "") return false;
    let findings: types.Findings;
    try {
        findings = types.parseFindingsJSON(raw);
    } catch {
        return false;
    }
    const threshold = blockingThreshold(repoPath);
    return findings.items.some(item => item.action === types.ACTION_ASKUSER && meetsThreshold(item, threshold));
}

/**
 * Returns the ordered finding IDs dispatched to a fix agent: the user's
 * selected agent-produced IDs plus any user-authored finding IDs (which only
 * appear in the merged list).
 */
export function combineSelectedFindingIDs(selected: string[], mergedFindings: string): string[] {
    if (mergedFindings === "") return selected;
    let merged: types.Findings;
    try {
        merged = types.parseFindingsJSON(mergedFindings);
    } catch {
        return selected;
    }
    const seen = new Set<string>();
    for (const id of selected) {
        if (id !== "") seen.add(id);
    }
    const result = [...selected];
    for (const item of merged.items) {
        const id = item.id ?? "";
        if (id === "" || seen.has(id)) continue;
        result.push(id);
        seen.add(id);
    }
    return result;
}

/**
 * Applies per-finding instructions and user-authored findings to a payload.
 * Returns the input unchanged when no overrides are present.
 */
export function mergeUserOverridesJSON(
    raw: string,
    instructions: Record<string, string> | null | undefined,
    added: types.Finding[] | null | undefined
): string {
    const hasInstr = instructions && Object.keys(instructions).length > 0;
    const hasAdded = added && added.length > 0;
    if (!hasInstr && !hasAdded) return raw;
    let base: types.Findings;
    try {
        base = types.parseFindingsJSON(raw);
    } catch {
        base = { items: [], summary: "", riskLevel: "", riskRationale: "" };
    }
    try {
        return types.marshalFindingsJSON(types.mergeUserOverrides(base, instructions, added));
    } catch {
        return raw;
    }
}

/** Filters a payload to selected IDs; empty selection yields "0 selected findings". */
export function filterFindingsJSON(raw: string, ids: string[]): string {
    if (raw === "") return raw;
    let findings: types.Findings;
    try {
        findings = types.parseFindingsJSON(raw);
    } catch {
        return raw;
    }
    let filtered = types.filterFindings(findings, ids);
    if (ids.length === 0) {
        filtered = {
            items: [],
            summary: "0 selected findings",
            tested: findings.tested,
            testingSummary: findings.testingSummary,
            riskLevel: findings.riskLevel,
            riskRationale: findings.riskRationale
        };
    }
    try {
        return types.marshalFindingsJSON(filtered);
    } catch {
        return raw;
    }
}
