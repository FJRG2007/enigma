/**
 * Agent-driven git branch-name and commit-subject suggestions.
 *
 * Faithful 1:1 port of the Go `internal/agent/suggest.go`: the branch/commit
 * prompts and shared rules, the structured-output schemas, the three public
 * suggest helpers, and the branch/commit sanitizers (including the git ref-name
 * validity rules). Behavior is preserved.
 *
 * Divergences from Go (intentional): `context.Context` -> an optional trailing
 * `AbortSignal` (matching the gate's git helpers); the JSON Schemas are parsed
 * objects (not raw bytes), consistent with `RunOpts.jsonSchema`; result output
 * is already-parsed JSON, so `unmarshalSuggestion` reads it directly.
 */

import type { Agent, Result } from "./agent";
import { asRecord, errMessage } from "./proc";
import { RELEASE_TYPE_RULE, tightenTitle } from "../conventional";

// branchNameRules and commitSubjectRules are shared between the single-purpose
// prompts and the combined prompt so behavior stays in lock-step.
const BRANCH_NAME_RULES = `- Use kebab-case.
- Prefer a conventional prefix: "feat/", "fix/", "chore/", "refactor/", "docs/", or "test/".
- Keep it under 40 characters.`;

const COMMIT_SUBJECT_RULES = `- One line only, under 72 characters.
- Use conventional commit format: "type(scope): description" or "type: description". Valid types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Scope is optional. Do not capitalize the type.
${RELEASE_TYPE_RULE}
- When including a scope, it MUST be a real package/module name that exists in the codebase (for example, a directory under internal/, cmd/, or the equivalent top-level grouping for this project), identified by inspecting the changed paths. Pick the primary module affected by the change, not a secondary or incidental one.
- Keep the scope at a coarse level, not too granular: a codebase typically has fewer than 10 distinct scopes in use across its history. Prefer a broad module name (e.g. "daemon", "pipeline", "cli") over a narrow file or sub-feature name. If you cannot confidently identify a real primary module, omit the scope and use "type: description".
- Do not invent behavior.`;

const BRANCH_NAME_PROMPT = `Suggest a short, descriptive git branch name for the current working-tree changes in this repository.

Inspect the state yourself (e.g. git status, git diff HEAD, git diff --staged) in the working directory.

Rules:
${BRANCH_NAME_RULES}
- Return JSON: {"name":"..."}`;

const COMMIT_SUBJECT_PROMPT = `Suggest a conventional commit subject line summarizing the current working-tree changes.

Inspect the state yourself (e.g. git status, git diff HEAD, git diff --staged) in the working directory.

Rules:
${COMMIT_SUBJECT_RULES}
- Return JSON: {"subject":"..."}`;

const BRANCH_AND_COMMIT_PROMPT = `Suggest a git branch name and a conventional commit subject for the current working-tree changes in this repository.

Inspect the state yourself (e.g. git status, git diff HEAD, git diff --staged) in the working directory.

Branch name rules:
${BRANCH_NAME_RULES}

Commit subject rules:
${COMMIT_SUBJECT_RULES}

Return JSON: {"branch":"...","subject":"..."}`;

const BRANCH_NAME_SCHEMA = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"]
};

const COMMIT_SUBJECT_SCHEMA = {
    type: "object",
    properties: { subject: { type: "string" } },
    required: ["subject"]
};

const BRANCH_AND_COMMIT_SCHEMA = {
    type: "object",
    properties: { branch: { type: "string" }, subject: { type: "string" } },
    required: ["branch", "subject"]
};

/**
 * Asks the agent to propose a short git branch name for the current working-tree
 * state in dir. The suggestion is sanitized so it is safe to pass to
 * `git checkout -b`. Throws when the agent returns an empty or unusable name.
 */
export async function suggestBranchName(ag: Agent, dir: string, signal?: AbortSignal): Promise<string> {
    let result: Result;
    try {
        result = await ag.run({ prompt: BRANCH_NAME_PROMPT, cwd: dir, jsonSchema: BRANCH_NAME_SCHEMA }, signal);
    } catch (err) {
        throw new Error(`suggest branch name: ${errMessage(err)}`);
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = unmarshalSuggestion(result);
    } catch (err) {
        throw new Error(`parse branch name suggestion: ${errMessage(err)}`);
    }
    const name = sanitizeBranchName(stringField(parsed, "name"));
    if (name === "") throw new Error("agent returned empty or unusable branch name");
    return name;
}

/**
 * Asks the agent to propose both a git branch name and a conventional commit
 * subject in a single call, saving one round-trip when the wizard needs both.
 *
 * The branch name must sanitize to a valid git ref; otherwise an error is
 * thrown. The commit subject is best-effort: an empty subject yields an empty
 * string with no error so the caller can fall back to suggestCommitMessage.
 */
export async function suggestBranchAndCommit(
    ag: Agent,
    dir: string,
    signal?: AbortSignal
): Promise<{ branch: string; subject: string; }> {
    let result: Result;
    try {
        result = await ag.run(
            { prompt: BRANCH_AND_COMMIT_PROMPT, cwd: dir, jsonSchema: BRANCH_AND_COMMIT_SCHEMA },
            signal
        );
    } catch (err) {
        throw new Error(`suggest branch and commit: ${errMessage(err)}`);
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = unmarshalSuggestion(result);
    } catch (err) {
        throw new Error(`parse branch and commit suggestion: ${errMessage(err)}`);
    }
    const branch = sanitizeBranchName(stringField(parsed, "branch"));
    if (branch === "") throw new Error("agent returned empty or unusable branch name");
    const subject = sanitizeCommitSubject(stringField(parsed, "subject"));
    return { branch, subject };
}

/**
 * Asks the agent to propose a single-line commit subject summarizing the current
 * working-tree state at dir. Throws when the agent returns an empty subject.
 */
export async function suggestCommitMessage(ag: Agent, dir: string, signal?: AbortSignal): Promise<string> {
    let result: Result;
    try {
        result = await ag.run({ prompt: COMMIT_SUBJECT_PROMPT, cwd: dir, jsonSchema: COMMIT_SUBJECT_SCHEMA }, signal);
    } catch (err) {
        throw new Error(`suggest commit message: ${errMessage(err)}`);
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = unmarshalSuggestion(result);
    } catch (err) {
        throw new Error(`parse commit message suggestion: ${errMessage(err)}`);
    }
    const subject = sanitizeCommitSubject(stringField(parsed, "subject"));
    if (subject === "") throw new Error("agent returned empty commit subject");
    return subject;
}

/**
 * Returns the agent result's structured output as an object, falling back to
 * parsing the raw text. Mirrors Go's unmarshalSuggestion precedence.
 */
function unmarshalSuggestion(result: Result | null): Record<string, unknown> {
    if (!result) throw new Error("agent returned no result");
    if (result.output !== undefined && result.output !== null) {
        return asRecord(result.output) ?? {};
    }
    if (result.text !== "") {
        return asRecord(JSON.parse(result.text)) ?? {};
    }
    throw new Error("agent returned no output");
}

function stringField(obj: Record<string, unknown>, key: string): string {
    const v = obj[key];
    return typeof v === "string" ? v : "";
}

/**
 * Normalizes an agent-suggested branch name: lowercase, ASCII-only,
 * alphanumerics plus - / . separators, length-capped, validated as a git ref.
 */
function sanitizeBranchName(raw: string): string {
    let s = raw.trim().replace(/^["']+|["']+$/g, "");
    s = s.toLowerCase();
    let b = "";
    for (const r of s) {
        if ((r >= "a" && r <= "z") || (r >= "0" && r <= "9")) b += r;
        else if (r === "/" || r === ".") b += r;
        else if (r === "-" || r === "_" || r === " ") b += "-";
    }
    s = b;
    while (s.includes("--")) s = s.replaceAll("--", "-");
    s = trimChars(s, "-/.");
    if (s.length > 60) {
        s = s.slice(0, 60);
        s = trimChars(s, "-/.");
    }
    if (!isValidBranchName(s)) return "";
    return s;
}

function isValidBranchName(name: string): boolean {
    if (name === "" || name === "@") return false;
    if (name.startsWith("-") || name.startsWith("/")) return false;
    if (name.endsWith("/") || name.endsWith(".")) return false;
    if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
    for (const r of name) {
        const code = r.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) return false;
        switch (r) {
            case " ":
            case "~":
            case "^":
            case ":":
            case "?":
            case "*":
            case "[":
            case "\\":
                return false;
        }
    }
    for (const part of name.split("/")) {
        if (part === "" || part === "." || part === "..") return false;
        if (part.startsWith(".") || part.endsWith(".lock")) return false;
    }
    return true;
}

/** Trims whitespace and keeps only the first line, tightened to a conventional subject. */
function sanitizeCommitSubject(raw: string): string {
    let s = raw.trim();
    const i = s.indexOf("\n");
    if (i >= 0) s = s.slice(0, i).trim();
    return tightenTitle(s);
}

/** Trims any leading/trailing character contained in `cutset` (Go's strings.Trim). */
function trimChars(s: string, cutset: string): string {
    let start = 0;
    let end = s.length;
    while (start < end && cutset.includes(s[start])) start++;
    while (end > start && cutset.includes(s[end - 1])) end--;
    return s.slice(start, end);
}
