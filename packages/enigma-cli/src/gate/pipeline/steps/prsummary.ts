/**
 * Deterministic PR markdown sections built from recorded step results and rounds:
 * the Pipeline summary, the per-step issue -> fix -> outcome narrative, the risk
 * line, and the Testing section (with sanitized, optionally GitHub-linked or
 * embedded test artifacts). Faithful port of the no-mistakes
 * `internal/pipeline/steps/prsummary.go`.
 *
 * Go's standard-library facilities are ported inline since enigma carries no
 * runtime dependencies: `html.EscapeString`, `url.PathEscape`/`url.Parse`, the
 * `path.Clean`/`filepath.*` lexical helpers, and the UTF-8 validity/truncation
 * primitives. The status/severity/risk emoji and section wording are output
 * tokens reproduced verbatim so the rendered PR body is byte-identical to Go's.
 */

import * as path from "node:path";
import { testEvidenceRoot } from "./evidence";
import { isFixRound, type StepResult, type StepRound } from "../../db";
import { sanitizePromptText, sanitizePromptMultilineText } from "./common";
import { statSync, readFileSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import {
    parseFindingsJSON,
    STEP_PR,
    STEP_CI,
    STEP_TEST,
    STEP_REVIEW,
    STEP_REBASE,
    STEP_DOCUMENT,
    STEP_LINT,
    STEP_PUSH,
    type Findings,
    type StepName
} from "../../types";

const maxEmbeddedArtifactBytes = 16 * 1024;
const maxEmbeddedArtifactsTotalBytes = 32 * 1024;

/** Tracks the remaining byte budget for embedded artifact text across a render. */
interface TestingArtifactRenderState {
    remainingEmbeddedBytes: number;
}

/** Controls how the Testing section renders for a given surface. */
interface TestingSummaryOptions {
    githubBlobBase: string;
    githubRawBase: string;
    includeTestedDetails: boolean;
    compactArtifacts: boolean;
    summaryParagraph: boolean;
    omitOutcome: boolean;
    repoRoot: string;
}

/** A test artifact with every field normalized to a non-null string. */
interface SanitizedArtifact {
    kind: string;
    label: string;
    path: string;
    url: string;
    content: string;
}

function defaultTestingSummaryOptions(partial: Partial<TestingSummaryOptions> = {}): TestingSummaryOptions {
    return {
        githubBlobBase: "",
        githubRawBase: "",
        includeTestedDetails: false,
        compactArtifacts: false,
        summaryParagraph: false,
        omitOutcome: false,
        repoRoot: "",
        ...partial
    };
}

/** Minimal append-only builder mirroring Go's strings.Builder usage. */
class StrBuilder {
    private parts: string[] = [];
    private length = 0;

    write(s: string): void {
        if (s === "") return;
        this.parts.push(s);
        this.length += s.length;
    }

    len(): number {
        return this.length;
    }

    string(): string {
        return this.parts.join("");
    }
}

/** Produces a deterministic markdown Pipeline section plus the risk line. */
export function buildPipelineSummary(
    steps: StepResult[],
    rounds: Map<string, StepRound[]>
): [string, string] {
    if (steps.length === 0) return ["", ""];

    const detailBlocks: string[] = [];
    for (const sr of steps) {
        if (shouldOmitPipelineStep(sr)) continue;
        const stepRounds = rounds.get(sr.id) ?? [];
        const [line, detail] = buildStepEntry(sr, stepRounds);
        if (line !== "" && detail !== "") detailBlocks.push(detail);
    }

    if (detailBlocks.length === 0) return ["", ""];

    let b = "## Pipeline\n\nUpdates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)\n\n";
    for (let i = 0; i < detailBlocks.length; i++) {
        if (i > 0) b += "\n";
        b += detailBlocks[i];
    }

    const riskLine = extractRiskLine(steps, rounds);
    return [b, riskLine];
}

/** Extracts a deterministic Testing section from the test step. */
export function buildTestingSummary(steps: StepResult[], rounds: Map<string, StepRound[]>): string {
    return buildTestingSummaryWithOptions(steps, rounds, defaultTestingSummaryOptions({ includeTestedDetails: true }));
}

/** Builds the Testing section tuned for a GitHub PR body. */
export function buildTestingSummaryForPR(
    steps: StepResult[],
    rounds: Map<string, StepRound[]>,
    upstreamURL: string,
    ref: string,
    repoRoot: string
): string {
    const opts = testingSummaryOptionsForGitHub(upstreamURL, ref);
    opts.compactArtifacts = true;
    opts.summaryParagraph = true;
    opts.omitOutcome = true;
    opts.repoRoot = repoRoot;
    return buildTestingSummaryWithOptions(steps, rounds, opts);
}

function buildTestingSummaryWithOptions(
    steps: StepResult[],
    rounds: Map<string, StepRound[]>,
    opts: TestingSummaryOptions
): string {
    for (const sr of steps) {
        if (sr.stepName !== STEP_TEST) continue;

        const stepRounds = rounds.get(sr.id) ?? [];
        const [line] = buildStepEntry(sr, stepRounds);
        if (line === "") return "";

        const testingSummary = collectTestingSummary(sr, stepRounds);
        const tested = collectTestingDetails(sr, stepRounds);
        const artifacts = collectTestingArtifacts(sr, stepRounds, opts);
        if (testingSummary === "" && tested.length === 0 && artifacts.length === 0) {
            return `## Testing\n\n- ${line}`;
        }

        const b = new StrBuilder();
        b.write("## Testing\n\n");
        let wroteSummary = false;
        if (testingSummary !== "") {
            const rendered = renderTestingSummary(testingSummary);
            if (rendered !== "") {
                writeTestingSummary(b, rendered, opts);
                wroteSummary = true;
            }
        } else if (!opts.includeTestedDetails && tested.length > 0) {
            writeTestingSummary(b, compactTestedSummary(tested.length), opts);
            wroteSummary = true;
        }
        if (opts.includeTestedDetails) {
            for (const detail of tested) {
                const rendered = renderTestedDetail(detail);
                if (rendered === "") continue;
                b.write("- ");
                b.write(rendered);
                b.write("\n");
            }
        }
        const renderState: TestingArtifactRenderState = { remainingEmbeddedBytes: maxEmbeddedArtifactsTotalBytes };
        for (const artifact of artifacts) {
            const rendered = renderTestingArtifact(artifact, opts, renderState);
            if (rendered === "") continue;
            b.write(rendered);
            if (!rendered.endsWith("\n")) b.write("\n");
        }
        const outcome = buildTestingOutcomeLine(line, stepRounds);
        if (shouldRenderTestingOutcome(opts, wroteSummary, outcome)) {
            b.write("- ");
            b.write(outcome);
            b.write("\n");
        }

        return b.string().trim();
    }

    return "";
}

function shouldRenderTestingOutcome(opts: TestingSummaryOptions, wroteSummary: boolean, outcome: string): boolean {
    if (outcome === "") return false;
    return !opts.omitOutcome || !wroteSummary || !outcome.includes("✅ passed");
}

function compactTestedSummary(count: number): string {
    if (count === 1) return "Completed 1 recorded test check.";
    return `Completed ${count} recorded test checks.`;
}

function writeTestingSummary(b: StrBuilder, rendered: string, opts: TestingSummaryOptions): void {
    if (opts.summaryParagraph) {
        b.write(rendered);
        b.write("\n\n");
        return;
    }
    b.write("- Summary: ");
    b.write(rendered);
    b.write("\n");
}

function testingSummaryOptionsForGitHub(upstreamURL: string, ref: string): TestingSummaryOptions {
    const repoPath = githubRepoPath(upstreamURL);
    ref = ref.trim();
    if (repoPath === "" || ref === "" || containsAny(ref, "\n\r <>[]()\\")) {
        return defaultTestingSummaryOptions();
    }
    return defaultTestingSummaryOptions({
        githubBlobBase: `https://github.com/${repoPath}/blob/${pathEscape(ref)}/`,
        githubRawBase: `https://raw.githubusercontent.com/${repoPath}/${pathEscape(ref)}/`,
        includeTestedDetails: false
    });
}

function githubRepoPath(remote: string): string {
    remote = remote.trim();
    if (remote === "") return "";
    if (remote.startsWith("git@github.com:")) {
        return cleanGitHubRepoPath(remote.slice("git@github.com:".length));
    }
    let parsed: URL;
    try {
        parsed = new URL(remote);
    } catch {
        return "";
    }
    if (parsed.host.toLowerCase() !== "github.com") return "";
    const pathname = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
    return cleanGitHubRepoPath(pathname);
}

function cleanGitHubRepoPath(repo: string): string {
    repo = repo.trim();
    if (repo.endsWith(".git")) repo = repo.slice(0, -".git".length);
    const parts = repo.split("/");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return "";
    if (containsAny(repo, "\n\r <>[]()\\") || repo.includes("..")) return "";
    return `${pathEscape(parts[0])}/${pathEscape(parts[1])}`;
}

function collectTestingSummary(sr: StepResult, rounds: StepRound[]): string {
    const summary = testingSummaryFromFindings(sr.findingsJson);
    if (summary !== "") return summary;
    for (let i = rounds.length - 1; i >= 0; i--) {
        const s = testingSummaryFromFindings(rounds[i].findingsJson);
        if (s !== "") return s;
    }
    return "";
}

function testingSummaryFromFindings(raw: string | null): string {
    if (raw === null || raw.trim() === "") return "";
    let findings: Findings;
    try {
        findings = parseFindingsJSON(raw);
    } catch {
        return "";
    }
    return sanitizePromptMultilineText(findings.testingSummary ?? "");
}

function collectTestingDetails(sr: StepResult, rounds: StepRound[]): string[] {
    const seen = new Set<string>();
    let details: string[] = [];
    for (const raw of testingEvidenceFindingsJSON(sr, rounds)) {
        details = appendTestingDetails(details, seen, raw);
    }
    return details;
}

function collectTestingArtifacts(sr: StepResult, rounds: StepRound[], opts: TestingSummaryOptions): SanitizedArtifact[] {
    const seen = new Set<string>();
    let artifacts: SanitizedArtifact[] = [];
    for (const raw of testingEvidenceFindingsJSON(sr, rounds)) {
        artifacts = appendTestingArtifacts(artifacts, seen, raw, opts);
    }
    return artifacts;
}

function testingEvidenceFindingsJSON(sr: StepResult, rounds: StepRound[]): (string | null)[] {
    if (hasTestingEvidenceMetadata(sr.findingsJson)) return [sr.findingsJson];
    for (let i = rounds.length - 1; i >= 0; i--) {
        if (hasTestingEvidenceMetadata(rounds[i].findingsJson)) return [rounds[i].findingsJson];
    }
    return [];
}

function hasTestingEvidenceMetadata(raw: string | null): boolean {
    if (raw === null || raw.trim() === "") return false;
    let findings: Findings;
    try {
        findings = parseFindingsJSON(raw);
    } catch {
        return false;
    }
    return (
        (findings.testingSummary ?? "").trim() !== "" ||
        (findings.tested ?? []).length > 0 ||
        (findings.artifacts ?? []).length > 0
    );
}

function appendTestingArtifacts(
    artifacts: SanitizedArtifact[],
    seen: Set<string>,
    raw: string | null,
    opts: TestingSummaryOptions
): SanitizedArtifact[] {
    if (raw === null || raw.trim() === "") return artifacts;
    let findings: Findings;
    try {
        findings = parseFindingsJSON(raw);
    } catch {
        return artifacts;
    }
    for (const src of findings.artifacts ?? []) {
        const artifact: SanitizedArtifact = {
            label: sanitizePromptText(src.label ?? ""),
            kind: sanitizePromptText(src.kind ?? "").toLowerCase(),
            path: sanitizeArtifactPath(src.path ?? "", opts),
            url: sanitizeArtifactURL(src.url ?? ""),
            content: sanitizePromptMultilineText(src.content ?? "")
        };
        const key = `${artifact.kind}\x00${artifact.label}\x00${artifact.path}\x00${artifact.url}\x00${artifact.content}`;
        if (artifact.label === "" || seen.has(key)) continue;
        if (artifact.path === "" && artifact.url === "" && artifact.content === "") continue;
        seen.add(key);
        artifacts.push(artifact);
    }
    return artifacts;
}

function appendTestingDetails(details: string[], seen: Set<string>, raw: string | null): string[] {
    if (raw === null || raw.trim() === "") return details;
    let findings: Findings;
    try {
        findings = parseFindingsJSON(raw);
    } catch {
        return details;
    }
    for (const detail of findings.tested ?? []) {
        const clean = sanitizePromptText(detail);
        if (clean === "" || seen.has(clean)) continue;
        seen.add(clean);
        details.push(clean);
    }
    return details;
}

function renderTestedDetail(detail: string): string {
    const clean = sanitizePromptMultilineText(detail);
    if (clean === "") return "";
    if (
        clean.startsWith("`") &&
        clean.endsWith("`") &&
        countOccurrences(clean, "`") === 2 &&
        !clean.slice(1, clean.length - 1).includes("\n")
    ) {
        return clean;
    }
    if (!clean.includes("`") && !clean.includes("\n")) {
        return `\`${clean}\``;
    }
    let escaped = htmlEscape(clean);
    escaped = escaped.split("\n").join("&#10;");
    return `<code>${escaped}</code>`;
}

function renderTestingSummary(summary: string): string {
    const clean = sanitizePromptMultilineText(summary);
    if (clean === "") return "";
    // Inline backtick code spans are valid markdown prose and render fine on
    // their own; only newlines or angle brackets need the escaped <code> wrapper.
    if (containsAny(clean, "\n<>")) {
        return renderTestedDetail(clean);
    }
    return clean;
}

function renderTestingArtifact(
    artifact: SanitizedArtifact,
    opts: TestingSummaryOptions,
    state: TestingArtifactRenderState
): string {
    const label = sanitizePromptText(artifact.label);
    if (label === "") return "";
    if (opts.compactArtifacts) {
        return renderCompactTestingArtifact(artifact, opts, label, state);
    }
    let target = artifact.url;
    if (target === "") {
        target = artifactTargetForPath(artifact, opts);
    }
    const localPath = localArtifactPath(artifact.path, opts);
    const [fileText, hasFile] = embeddedArtifactText(artifact, opts, state);
    const caption = artifact.content;
    let fenceBody = caption;
    let descriptionLine = "";
    if (hasFile) {
        fenceBody = fileText;
        descriptionLine = caption;
    }

    const b = new StrBuilder();
    if (target !== "" && isImageArtifact(artifact.kind, target)) {
        b.write(`**${htmlEscape(label)}**\n\n![${markdownAltText(label)}](${target})\n`);
    } else if (target !== "" && isVideoArtifact(artifact.kind, target)) {
        b.write(`**${htmlEscape(label)}**\n\n<video src="${htmlEscape(target)}" controls></video>\n`);
    } else if (!hasFile) {
        if (target !== "") {
            b.write(`- Evidence: [${htmlEscape(label)}](${target})\n`);
        } else if (localPath !== "") {
            b.write(renderLocalArtifactLine(label, localPath));
        }
    }
    if (descriptionLine !== "") {
        if (b.len() > 0 && !b.string().endsWith("\n\n")) b.write("\n");
        b.write(renderTestedDetail(descriptionLine));
        b.write("\n");
    }
    if (fenceBody !== "") {
        if (b.len() > 0 && !b.string().endsWith("\n\n")) b.write("\n");
        b.write(`**${htmlEscape(label)}**\n\n\`\`\`text\n${escapeMarkdownFence(fenceBody)}\n\`\`\`\n`);
    }
    return `${trimRightNewlines(b.string())}\n`;
}

function renderCompactTestingArtifact(
    artifact: SanitizedArtifact,
    opts: TestingSummaryOptions,
    label: string,
    state: TestingArtifactRenderState
): string {
    let target = artifact.url;
    if (target === "") {
        target = artifactLinkTargetForPath(artifact, opts);
    }
    const localPath = localArtifactPath(artifact.path, opts);
    const [fileText, hasFile] = embeddedArtifactText(artifact, opts, state);
    const caption = artifact.content;

    if (target === "" && localPath === "" && caption === "" && !hasFile) {
        return "";
    }

    // No embeddable text: render a link or local-file reference (images, videos, binaries).
    if (caption === "" && !hasFile) {
        if (target !== "") {
            return `- Evidence: [${htmlEscape(label)}](${target})\n`;
        }
        return renderLocalArtifactLine(label, localPath);
    }

    let fenceBody = caption;
    let descriptionLine = "";
    if (hasFile) {
        fenceBody = fileText;
        descriptionLine = caption;
    }

    const b = new StrBuilder();
    b.write("<details>\n");
    b.write(`<summary>Evidence: ${htmlEscape(label)}</summary>\n\n`);
    if (target !== "") {
        b.write(`Source: [${htmlEscape(label)}](${target})\n\n`);
    } else if (!hasFile && localPath !== "") {
        b.write(renderLocalArtifactReference("Source", label, localPath));
        b.write("\n");
    }
    if (descriptionLine !== "") {
        b.write(renderTestedDetail(descriptionLine));
        b.write("\n\n");
    }
    b.write(`\`\`\`text\n${escapeMarkdownFence(fenceBody)}\n\`\`\`\n`);
    b.write("</details>\n");
    return b.string();
}

/**
 * Reads a file artifact and returns its text content, truncated from the middle
 * when it exceeds maxEmbeddedArtifactBytes. ok is false when the artifact has no
 * path, points at an image/video, resolves outside the allowed roots, is missing,
 * empty, or is not UTF-8 text.
 */
function embeddedArtifactText(
    artifact: SanitizedArtifact,
    opts: TestingSummaryOptions,
    state: TestingArtifactRenderState | null
): [string, boolean] {
    if (artifact.path === "") return ["", false];
    if (state === null || state.remainingEmbeddedBytes <= 0) return ["", false];
    if (isImageArtifact(artifact.kind, artifact.path) || isVideoArtifact(artifact.kind, artifact.path)) {
        return ["", false];
    }
    const fsPath = artifactFilesystemPath(artifact.path, opts);
    if (fsPath === "") return ["", false];
    let text: string;
    try {
        text = readEmbeddedArtifactText(fsPath);
    } catch {
        return ["", false];
    }
    text = trimRightNewlines(text);
    if (text === "") return ["", false];
    const byteLen = Buffer.byteLength(text, "utf8");
    if (byteLen > state.remainingEmbeddedBytes) return ["", false];
    state.remainingEmbeddedBytes -= byteLen;
    return [text, true];
}

function artifactFilesystemPath(p: string, _opts: TestingSummaryOptions): string {
    if (p === "") return "";
    if (!path.isAbsolute(p)) return "";
    if (!artifactPathRelativeToRoot(p, testEvidenceRoot())[1]) return "";
    return p;
}

function readEmbeddedArtifactText(fsPath: string): string {
    const info = statSync(fsPath);
    if (info.isDirectory()) return "";
    if (info.size <= maxEmbeddedArtifactBytes) {
        const data = readFileSync(fsPath);
        if (!looksLikeTextArtifact(data)) return "";
        return data.toString("utf8");
    }

    const fd = openSync(fsPath, "r");
    try {
        const headSize = Math.floor(maxEmbeddedArtifactBytes / 2);
        const tailSize = maxEmbeddedArtifactBytes - headSize;
        let head: Buffer = Buffer.alloc(headSize);
        readFullAt(fd, head, 0);
        let tail: Buffer = Buffer.alloc(tailSize);
        readFullAt(fd, tail, info.size - tailSize);
        head = trimUTF8End(head);
        tail = trimUTF8Start(tail);
        if (!looksLikeTextArtifact(head) || !looksLikeTextArtifact(tail)) return "";
        const omitted = info.size - (head.length + tail.length);
        return `${head.toString("utf8")}\n\n... [${omitted} bytes truncated] ...\n\n${tail.toString("utf8")}`;
    } finally {
        closeSync(fd);
    }
}

/** Reads exactly buf.length bytes at position, mirroring Go's ReadAt contract. */
function readFullAt(fd: number, buf: Buffer, position: number): void {
    let offset = 0;
    while (offset < buf.length) {
        const read = readSync(fd, buf, offset, buf.length - offset, position + offset);
        if (read === 0) throw new Error("unexpected EOF");
        offset += read;
    }
}

function looksLikeTextArtifact(data: Buffer): boolean {
    if (data.length === 0) return false;
    if (data.indexOf(0) !== -1) return false;
    return isValidUTF8(data);
}

function trimUTF8End(data: Buffer): Buffer {
    while (data.length > 0 && !isValidUTF8(data)) {
        data = data.subarray(0, data.length - 1);
    }
    return data;
}

function trimUTF8Start(data: Buffer): Buffer {
    while (data.length > 0 && !isValidUTF8(data)) {
        const size = firstRuneSize(data);
        if (size <= 0) return Buffer.alloc(0);
        data = data.subarray(size);
    }
    return data;
}

function firstRuneSize(data: Buffer): number {
    const b = data[0];
    if (b < 0x80) return 1;
    if (b >= 0xc0 && b < 0xe0) return 2;
    if (b >= 0xe0 && b < 0xf0) return 3;
    if (b >= 0xf0 && b < 0xf8) return 4;
    return 1;
}

function artifactTargetForPath(artifact: SanitizedArtifact, opts: TestingSummaryOptions): string {
    const repoPath = repoRelativeArtifactPath(artifact.path, opts);
    if (repoPath === "") return "";
    if (opts.githubBlobBase === "" || opts.githubRawBase === "") return repoPath;
    if (isImageArtifact(artifact.kind, repoPath) || isVideoArtifact(artifact.kind, repoPath)) {
        return opts.githubRawBase + repoPath;
    }
    return opts.githubBlobBase + repoPath;
}

function artifactLinkTargetForPath(artifact: SanitizedArtifact, opts: TestingSummaryOptions): string {
    const repoPath = repoRelativeArtifactPath(artifact.path, opts);
    if (repoPath === "") return "";
    if (opts.githubBlobBase === "") return repoPath;
    return opts.githubBlobBase + repoPath;
}

function sanitizeArtifactPath(target: string, opts: TestingSummaryOptions): string {
    const clean = target.trim();
    if (clean === "" || clean !== sanitizePromptText(target) || containsAny(clean, "\n\r<>[]()`")) {
        return "";
    }
    if (path.isAbsolute(clean)) {
        return sanitizeAbsoluteArtifactPath(clean, opts);
    }
    if (clean.startsWith("/") || clean.startsWith("~") || clean.includes(":") || clean.includes("\\")) {
        return "";
    }
    const cleanedPath = posixClean(clean);
    if (cleanedPath === "." || cleanedPath !== clean || cleanedPath === ".." || cleanedPath.startsWith("../")) {
        return "";
    }
    return clean;
}

function sanitizeAbsoluteArtifactPath(clean: string, opts: TestingSummaryOptions): string {
    const cleanedPath = filepathClean(clean);
    if (cleanedPath !== clean) return "";
    if (artifactPathRelativeToRoot(cleanedPath, opts.repoRoot)[1]) return cleanedPath;
    if (artifactPathRelativeToRoot(cleanedPath, testEvidenceRoot())[1]) return cleanedPath;
    return "";
}

function repoRelativeArtifactPath(target: string, opts: TestingSummaryOptions): string {
    if (target === "") return "";
    if (!path.isAbsolute(target)) return target;
    const [rel, ok] = artifactPathRelativeToRoot(target, opts.repoRoot);
    if (!ok) return "";
    return toSlash(rel);
}

function localArtifactPath(target: string, opts: TestingSummaryOptions): string {
    if (target === "" || !path.isAbsolute(target)) return "";
    if (artifactPathRelativeToRoot(target, opts.repoRoot)[1]) return "";
    return target;
}

function artifactPathRelativeToRoot(target: string, root: string): [string, boolean] {
    root = root.trim();
    if (target === "" || root === "") return ["", false];
    let rootAbs: string;
    let targetAbs: string;
    try {
        rootAbs = path.resolve(root);
    } catch {
        return ["", false];
    }
    try {
        targetAbs = path.resolve(target);
    } catch {
        return ["", false];
    }
    rootAbs = filepathClean(rootAbs);
    targetAbs = filepathClean(targetAbs);
    rootAbs = resolveArtifactPathSymlinks(rootAbs);
    targetAbs = resolveArtifactPathSymlinks(targetAbs);
    if (!sameVolume(rootAbs, targetAbs)) return ["", false];
    let rel: string;
    try {
        rel = path.relative(rootAbs, targetAbs);
    } catch {
        return ["", false];
    }
    if (rel === "") rel = ".";
    if (rel === "." || rel === ".." || rel.startsWith(`..${path.sep}`)) return ["", false];
    return [rel, true];
}

function resolveArtifactPathSymlinks(target: string): string {
    try {
        return filepathClean(realpathSync(target));
    } catch {
        // The path (or a parent) does not exist; resolve the deepest existing
        // ancestor and re-append the remainder, matching Go's walk-up fallback.
    }
    let candidate = target;
    for (;;) {
        try {
            const resolved = realpathSync(candidate);
            let rel: string;
            try {
                rel = path.relative(candidate, target);
            } catch {
                return filepathClean(resolved);
            }
            if (rel === "" || rel === ".") return filepathClean(resolved);
            return filepathClean(path.join(resolved, rel));
        } catch {
            const parent = path.dirname(candidate);
            if (parent === candidate) return target;
            candidate = parent;
        }
    }
}

function sameVolume(a: string, b: string): boolean {
    const va = volumeName(a);
    const vb = volumeName(b);
    return va.toLowerCase() === vb.toLowerCase() || va === "" || vb === "";
}

function renderLocalArtifactLine(label: string, localPath: string): string {
    return renderLocalArtifactReference("- Evidence", label, localPath);
}

function renderLocalArtifactReference(prefix: string, label: string, localPath: string): string {
    return `${prefix}: ${htmlEscape(label)} (local file: <code>${htmlEscape(localPath)}</code>)\n`;
}

function sanitizeArtifactURL(target: string): string {
    const clean = target.trim();
    if (clean === "" || clean !== sanitizePromptText(target) || containsAny(clean, "\n\r <>[]()\"'")) {
        return "";
    }
    let parsed: URL;
    try {
        parsed = new URL(clean);
    } catch {
        return "";
    }
    if (parsed.host === "") return "";
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (scheme === "http" || scheme === "https") return clean;
    return "";
}

function markdownAltText(label: string): string {
    label = label.split("[").join("(");
    label = label.split("]").join(")");
    return label;
}

function isImageArtifact(kind: string, target: string): boolean {
    if (kind === "screenshot" || kind === "gif" || kind === "image") return true;
    const lower = target.toLowerCase();
    for (const suffix of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]) {
        if (lower.endsWith(suffix)) return true;
    }
    return false;
}

function isVideoArtifact(kind: string, target: string): boolean {
    if (kind === "video" || kind === "recording") return true;
    const lower = target.toLowerCase();
    for (const suffix of [".mp4", ".webm", ".mov"]) {
        if (lower.endsWith(suffix)) return true;
    }
    return false;
}

function escapeMarkdownFence(content: string): string {
    return content.split("```").join("`` `");
}

function buildTestingOutcomeLine(summaryLine: string, rounds: StepRound[]): string {
    const outcome = summaryLine.replace("**Test** - ", "").trim();
    if (outcome === "") return "";
    if (rounds.length === 0) return `Outcome: ${outcome}`;
    let runLabel = "1 run";
    if (rounds.length !== 1) runLabel = `${rounds.length} runs`;
    let totalDuration = 0;
    for (const r of rounds) totalDuration += r.durationMs;
    if (totalDuration > 0) {
        return `Outcome: ${outcome} across ${runLabel} (${formatTestingDuration(totalDuration)})`;
    }
    return `Outcome: ${outcome} across ${runLabel}`;
}

function formatTestingDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) {
        if (ms % 1000 === 0) return `${Math.floor(ms / 1000)}s`;
        return `${(ms / 1000).toFixed(1)}s`;
    }
    return formatDurationRoundSecond(ms);
}

/** Renders a >=1-minute duration rounded to whole seconds, Go Duration style. */
function formatDurationRoundSecond(ms: number): string {
    const secs = Math.round(ms / 1000);
    const s = secs % 60;
    const m = Math.floor(secs / 60) % 60;
    const h = Math.floor(secs / 3600);
    let out = "";
    if (h > 0) out += `${h}h`;
    if (h > 0 || m > 0) out += `${m}m`;
    out += `${s}s`;
    return out;
}

function buildStepEntry(sr: StepResult, rounds: StepRound[]): [string, string] {
    const name = stepDisplayName(sr.stepName);
    const buildDetail = (line: string): [string, string] => [line, buildStepDetails(line, sr, rounds)];

    switch (sr.status) {
        case "pending":
            return buildDetail(`⏳ **${name}** - pending`);
        case "running":
            return buildDetail(`⏳ **${name}** - running`);
        case "awaiting_approval":
            return buildDetail(`⏸️ **${name}** - awaiting approval`);
        case "fixing":
            return buildDetail(`🔄 **${name}** - auto-fixing`);
        case "fix_review":
            return buildDetail(`⏸️ **${name}** - review fix`);
        case "failed":
            return buildDetail(`❌ **${name}** - failed`);
    }

    if (sr.status === "skipped") {
        return buildDetail(`⏭️ **${name}** - skipped`);
    }

    // Parse the final findings on the step result (last state).
    let finalFindings: Findings | null = null;
    let finalFindingsParsed = sr.findingsJson === null;
    if (sr.findingsJson !== null) {
        try {
            finalFindings = parseFindingsJSON(sr.findingsJson);
            finalFindingsParsed = true;
        } catch {
            // Unreadable final findings.
        }
    }

    // Parse initial round findings (round 1) for the full story.
    let initialFindings: Findings | null = null;
    if (rounds.length > 0 && rounds[0].findingsJson !== null) {
        try {
            initialFindings = parseFindingsJSON(rounds[0].findingsJson);
        } catch {
            // Leave initialFindings null.
        }
    }

    // Parse latest round findings for risk fallback when final state is cleared.
    let latestRoundFindings: Findings | null = null;
    if (rounds.length > 0) {
        const last = rounds[rounds.length - 1];
        if (last.findingsJson !== null) {
            try {
                latestRoundFindings = parseFindingsJSON(last.findingsJson);
            } catch {
                // Leave latestRoundFindings null.
            }
        }
    }

    const hadFindings = initialFindings !== null && initialFindings.items.length > 0;
    const hasFinalFindings = finalFindings !== null && finalFindings.items.length > 0;
    const hasAnyRoundFindings = roundsHaveFindings(rounds);
    const hasRoundParseFailure = roundsHaveParseFailure(rounds);
    const hadAnyFindings = hadFindings || hasFinalFindings || hasAnyRoundFindings;
    const hasUnreadableFinalFindings = sr.findingsJson !== null && !finalFindingsParsed;
    const wasFixed = hadFindings && rounds.length > 1 && !hasUnreadableFinalFindings && !hasFinalFindings;
    let riskLevel = "";
    if (sr.stepName === STEP_REVIEW) {
        let src = finalFindings;
        if (src === null && !hasUnreadableFinalFindings) {
            src = latestRoundFindings;
        }
        if (src !== null) riskLevel = src.riskLevel;
    }

    // Unreadable final findings - can't make claims about the outcome.
    if (hasUnreadableFinalFindings) {
        return buildDetail(`⚠️ **${name}** - findings unavailable`);
    }

    if (sr.stepName === STEP_REVIEW && (riskLevel === "medium" || riskLevel === "high") && !hadAnyFindings) {
        return buildDetail(`${riskEmoji(riskLevel)} **${name}** - ${riskLevel} risk`);
    }

    if (!hadAnyFindings && !hasRoundParseFailure) {
        if (rounds.length === 0) {
            return buildDetail(`⚠️ **${name}** - findings unavailable`);
        }
        return buildDetail(`✅ **${name}** - passed`);
    }

    if (hasRoundParseFailure && !hadAnyFindings) {
        return buildDetail(`⚠️ **${name}** - findings unavailable`);
    }

    if (wasFixed) {
        const result = buildFixResultText(rounds);
        const line = `🔧 **${name}** - ${result} ✅`;
        return buildDetail(line);
    }

    let currentFindings = initialFindings;
    if (hasFinalFindings) currentFindings = finalFindings;

    // Had findings and the final state still contains them - approved as-is.
    const count = countFindingsBySeverity(currentFindings);
    const line = `⚠️ **${name}** - ${count}`;
    return buildDetail(line);
}

function extractRiskLine(steps: StepResult[], rounds: Map<string, StepRound[]>): string {
    for (const sr of steps) {
        if (sr.stepName !== STEP_REVIEW) continue;

        let finalFindings: Findings | null = null;
        let hasUnreadableFinal = false;
        if (sr.findingsJson !== null) {
            try {
                finalFindings = parseFindingsJSON(sr.findingsJson);
            } catch {
                hasUnreadableFinal = true;
            }
        }

        let src = finalFindings;
        if (src === null && !hasUnreadableFinal) {
            const stepRounds = rounds.get(sr.id) ?? [];
            if (stepRounds.length > 0) {
                const last = stepRounds[stepRounds.length - 1];
                if (last.findingsJson !== null) {
                    try {
                        src = parseFindingsJSON(last.findingsJson);
                    } catch {
                        // Leave src null.
                    }
                }
            }
        }

        if (src === null || src.riskLevel === "") return "";

        const emoji = riskEmoji(src.riskLevel);
        const label = capitalizeRisk(src.riskLevel);
        if (src.riskRationale !== "") {
            return `${emoji} ${label}: ${src.riskRationale}`;
        }
        return `${emoji} ${label}`;
    }
    return "";
}

function capitalizeRisk(level: string): string {
    if (level === "") return level;
    return level[0].toUpperCase() + level.slice(1);
}

function riskEmoji(level: string): string {
    switch (level) {
        case "low":
            return "✅";
        case "medium":
            return "⚠️";
        case "high":
            return "🚨";
        default:
            return "ℹ️";
    }
}

function roundsHaveFindings(rounds: StepRound[]): boolean {
    for (const r of rounds) {
        if (r.findingsJson === null) continue;
        let f: Findings;
        try {
            f = parseFindingsJSON(r.findingsJson);
        } catch {
            continue;
        }
        if (f.items.length > 0) return true;
    }
    return false;
}

function roundsHaveParseFailure(rounds: StepRound[]): boolean {
    for (const r of rounds) {
        if (r.findingsJson === null) continue;
        try {
            parseFindingsJSON(r.findingsJson);
        } catch {
            return true;
        }
    }
    return false;
}

function buildFixResultText(rounds: StepRound[]): string {
    // Count findings in round 1.
    let initialCount = 0;
    if (rounds.length > 0 && rounds[0].findingsJson !== null) {
        try {
            initialCount = parseFindingsJSON(rounds[0].findingsJson).items.length;
        } catch {
            // Leave initialCount at zero.
        }
    }

    // Categorize fix rounds. Legacy "user_fix" rounds are rendered as auto-fix.
    let autoFixRounds = 0;
    for (const r of rounds.slice(1)) {
        if (isFixRound(r)) autoFixRounds++;
    }

    let noun = "issue";
    if (initialCount !== 1) noun = "issues";

    const parts = [`${initialCount} ${noun} found`];

    if (autoFixRounds > 1) {
        parts.push(`auto-fixed (${autoFixRounds})`);
    } else if (autoFixRounds === 1) {
        parts.push("auto-fixed");
    }

    return parts.join(" → ");
}

/**
 * Renders the collapsible body for a step as an issue -> fix -> outcome
 * narrative rather than a round-by-round log.
 */
function buildStepDetails(summaryLine: string, sr: StepResult, rounds: StepRound[]): string {
    const b = new StrBuilder();
    b.write("<details>\n");
    b.write(`<summary>${summaryLine}</summary>\n\n`);

    if (rounds.length === 0) {
        writeStepStatusDetail(b, sr);
        b.write("</details>\n");
        return b.string();
    }

    // True only when the step recorded final findings but no round captured
    // them - a data gap we must not paper over as "no issues found".
    const missingRoundFindingsData =
        sr.findingsJson !== null && !roundsHaveFindings(rounds) && !roundsHaveParseFailure(rounds);

    for (const r of rounds) {
        const isFix = isFixRound(r);
        if (isFix) {
            b.write(fixRoundLine(r));
            b.write("\n");
        }

        if (r.findingsJson === null) {
            if (missingRoundFindingsData) {
                b.write("findings not recorded\n\n");
            } else if (isFix) {
                b.write("✅ Re-checked - no issues remain.\n\n");
            } else {
                b.write("✅ No issues found.\n\n");
            }
            continue;
        }

        let findings: Findings;
        try {
            findings = parseFindingsJSON(r.findingsJson);
        } catch {
            b.write("failed to parse findings\n\n");
            continue;
        }

        if (findings.items.length === 0) {
            if (isFix) {
                b.write("✅ Re-checked - no issues remain.\n");
            } else {
                b.write("✅ No issues found.\n");
            }
            writeTestedDetails(b, sr, findings);
            b.write("\n");
            continue;
        }

        // A fix round that still has findings means the fix did not fully land;
        // label what remained so the chain reads as fix -> still open.
        if (isFix) {
            b.write(`${countFindingsBySeverity(findings)} still open:\n`);
        }
        writeFindingItems(b, sr, findings);
        b.write("\n");
    }

    b.write("</details>\n");
    return b.string();
}

function fixRoundLine(r: StepRound): string {
    let summary = "";
    if (r.fixSummary !== null) summary = r.fixSummary.trim();
    if (summary === "") return "🔧 Fix applied.";
    return `🔧 Fix: ${htmlEscape(summary)}`;
}

function writeFindingItems(b: StrBuilder, sr: StepResult, findings: Findings): void {
    for (const f of findings.items) {
        const emoji = severityEmoji(f.severity);
        let loc = "";
        if ((f.file ?? "") !== "") {
            loc = `\`${htmlEscape(f.file ?? "")}`;
            if ((f.line ?? 0) > 0) {
                loc += `:${f.line}`;
            }
            loc += "` - ";
        }
        b.write(`- ${emoji} ${loc}${htmlEscape(f.description)}\n`);
    }
    writeTestedDetails(b, sr, findings);
}

function writeTestedDetails(b: StrBuilder, sr: StepResult, findings: Findings): void {
    if (sr.stepName !== STEP_TEST) return;
    for (const detail of findings.tested ?? []) {
        const rendered = renderTestedDetail(detail);
        if (rendered === "") continue;
        b.write(`- ${rendered}\n`);
    }
}

function writeStepStatusDetail(b: StrBuilder, sr: StepResult): void {
    switch (sr.status) {
        case "pending":
            b.write("Step has not started yet.\n\n");
            break;
        case "running":
            b.write("Step is currently running.\n\n");
            break;
        case "awaiting_approval":
            b.write("Waiting for user approval.\n\n");
            break;
        case "fixing":
            b.write("Agent is currently applying fixes.\n\n");
            break;
        case "fix_review":
            b.write("Waiting to review the latest fix.\n\n");
            break;
        case "skipped":
            b.write("Step was skipped.\n\n");
            break;
        case "failed":
            if (sr.error !== null && sr.error.trim() !== "") {
                b.write(htmlEscape(sr.error.trim()));
                b.write("\n\n");
                return;
            }
            b.write("Step failed.\n\n");
            break;
        case "completed":
            b.write("No round details recorded.\n\n");
            break;
        default:
            b.write("Status unavailable.\n\n");
    }
}

function shouldOmitPipelineStep(sr: StepResult | null): boolean {
    if (sr === null) return false;
    return sr.stepName === STEP_PR || sr.stepName === STEP_CI;
}

function countFindingsBySeverity(findings: Findings | null): string {
    if (findings === null || findings.items.length === 0) return "0 issues";

    const counts = new Map<string, number>();
    for (const f of findings.items) {
        counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
    }

    const total = findings.items.length;
    let noun = "issue";
    if (total !== 1) noun = "issues";

    // If all same severity, just show count + severity.
    if (counts.size === 1) {
        for (const [sev, n] of counts) {
            let label = sev;
            if (n !== 1) label += "s";
            return `${n} ${label}`;
        }
    }

    // Mixed severities: "3 issues (1 error, 2 warnings)".
    const parts: string[] = [];
    for (const sev of ["error", "warning", "info"]) {
        const n = counts.get(sev);
        if (n !== undefined) {
            let label = sev;
            if (n !== 1) label += "s";
            parts.push(`${n} ${label}`);
        }
    }
    return `${total} ${noun} (${parts.join(", ")})`;
}

function severityEmoji(severity: string): string {
    switch (severity) {
        case "error":
            return "🚨";
        case "warning":
            return "⚠️";
        case "info":
            return "ℹ️";
        default:
            return "-";
    }
}

function stepDisplayName(name: StepName): string {
    switch (name) {
        case STEP_REBASE:
            return "Rebase";
        case STEP_REVIEW:
            return "Review";
        case STEP_TEST:
            return "Test";
        case STEP_DOCUMENT:
            return "Document";
        case STEP_LINT:
            return "Lint";
        case STEP_PUSH:
            return "Push";
        case STEP_PR:
            return "PR";
        case STEP_CI:
            return "CI";
        default:
            return name;
    }
}

// --- Standard-library helpers ported inline (Go html/url/path/utf8). ---

/** Reports whether `s` contains any single character of `chars` (Go ContainsAny). */
function containsAny(s: string, chars: string): boolean {
    for (const c of chars) {
        if (s.includes(c)) return true;
    }
    return false;
}

function countOccurrences(s: string, sub: string): number {
    if (sub === "") return s.length + 1;
    let count = 0;
    let idx = s.indexOf(sub);
    while (idx !== -1) {
        count++;
        idx = s.indexOf(sub, idx + sub.length);
    }
    return count;
}

function trimRightNewlines(s: string): string {
    return s.replace(/\n+$/, "");
}

/** Escapes the five characters Go's html.EscapeString escapes. */
function htmlEscape(s: string): string {
    let out = "";
    for (const ch of s) {
        switch (ch) {
            case "&":
                out += "&amp;";
                break;
            case "'":
                out += "&#39;";
                break;
            case "<":
                out += "&lt;";
                break;
            case ">":
                out += "&gt;";
                break;
            case '"':
                out += "&#34;";
                break;
            default:
                out += ch;
        }
    }
    return out;
}

/** Percent-encodes a path segment exactly like Go's url.PathEscape. */
function pathEscape(s: string): string {
    let out = "";
    for (const b of Buffer.from(s, "utf8")) {
        if (shouldEscapePathSegment(b)) {
            out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
        } else {
            out += String.fromCharCode(b);
        }
    }
    return out;
}

function shouldEscapePathSegment(b: number): boolean {
    if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39)) return false;
    switch (String.fromCharCode(b)) {
        case "-":
        case "_":
        case ".":
        case "~":
        case "$":
        case "&":
        case "+":
        case ":":
        case "=":
        case "@":
            return false;
        default:
            return true;
    }
}

function isValidUTF8(data: Buffer): boolean {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
        return true;
    } catch {
        return false;
    }
}

function toSlash(p: string): string {
    if (path.sep === "/") return p;
    return p.split(path.sep).join("/");
}

/** Go path.Clean: lexical clean of a forward-slash path. */
function posixClean(p: string): string {
    return cleanImpl("", p, "/", c => c === "/");
}

/** Go filepath.Clean for the host OS (volume-aware backslash clean on Windows). */
function filepathClean(p: string): string {
    if (path.sep === "/") return cleanImpl("", p, "/", c => c === "/");
    const vol = volumeName(p);
    return cleanImpl(vol, p.slice(vol.length), "\\", c => c === "\\" || c === "/");
}

function cleanImpl(volume: string, p: string, SEP: string, isSep: (c: string) => boolean): string {
    if (p === "") return `${volume}.`;
    const rooted = isSep(p[0]);
    const n = p.length;
    const buf: string[] = [];
    let w = 0;
    const append = (c: string): void => {
        if (w < buf.length) buf[w] = c;
        else buf.push(c);
        w++;
    };
    let r = 0;
    let dotdot = 0;
    if (rooted) {
        append(SEP);
        r = 1;
        dotdot = 1;
    }
    while (r < n) {
        if (isSep(p[r])) {
            r++;
        } else if (p[r] === "." && (r + 1 === n || isSep(p[r + 1]))) {
            r++;
        } else if (p[r] === "." && r + 1 < n && p[r + 1] === "." && (r + 2 === n || isSep(p[r + 2]))) {
            r += 2;
            if (w > dotdot) {
                w--;
                while (w > dotdot && !isSep(buf[w])) w--;
            } else if (!rooted) {
                if (w > 0) append(SEP);
                append(".");
                append(".");
                dotdot = w;
            }
        } else {
            if ((rooted && w !== 1) || (!rooted && w !== 0)) append(SEP);
            while (r < n && !isSep(p[r])) {
                append(p[r]);
                r++;
            }
        }
    }
    if (w === 0) append(".");
    return volume + buf.slice(0, w).join("");
}

/** Go filepath.VolumeName: the drive/UNC prefix on Windows, "" on POSIX. */
function volumeName(p: string): string {
    if (path.sep === "/") return "";
    return p.slice(0, volumeNameLen(p));
}

function volumeNameLen(p: string): number {
    if (p.length < 2) return 0;
    const c = p.charCodeAt(0);
    if (p[1] === ":" && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return 2;
    const isSep = (ch: string): boolean => ch === "\\" || ch === "/";
    if (p.length >= 5 && isSep(p[0]) && isSep(p[1]) && !isSep(p[2]) && p[2] !== ".") {
        let i = 3;
        for (; i < p.length; i++) {
            if (isSep(p[i])) break;
        }
        if (i < p.length - 1) {
            i++;
            let j = i;
            for (; j < p.length; j++) {
                if (isSep(p[j])) break;
            }
            return j;
        }
    }
    return 0;
}
