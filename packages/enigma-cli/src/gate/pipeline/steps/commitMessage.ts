/**
 * Subject line for every commit the gate makes on the user's behalf.
 *
 * A gate run commits in the same history the user's agent commits into, so its
 * subjects follow the same convention git-policy asks the agent for: a leading
 * type emoji unless `commitEmoji` is turned off. The commits keep the
 * `enigma(<step>)` type so a pipeline commit stays recognizable; the step is what
 * the emoji is picked from, using git-policy's type-to-emoji map.
 *
 * Every commit site in the pipeline goes through here - the setting has to hold
 * for all of them, not only the agent-fix rounds.
 */

import { readConfigAt } from "@/config";
import type { StepName } from "@/gate/types";

/** Leading subject emoji per step, mapped to git-policy's commit types. */
const STEP_EMOJI: Record<StepName, string> = {
    intent: "🔧",
    rebase: "🔧",
    review: "🐛",
    test: "✅",
    document: "📝",
    lint: "🎨",
    push: "🔧",
    pr: "🔧",
    ci: "👷"
};

/**
 * Builds the commit subject for `stepName`. `repoPath` is the registered repo the
 * run belongs to, not the worktree: the effective `commitEmoji` comes from the
 * user's own `.enigma.json` there (which may be untracked) merged over the global
 * one. An empty summary falls back to a generic one so the subject is never bare.
 */
export function gateCommitMessage(repoPath: string, stepName: StepName, summary: string): string {
    const subject = `enigma(${stepName}): ${summary === "" ? "apply fixes" : summary}`;
    if (!readConfigAt(repoPath).commitEmoji) return subject;
    return `${STEP_EMOJI[stepName]} ${subject}`;
}
