/**
 * Pipeline-step CLI helpers shared by the axi run/respond/logs commands: skip-step
 * parsing and the git push-option encoding that carries skip selections and the
 * agent-supplied intent through a push. Faithful port of the relevant helpers in
 * upstream's `internal/cli/daemon_cmd.go`.
 *
 * enigma rebrand: the push-option namespace is `enigma.*` (the Go uses
 * `enigma.*`), matching the enigma binary that the gate post-receive hook
 * forwards options to. The gate-notify reader must parse the same prefixes.
 */

import { allSteps, type StepName } from "../types";

/** Push-option prefix carrying a comma-separated skip-step list. */
export const SKIP_PUSH_PREFIX = "enigma.skip=";

/**
 * Push-option prefix carrying an agent-supplied intent. The value is base64 so a
 * multi-line or special-character intent survives the line-oriented transport.
 */
export const INTENT_PUSH_PREFIX = "enigma.intent=";

/** Reports whether step is a known pipeline step. */
export function validStep(step: StepName): boolean {
    return allSteps().includes(step);
}

/** Removes duplicate steps while preserving first-seen order. */
export function dedupeSteps(steps: StepName[]): StepName[] {
    const seen = new Set<StepName>();
    const out: StepName[] = [];
    for (const step of steps) {
        if (seen.has(step)) continue;
        seen.add(step);
        out.push(step);
    }
    return out;
}

/** Parses a comma-separated skip-step list, throwing on an unknown step. */
export function parseSkipSteps(value: string): StepName[] {
    if (value.trim() === "") return [];
    const steps: StepName[] = [];
    for (const part of value.split(",")) {
        const step = part.trim() as StepName;
        if (!validStep(step)) throw new Error(`unknown step "${step}"`);
        steps.push(step);
    }
    return dedupeSteps(steps);
}

/**
 * What `--quick` stands for.
 *
 * The two steps that pay off least when the caller already knows what the change is:
 * `test` runs an evidence pass over a suite the author has usually just run, and
 * `document` asks whether a change needs documenting. Review is never in here - it is
 * the step that justifies the gate, and a quick run is still a gated one.
 */
export const QUICK_SKIP_STEPS: StepName[] = ["test", "document"];

/**
 * The steps a run skips: what was asked for, plus `--quick` when it was passed.
 *
 * One function because the two are additive - `--quick --skip lint` is a caller who
 * wants both - and because a run's shape is worth being able to test without starting
 * a pipeline.
 */
export function parseRunSkips(value: string, quick: boolean): StepName[] {
    const asked = parseSkipSteps(value);
    return quick ? dedupeSteps([...asked, ...QUICK_SKIP_STEPS]) : asked;
}

/** Encodes the skip-step selection as push options, or [] when none. */
export function formatSkipPushOptions(steps: StepName[]): string[] {
    if (steps.length === 0) return [];
    return [SKIP_PUSH_PREFIX + dedupeSteps(steps).join(",")];
}

/** Encodes intent as a single base64 push option, or "" when there is none. */
export function formatIntentPushOption(intent: string): string {
    if (intent.trim() === "") return "";
    return INTENT_PUSH_PREFIX + Buffer.from(intent, "utf8").toString("base64");
}
