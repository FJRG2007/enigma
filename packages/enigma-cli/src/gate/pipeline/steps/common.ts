/**
 * Shared step helpers and the structured-output JSON Schemas every pipeline step
 * agent call validates against. Faithful port of the upstream
 * `internal/pipeline/steps/common.go` (minus AllSteps/DemoSteps, which reference
 * the step structs ported in a later phase).
 *
 * The Go schemas were `json.RawMessage` byte blobs; here they are parsed JS
 * objects, matching `agent.RunOpts.jsonSchema` which carries a parsed JSON value.
 * The prompt-sanitization helpers (`sanitizePromptText` /
 * `sanitizePromptMultilineText`) live here as shared helpers - Go declared them
 * in review.go, but multiple step files depend on them, so this shared module is
 * their single home until review.ts is ported.
 */

export type { Finding, Findings } from "@/gate/types";

/** JSON Schema for structured findings output (review/lint/document). */
export const findingsSchema = {
    type: "object",
    properties: {
        findings: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    severity: { type: "string", enum: ["error", "warning", "info"] },
                    file: { type: "string" },
                    line: { type: "integer" },
                    description: { type: "string" },
                    action: { type: "string", enum: ["no-op", "auto-fix", "ask-user"] }
                },
                required: ["severity", "description", "action"]
            }
        },
        summary: { type: "string" },
        tested: { type: "array", items: { type: "string" } },
        testing_summary: { type: "string" }
    },
    required: ["findings", "summary"]
};

/** JSON Schema for the test step, adding the evidence `artifacts` array. */
export const testFindingsSchema = {
    type: "object",
    properties: {
        findings: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    severity: { type: "string", enum: ["error", "warning", "info"] },
                    file: { type: "string" },
                    line: { type: "integer" },
                    description: { type: "string" },
                    action: { type: "string", enum: ["no-op", "auto-fix", "ask-user"] }
                },
                required: ["severity", "description", "action"]
            }
        },
        summary: { type: "string" },
        tested: { type: "array", items: { type: "string" } },
        testing_summary: { type: "string" },
        artifacts: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    kind: {
                        type: "string",
                        description: "artifact type such as screenshot, gif, image, video, log, command-output, or other"
                    },
                    label: { type: "string" },
                    path: {
                        type: "string",
                        description: "artifact file path, including absolute paths for temporary local evidence files when available"
                    },
                    url: { type: "string", description: "artifact URL when available" },
                    content: {
                        type: "string",
                        description: "short log, command output, or textual artifact content to show inline"
                    }
                },
                required: ["label"]
            }
        }
    },
    required: ["findings", "summary", "tested", "testing_summary", "artifacts"]
};

/**
 * JSON Schema for structured review output with risk assessment. Field order
 * matters for chain-of-thought: findings first, then risk level, then rationale.
 */
export const reviewFindingsSchema = {
    type: "object",
    properties: {
        findings: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    severity: { type: "string", enum: ["error", "warning", "info"] },
                    file: { type: "string" },
                    line: { type: "integer" },
                    description: { type: "string" },
                    action: { type: "string", enum: ["no-op", "auto-fix", "ask-user"] }
                },
                required: ["severity", "description", "action"]
            }
        },
        tested: { type: "array", items: { type: "string" } },
        testing_summary: { type: "string" },
        risk_level: { type: "string", enum: ["low", "medium", "high"] },
        risk_rationale: { type: "string" }
    },
    required: ["findings", "risk_level", "risk_rationale"]
};

/** Collapses all whitespace to single spaces, yielding a single-line string. */
export function sanitizePromptText(text: string): string {
    return sanitizePromptMultilineText(text)
        .split(/\s+/)
        .filter(part => part !== "")
        .join(" ");
}

/**
 * Neutralizes conflict markers and normalizes line endings/whitespace while
 * preserving line breaks, so untrusted prompt content cannot inject structure.
 */
export function sanitizePromptMultilineText(text: string): string {
    text = text
        .split("<<<<<<<").join(" ")
        .split("=======").join(" ")
        .split(">>>>>>>").join(" ");
    text = text.split("\r\n").join("\n").split("\r").join("\n");
    const lines = text.split("\n").map(line => line.split(/\s+/).filter(part => part !== "").join(" "));
    return lines.join("\n").trim();
}
