/**
 * enigma verify: a deterministic gate against false completion claims.
 *
 * The failure mode this exists for: an agent finishes a turn saying the work is done
 * when it is not - a module left empty, a hard function replaced by a placeholder, a
 * complex parser swapped for a regex because the real port was tedious. Telling the
 * model to be honest does not fix it (the memory kernel already says exactly that, and
 * it still happens), because a claim is cheap and nothing checks it.
 *
 * So the claim is checked OUTSIDE the model. On turn end, the agent's own final message
 * is matched against completion claims; only when it asserts the work is finished does
 * the engine look for evidence to the contrary in the code the turn actually produced
 * (added lines vs HEAD plus untracked files) and, when configured, run the project's own
 * verification command. Evidence against a claim exits 2, which feeds the findings back
 * and denies the stop, so the model must either finish the work or state what is missing.
 *
 * Cost model: the claim check is a regex over one string, so a turn that claims nothing
 * costs nothing, and a turn that does claim pays one git diff. No model tokens are spent
 * unless the gate actually fires, and then only on the findings.
 *
 * Precision over recall throughout: a false block would train the user to switch this
 * off, so every pattern matches only unambiguous evidence, documents legitimately
 * tracking TODOs are excluded, and a line carrying `enigma:verify-ignore` is skipped.
 */

import { join, extname } from "node:path";
import { enigmaHome, readJson } from "./util";
import { readConfigAt, readGlobalConfig } from "./config";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** One piece of evidence that the work is not finished. */
export interface VerifyGap {
    /** `marker` = an incompleteness marker in produced code; `command` = the project's check failed. */
    kind: "marker" | "command";
    file?: string;
    line?: number;
    detail: string;
}

/** Files whose task lists are legitimate content rather than unfinished code. */
const DOC_EXT = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

/** Escape hatch: a line carrying this token is never treated as evidence. */
const IGNORE_RE = /enigma:verify-ignore/;

/** Hard caps so the gate stays fast on any repository. */
const MAX_GAPS = 25;
const MAX_ADDED_LINES = 40000;
const MAX_UNTRACKED_BYTES = 512 * 1024;

/** How many times one prompt may be blocked before the gate stands down (loop safety). */
const MAX_BLOCKS_PER_PROMPT = 2;

/**
 * Evidence patterns. Each matches only an unambiguous "this is not finished" signal.
 * `notNear` suppresses a hit when the preceding lines show it is a legitimate idiom
 * (a Python abstract method raises the unimplemented error by design, for example).
 */
const INCOMPLETE_PATTERNS: Array<{ id: string; re: RegExp; label: string; notNear?: RegExp }> = [
    { id: "todo-marker", re: /(?:^|[^\w])(TODO|FIXME|XXX|HACK)\b/, label: "unfinished-work marker" }, // enigma:verify-ignore
    {
        id: "unimplemented-path",
        re: /\bnot[ _-]?implemented\b|\bNotImplementedError\b|\bunimplemented!\s*\(|\btodo!\s*\(|\bNotImplementedException\b/i, // enigma:verify-ignore
        label: "unimplemented code path",
        // An abstract base class or protocol raises it by design, so a hit there is not a stub.
        notNear: /@abstractmethod|abstractproperty|\bABC\b|\bProtocol\b|@abc\./,
    },
    { id: "placeholder", re: /(?:\/\/|#|\/\*|<!--|--)\s*(placeholder|stub\b|coming soon|fill (?:this )?in|implement (?:this|later))/i, label: "placeholder left in place" },
];

// --- completion-claim detection ----------------------------------------------------

/**
 * Sentences asserting the work is finished. Kept to unambiguous assertions in the two
 * languages enigma is used in, so an ordinary progress note never trips the gate.
 */
const CLAIM_RE = /\b(?:all done|everything (?:is )?(?:done|complete|completed|implemented|working|works)|fully (?:done|implemented|ported|migrated|complete)|(?:is|are) (?:now )?(?:fully )?(?:complete|completed|implemented|functional)|nothing (?:is )?(?:left|missing|remaining)|no(?:thing)? (?:further )?(?:changes|work|items|steps)? ?(?:are |is )?(?:needed|remaining|pending)|ready to use|100% (?:complete|done|working))\b|(?:ya está(?: todo)?\b|todo (?:listo|hecho|completado|implementado|funcionando)\b|está (?:todo )?(?:listo|completo|completado|terminado)\b|no falta nada\b|completado con éxito\b|funciona (?:correctamente|perfectamente|al 100))/i;

/**
 * Phrases that disclose remaining work. A message containing one is an honest report, not
 * a false claim, so the gate leaves it alone. `falta` carries a negative lookbehind because
 * "no falta nada" asserts the opposite - it is a claim, and CLAIM_RE reads it as one.
 */
const DISCLOSURE_RE = /\b(?:still (?:pending|missing|to do|needs)|remains? (?:pending|to be|unfinished)|left to do|not (?:yet )?(?:implemented|verified|tested|done)|could not|unable to|unverified|blocked by)\b|(?:(?<!no )falta(?:n|ría|ban)?\b|pendiente|sin implementar|no implement|queda(?:n)? por|no pude|no he podido)/i;

/**
 * Whether the agent's final message asserts the work is finished without disclosing any
 * remaining item. Disclosure wins over assertion, including within one sentence, so
 * "the port is complete except for two modules I could not finish" is read as the honest
 * report it is - the gate exists to catch silence about gaps, never to punish naming them.
 */
export function claimsDone(message: string): boolean {
    if (!message || typeof message !== "string") return false;
    const sentences = message.split(/(?<=[.!?\n])\s+/).filter(Boolean);
    let claim = false;
    for (const sentence of sentences) {
        if (DISCLOSURE_RE.test(sentence)) return false;
        if (CLAIM_RE.test(sentence)) claim = true;
    }
    return claim;
}

// --- evidence: what this turn actually produced -------------------------------------

/** One line added by the current change. */
export interface AddedLine { file: string; line: number; text: string; }

/** Run git in `cwd`, returning stdout ("" when git fails or the dir is not a repo). */
function gitOut(cwd: string, args: string[]): string {
    try { return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return ""; }
}

/**
 * Lines this change ADDED: the `+` lines of the working tree against HEAD, plus every
 * line of an untracked file. Scanning added lines only (the ratchet the changed-line
 * linter already uses) means a repository's pre-existing TODOs never block a turn.
 */
export function addedLines(cwd: string): AddedLine[] {
    const out: AddedLine[] = [];
    let file = "";
    let line = 0;
    for (const raw of gitOut(cwd, ["diff", "--unified=0", "--no-color", "HEAD"]).split("\n")) {
        if (raw.startsWith("+++ ")) { file = raw.slice(4).replace(/^b\//, ""); continue; }
        if (raw.startsWith("@@")) { const m = /\+(\d+)/.exec(raw); line = m ? Number(m[1]) : 0; continue; }
        if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
        if (file && file !== "/dev/null") out.push({ file, line, text: raw.slice(1) });
        line++;
        if (out.length >= MAX_ADDED_LINES) return out;
    }
    for (const path of gitOut(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").map((s) => s.trim()).filter(Boolean)) {
        const text = readTextFile(join(cwd, path), MAX_UNTRACKED_BYTES);
        if (text === null) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) out.push({ file: path, line: i + 1, text: lines[i]! });
        if (out.length >= MAX_ADDED_LINES) return out;
    }
    return out;
}

/** Every tracked file's lines, for the whole-repository sweep (`enigma verify --all`). */
function trackedLines(cwd: string): AddedLine[] {
    const out: AddedLine[] = [];
    for (const path of gitOut(cwd, ["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean)) {
        const text = readTextFile(join(cwd, path), MAX_UNTRACKED_BYTES);
        if (text === null) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) out.push({ file: path, line: i + 1, text: lines[i]! });
        if (out.length >= MAX_ADDED_LINES) return out;
    }
    return out;
}

/** Read a text file, or null when it is missing, too large, or binary. */
function readTextFile(path: string, maxBytes: number): string | null {
    try {
        const buf = readFileSync(path);
        if (buf.length > maxBytes || buf.includes(0)) return null;
        return buf.toString("utf8");
    } catch { return null; }
}

/** Whether a hit is a legitimate idiom given the lines preceding it in the file. */
function suppressedByContext(cwd: string, file: string, line: number, notNear: RegExp): boolean {
    const text = readTextFile(join(cwd, file), MAX_UNTRACKED_BYTES);
    if (text === null) return false;
    const lines = text.split("\n");
    const from = Math.max(0, line - 6);
    return lines.slice(from, line).some((l) => notNear.test(l));
}

/** Match the evidence patterns against a set of lines. */
function scanLines(cwd: string, lines: AddedLine[]): VerifyGap[] {
    const gaps: VerifyGap[] = [];
    for (const entry of lines) {
        if (DOC_EXT.has(extname(entry.file).toLowerCase())) continue;
        if (IGNORE_RE.test(entry.text)) continue;
        for (const pattern of INCOMPLETE_PATTERNS) {
            if (!pattern.re.test(entry.text)) continue;
            if (pattern.notNear && suppressedByContext(cwd, entry.file, entry.line, pattern.notNear)) break;
            gaps.push({ kind: "marker", file: entry.file, line: entry.line, detail: `${pattern.label}: ${entry.text.trim().slice(0, 160)}` });
            break;
        }
        if (gaps.length >= MAX_GAPS) break;
    }
    return gaps;
}

/** Evidence of unfinished work in the code this change produced. */
export function scanGaps(cwd: string, all = false): VerifyGap[] {
    return scanLines(cwd, all ? trackedLines(cwd) : addedLines(cwd));
}

/**
 * Run the project's own verification command and report a gap when it fails. Read from
 * the GLOBAL config only: a repo-local .enigma.json travels with a clone, so honouring
 * one here would let a cloned repository execute a command on the machine that runs it.
 */
export function runVerifyCommand(cwd: string, command: string): VerifyGap | null {
    const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: 300_000 });
    if (result.status === 0) return null;
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim().slice(-1500);
    const why = result.status === null ? "did not finish (timed out or was killed)" : `exited ${result.status}`;
    return { kind: "command", detail: `the project's verification command \`${command}\` ${why}\n${output}` };
}

/** The configured verification command, or "" when none is set. */
export function verifyCommandOf(): string {
    return (readGlobalConfig().verifyCommand || "").trim();
}

/** All evidence: incompleteness markers, plus the verification command when configured. */
export function collectGaps(cwd: string, opts: { all?: boolean; runCommand?: boolean } = {}): VerifyGap[] {
    const gaps = scanGaps(cwd, opts.all);
    const command = opts.runCommand === false ? "" : verifyCommandOf();
    if (command) {
        const failure = runVerifyCommand(cwd, command);
        if (failure) gaps.push(failure);
    }
    return gaps;
}

/** Format evidence as a compact, model-facing list. */
export function formatGaps(gaps: VerifyGap[]): string {
    return gaps.map((g) => (g.file ? `- ${g.file}:${g.line} ${g.detail}` : `- ${g.detail}`)).join("\n");
}

// --- turn-end gate -------------------------------------------------------------------

/** Where the per-prompt block counter lives (loop safety across hook invocations). */
function statePath(): string {
    return join(enigmaHome(), "verify-state.json");
}

/**
 * Count this block against `key` and report whether the gate may still fire. Capped so a
 * model that cannot satisfy the gate is never trapped in an endless stop/continue loop.
 */
function mayBlock(key: string): boolean {
    const path = statePath();
    const state = readJson<Record<string, number>>(path) || {};
    const count = (state[key] || 0) + 1;
    if (count > MAX_BLOCKS_PER_PROMPT) return false;
    state[key] = count;
    // Keep the file bounded; the newest entries are the only ones a live turn can hit.
    const keys = Object.keys(state);
    for (const stale of keys.slice(0, Math.max(0, keys.length - 50))) delete state[stale];
    try {
        mkdirSync(enigmaHome(), { recursive: true });
        writeFileSync(path, `${JSON.stringify(state)}\n`);
    } catch { /* a read-only home must not break the gate */ }
    return true;
}

/**
 * The message fed back to the model when a completion claim is contradicted by evidence.
 * Deliberately framed at maximum stakes: the whole point of this gate is that a false
 * "done" is a worse outcome than an honest "unfinished", and the model must feel that.
 */
function blockMessage(gaps: VerifyGap[]): string {
    return [
        "enigma verify: STOP. You just reported this work as finished, but a deterministic check of what you actually produced contradicts that claim:",
        "",
        formatGaps(gaps),
        "",
        "Treat this as mission-critical: lives depend on this code being genuinely correct and complete, and a false \"done\" is the single worst outcome possible here - far worse than admitting the work is unfinished. Someone will rely on your report without re-reading every line.",
        "Do not stop now. Either:",
        "  1. Finish the work for real - implement every item above properly. No placeholders, no stubs, no simplified stand-in, no regex standing in for logic that needs a real implementation, and nothing skipped because it was tedious or hard. Then verify it actually runs, not merely that it compiles.",
        "  2. Or, if an item is genuinely blocked or was deliberately deferred, say so EXPLICITLY in your reply: name the exact file, what is missing, and why. An honestly reported gap is acceptable; a silent one is not.",
        "Never round an unfinished item up to \"done\".",
    ].join("\n");
}

/**
 * Turn-end hook entry. Reads a Claude Code `Stop` payload (from `payload` or stdin) and
 * returns the process exit code: 2 when a completion claim is contradicted by evidence
 * (stderr is fed back to the model and the stop is denied), else 0.
 */
export function runVerifyHook(payload?: string): number {
    let raw: Record<string, unknown> = {};
    // Strip a leading BOM before parsing: JSON.parse throws on one, and this gate failing
    // open is exactly the silent pass it exists to prevent.
    try { raw = JSON.parse((payload ?? readFileSync(0, "utf8")).replace(/^\uFEFF/, "")) || {}; } catch { return 0; }
    // Already re-entered from a previous block: never stack gates on one turn.
    if (raw.stop_hook_active === true) return 0;

    const cwd = typeof raw.cwd === "string" && existsSync(raw.cwd) ? raw.cwd : process.cwd();
    if (!readConfigAt(cwd).verify) return 0;

    const message = typeof raw.last_assistant_message === "string" ? raw.last_assistant_message : "";
    if (!claimsDone(message)) return 0;

    const gaps = collectGaps(cwd);
    if (!gaps.length) return 0;

    const key = String(raw.prompt_id || raw.session_id || "session");
    if (!mayBlock(key)) return 0;
    process.stderr.write(`${blockMessage(gaps)}\n`);
    return 2;
}
