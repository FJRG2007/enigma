/**
 * Pipeline step registry: assembles the nine steps in their fixed execution
 * order (intent -> rebase -> review -> test -> document -> lint -> push -> pr ->
 * ci). Port of the Go `steps.AllSteps()` factory, kept separate so the daemon
 * injects it (`StepFactory`) and tests can substitute mock steps.
 */

import { PRStep } from "./pr";
import { newCIStep } from "./ci";
import { type Step } from "../types";
import { newLintStep } from "./lint";
import { newTestStep } from "./test";
import { newPushStep } from "./push";
import { newReviewStep } from "./review";
import { newRebaseStep } from "./rebase";
import { newIntentStep } from "./intent";
import { newDocumentStep } from "./document";

/** All pipeline steps in execution order. */
export function allPipelineSteps(): Step[] {
    return [
        newIntentStep(),
        newRebaseStep(),
        newReviewStep(),
        newTestStep(),
        newDocumentStep(),
        newLintStep(),
        newPushStep(),
        new PRStep(),
        newCIStep()
    ];
}
