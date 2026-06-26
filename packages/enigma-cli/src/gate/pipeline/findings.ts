/**
 * Findings algebra over JSON-string payloads, used by the executor and steps to
 * normalize, select, merge, and diff findings between pipeline rounds. Faithful
 * port of the Go `internal/pipeline/findings.go`.
 *
 * Go keys maps by a zeroed Finding struct (value equality); the port reproduces
 * that with a deterministic string key over the identity fields.
 */

import {
    type Finding,
    type Findings,
    filterFindings,
    excludeFindings,
    parseFindingsJSON,
    normalizeFindings,
    mergeUserOverrides,
    marshalFindingsJSON,
    autoFixableFindings,
    hasAskUserFindings
} from "../types";

/** Identity key ignoring id/action/source/userInstructions (Go findingKey). */
function findingKey(item: Finding): string {
    return JSON.stringify([item.severity, item.file ?? "", item.line ?? 0, item.description]);
}

/** Identity key also ignoring line (Go findingFingerprint). */
function findingFingerprint(item: Finding): string {
    return JSON.stringify([item.severity, item.file ?? "", 0, item.description]);
}

function countFindingFingerprints(items: Finding[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const item of items) {
        const fp = findingFingerprint(item);
        counts.set(fp, (counts.get(fp) ?? 0) + 1);
    }
    return counts;
}

function hasFindingMatch(
    item: Finding,
    exact: Set<string>,
    itemCounts: Map<string, number>,
    candidateCounts: Map<string, number>
): boolean {
    if (exact.has(findingKey(item))) return true;
    const fp = findingFingerprint(item);
    return itemCounts.get(fp) === 1 && candidateCounts.get(fp) === 1;
}

function carryFields(f: Findings): Findings {
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
    let findings: Findings;
    try {
        findings = parseFindingsJSON(raw);
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
    let findings: Findings;
    try {
        findings = parseFindingsJSON(raw);
    } catch {
        return raw;
    }
    try {
        return marshalFindingsJSON(normalizeFindings(findings, prefix));
    } catch {
        return raw;
    }
}

/** Drops findings with the given IDs; "" when none remain. */
export function excludeFindingsJSON(raw: string, ids: string[]): string {
    if (raw === "" || ids.length === 0) return "";
    let findings: Findings;
    try {
        findings = parseFindingsJSON(raw);
    } catch {
        return "";
    }
    const excluded = excludeFindings(findings, ids);
    if (excluded.items.length === 0) return "";
    try {
        return marshalFindingsJSON(excluded);
    } catch {
        return "";
    }
}

/** Unions two findings payloads, deduping by identity/fingerprint match. */
export function mergeFindingsJSON(existingRaw: string, additionalRaw: string): string {
    if (existingRaw === "") return additionalRaw;
    if (additionalRaw === "") return existingRaw;
    let existing: Findings;
    let additional: Findings;
    try {
        existing = parseFindingsJSON(existingRaw);
    } catch {
        return additionalRaw;
    }
    try {
        additional = parseFindingsJSON(additionalRaw);
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
        return marshalFindingsJSON(merged);
    } catch {
        return existingRaw;
    }
}

/** Removes findings matching `removeRaw` from `existingRaw`. */
export function removeMatchingFindingsJSON(existingRaw: string, removeRaw: string): string {
    if (existingRaw === "" || removeRaw === "") return existingRaw;
    let existing: Findings;
    let remove: Findings;
    try {
        existing = parseFindingsJSON(existingRaw);
    } catch {
        return existingRaw;
    }
    try {
        remove = parseFindingsJSON(removeRaw);
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
        return marshalFindingsJSON(filtered);
    } catch {
        return existingRaw;
    }
}

/** Keeps only findings in `existingRaw` that match `keepRaw`. */
export function retainMatchingFindingsJSON(existingRaw: string, keepRaw: string): string {
    if (existingRaw === "" || keepRaw === "") return "";
    let existing: Findings;
    let keep: Findings;
    try {
        existing = parseFindingsJSON(existingRaw);
    } catch {
        return "";
    }
    try {
        keep = parseFindingsJSON(keepRaw);
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
        return marshalFindingsJSON(filtered);
    } catch {
        return "";
    }
}

/** Keeps only auto-fixable findings; "" when none. */
export function autoFixableFindingsJSON(raw: string): string {
    if (raw === "") return "";
    let findings: Findings;
    try {
        findings = parseFindingsJSON(raw);
    } catch {
        return raw;
    }
    const fixable = autoFixableFindings(findings);
    if (fixable.items.length === 0) return "";
    try {
        return marshalFindingsJSON(fixable);
    } catch {
        return raw;
    }
}

/** Reports whether the payload has any ask-user finding. */
export function hasAskUserFindingsJSON(raw: string): boolean {
    if (raw === "") return false;
    try {
        return hasAskUserFindings(parseFindingsJSON(raw));
    } catch {
        return false;
    }
}

/**
 * Returns the ordered finding IDs dispatched to a fix agent: the user's
 * selected agent-produced IDs plus any user-authored finding IDs (which only
 * appear in the merged list).
 */
export function combineSelectedFindingIDs(selected: string[], mergedFindings: string): string[] {
    if (mergedFindings === "") return selected;
    let merged: Findings;
    try {
        merged = parseFindingsJSON(mergedFindings);
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
    added: Finding[] | null | undefined
): string {
    const hasInstr = instructions && Object.keys(instructions).length > 0;
    const hasAdded = added && added.length > 0;
    if (!hasInstr && !hasAdded) return raw;
    let base: Findings;
    try {
        base = parseFindingsJSON(raw);
    } catch {
        base = { items: [], summary: "", riskLevel: "", riskRationale: "" };
    }
    try {
        return marshalFindingsJSON(mergeUserOverrides(base, instructions, added));
    } catch {
        return raw;
    }
}

/** Filters a payload to selected IDs; empty selection yields "0 selected findings". */
export function filterFindingsJSON(raw: string, ids: string[]): string {
    if (raw === "") return raw;
    let findings: Findings;
    try {
        findings = parseFindingsJSON(raw);
    } catch {
        return raw;
    }
    let filtered = filterFindings(findings, ids);
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
        return marshalFindingsJSON(filtered);
    } catch {
        return raw;
    }
}
