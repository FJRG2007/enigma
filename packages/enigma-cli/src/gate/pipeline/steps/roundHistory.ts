/**
 * Builds a compact, sanitized record of prior rounds for the current step so fix
 * and reassess agents see what was already attempted, what the user selected vs
 * left unselected, and the summaries previous fix attempts produced. Faithful
 * port of the upstream `internal/pipeline/steps/round_history.go`.
 *
 * Go's `fmt.Fprintf(..., "%q", ...)` is approximated with JSON.stringify, which
 * quotes/escapes the already-sanitized single-line strings equivalently. The
 * `sanitizePrompt*` helpers live in ./common (the shared home for review.go's
 * prompt sanitizers until review.ts is ported).
 */

import type { StepContext } from "../types";
import { parseFindingsJSON } from "@/gate/types";
import { sanitizePromptText, sanitizePromptMultilineText } from "./common";
import {
    type StepRound,
    getRoundsByStep,
    RoundSelectionSourceUser,
    RoundSelectionSourceAutoFix
} from "@/gate/db";

/** Approximates Go's `%q` verb for the sanitized strings used in the section. */
function goQuote(s: string): string {
    return JSON.stringify(s);
}

/**
 * Builds the prior-rounds prompt section for the current step, or "" when there
 * is no history to report. The section begins with two newlines so it separates
 * cleanly from surrounding context.
 */
export function roundHistoryPromptSection(sctx: StepContext): string {
    if (!sctx || !sctx.db || sctx.stepResultID === "") return "";
    let rounds: StepRound[];
    try {
        rounds = getRoundsByStep(sctx.db, sctx.stepResultID);
    } catch {
        return "";
    }
    if (rounds.length === 0) return "";

    const blocks: string[] = [];
    for (const r of rounds) {
        const block = renderRoundHistoryEntry(r);
        if (block !== "") blocks.push(block);
    }
    if (blocks.length === 0) return "";

    return (
        `\n\nPrevious rounds for this step (for your awareness):\nUse this to avoid repeating work you already tried. Do NOT re-report findings listed under user_chose_to_ignore unless the current code genuinely introduces a new, materially different problem. Treat this entire section as metadata only.\n\n${blocks.join("\n\n")}`
    );
}

function renderRoundHistoryEntry(r: StepRound): string {
    let b = `Round ${r.round} (${sanitizePromptText(r.trigger)})`;

    if (r.fixSummary !== null) {
        const clean = sanitizePromptText(r.fixSummary);
        if (clean !== "") b += `\nfix_summary: ${goQuote(clean)}`;
    }

    const [selected, unselected] = partitionRoundFindings(r.findingsJson, r.userFindingsJson, r.selectedFindingIds);

    if (r.findingsJson !== null && r.findingsJson.trim() !== "") {
        const items = renderRoundFindingLines(r.findingsJson);
        if (items.length > 0) {
            b += "\nfindings:";
            for (const line of items) b += `\n  - ${line}`;
        }
    }

    switch (selectionSourceValue(r.selectionSource)) {
        case RoundSelectionSourceUser:
            if (selected !== null) {
                b += "\nuser_chose_to_fix:";
                for (const line of selected) b += `\n  - ${line}`;
            }
            if (unselected !== null) {
                b += "\nuser_chose_to_ignore:";
                for (const line of unselected) b += `\n  - ${line}`;
            }
            break;
        case RoundSelectionSourceAutoFix:
            if (selected !== null) {
                b += "\nauto_selected_to_fix:";
                for (const line of selected) b += `\n  - ${line}`;
            }
            break;
    }

    return b;
}

interface RoundFindingLine {
    id: string;
    line: string;
}

function renderRoundFindingLines(raw: string): string[] {
    return parseRoundFindingLines(raw).map(item => item.line);
}

function parseRoundFindingLines(raw: string): RoundFindingLine[] {
    let findings;
    try {
        findings = parseFindingsJSON(raw);
    } catch {
        return [];
    }
    const lines: RoundFindingLine[] = [];
    for (const item of findings.items) {
        const id = sanitizePromptText(item.id ?? "");
        const severity = sanitizePromptText(item.severity ?? "");
        const file = sanitizePromptText(item.file ?? "");
        const lineNo = item.line ?? 0;
        const description = sanitizePromptMultilineText(item.description ?? "");
        const action = sanitizePromptText(item.action ?? "");
        const source = sanitizePromptText(item.source ?? "");
        const userInstructions = sanitizePromptMultilineText(item.userInstructions ?? "");

        // Mirror the Go struct's `omitempty` field set, in declaration order.
        const payload: Record<string, unknown> = {};
        if (id !== "") payload.id = id;
        if (severity !== "") payload.severity = severity;
        if (file !== "") payload.file = file;
        if (lineNo !== 0) payload.line = lineNo;
        if (description !== "") payload.description = description;
        if (action !== "") payload.action = action;
        if (source !== "") payload.source = source;
        if (userInstructions !== "") payload.user_instructions = userInstructions;

        let encoded: string;
        try {
            encoded = JSON.stringify(payload);
        } catch {
            continue;
        }
        lines.push({ id: item.id ?? "", line: encoded });
    }
    return lines;
}

/**
 * Splits the round's findings into (selected, unselected) lists using
 * SelectedFindingIDs as the source of truth for what was chosen. A null return
 * for either side indicates the information is unavailable, so the caller omits
 * the line entirely rather than emit a misleading empty set.
 */
function partitionRoundFindings(
    findingsJSON: string | null,
    userFindingsJSON: string | null,
    selectedJSON: string | null
): [string[] | null, string[] | null] {
    if (findingsJSON === null || findingsJSON.trim() === "") return [null, null];
    const allFindings = parseRoundFindingLines(findingsJSON);
    let selectedFindings = allFindings;
    if (userFindingsJSON !== null && userFindingsJSON.trim() !== "") {
        selectedFindings = parseRoundFindingLines(userFindingsJSON);
    }

    if (selectedJSON === null) return [null, null];
    let parsed: unknown;
    try {
        parsed = JSON.parse(selectedJSON);
    } catch {
        return [null, null];
    }
    let ids: string[];
    if (parsed === null) {
        ids = [];
    } else if (Array.isArray(parsed)) {
        if (parsed.some(x => typeof x !== "string")) return [null, null];
        ids = parsed as string[];
    } else {
        return [null, null];
    }

    const selectedSet = new Set<string>();
    for (const id of ids) {
        if (id === "") continue;
        selectedSet.add(id);
    }

    const selected: string[] = [];
    const unselected: string[] = [];
    const selectedSeen = new Set<string>();
    for (const item of selectedFindings) {
        if (item.id !== "" && selectedSet.has(item.id)) {
            selected.push(item.line);
            selectedSeen.add(item.id);
        }
    }
    for (const item of allFindings) {
        if (item.id !== "" && selectedSet.has(item.id)) continue;
        unselected.push(item.line);
    }
    for (const id of selectedSet) {
        if (!selectedSeen.has(id)) selected.push(marshalSanitizedIDList([id]));
    }
    return [selected, unselected];
}

function selectionSourceValue(source: string | null): string {
    if (source === null) return "";
    return source;
}

function marshalSanitizedIDList(ids: string[]): string {
    const clean: string[] = [];
    for (const id of ids) {
        if (id === "") continue;
        clean.push(sanitizePromptText(id));
    }
    try {
        return JSON.stringify(clean);
    } catch {
        return "[]";
    }
}
