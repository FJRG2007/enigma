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

import { createHash } from "node:crypto";
import { join, extname } from "node:path";
import { enigmaHome, readJson } from "./util";
import { readConfigAt, readGlobalConfig } from "./config";
import { lastAssistantMessage } from "./claude-transcripts";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";

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

/** How long the project's verification command may run before it is given up on. */
const TIMEOUT_MS = 300_000;

/** Hard caps so the gate stays fast on any repository. */
const MAX_GAPS = 25;
const MAX_ADDED_LINES = 40000;
const MAX_UNTRACKED_BYTES = 512 * 1024;

/** How many times the SAME evidence may block before the gate stands down (loop safety). */
const MAX_BLOCKS_PER_ISSUE = 2;

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
    // The bare-token comment openers (# and --) need real separation before the word, or this
    // fires on ordinary code: a CSS custom property (`--placeholder-color`), an anchor
    // (`href="#placeholder"`) or a CLI flag (`--stub`) are not placeholders left behind.
    { id: "placeholder", re: /(?:(?:\/\/|\/\*|<!--)\s*|(?:#|--)[ \t]+)(placeholder|stub\b|coming soon|fill (?:this )?in|implement (?:this|later))/i, label: "placeholder left in place" },
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

/** The lines a scan read, and whether anything stopped it from reading them all. */
export interface ScannedLines { lines: AddedLine[]; truncated: boolean; noRepo?: boolean; }

/** Whether `cwd` is inside a git repository at all (git missing counts as "no"). */
function inGitRepo(cwd: string): boolean {
    return gitOut(cwd, ["rev-parse", "--git-dir"]).trim() !== "";
}

/** Run git in `cwd`, returning stdout ("" when git fails or the dir is not a repo). */
function gitOut(cwd: string, args: string[]): string {
    try { return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return ""; }
}

/**
 * Where this branch left the default branch, so the work it has already committed counts as
 * evidence. Returns null when nothing resolves - a detached HEAD, no remote, a repository
 * with no commits - and the caller then falls back to the working tree alone rather than
 * failing: this runs inside a turn-end hook and must never break the turn.
 */
function branchPoint(cwd: string): string | null {
    const refs: string[] = [];
    // The branch's own upstream first: it is the only ref that knows a develop-based flow, and
    // guessing main/master there can pick a merge-base months back, making everything committed
    // since count as this turn's work.
    const upstream = gitOut(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).trim();
    if (upstream) refs.push(upstream);
    const originHead = gitOut(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).trim();
    if (originHead) refs.push(originHead);
    refs.push("origin/main", "origin/master", "main", "master");
    for (const ref of refs) {
        const base = gitOut(cwd, ["merge-base", ref, "HEAD"]).trim();
        if (base) return base;
    }
    return null;
}

/** Feed every added line of a unified (-U0) diff to `sink`, stopping when it returns false. */
function eachAddedLine(diff: string, sink: (file: string, line: number, text: string) => boolean): void {
    let file = "";
    let line = 0;
    let previous = "";
    for (const raw of diff.split("\n")) {
        // A `+++ ` line is only the file header when it follows the `--- ` one; an ADDED line
        // of content that happens to start with "++ " must not be mistaken for a header, or
        // every later finding in the diff is attributed to a file that does not exist.
        if (raw.startsWith("+++ ") && previous.startsWith("--- ")) { file = raw.slice(4).replace(/^b\//, ""); previous = raw; continue; }
        previous = raw;
        if (raw.startsWith("@@")) { const m = /\+(\d+)/.exec(raw); line = m ? Number(m[1]) : 0; continue; }
        if (!raw.startsWith("+")) continue;
        if (file && file !== "/dev/null" && !sink(file, line, raw.slice(1))) return;
        line++;
    }
}

/**
 * The lines this piece of work ADDED: everything that differs between the branch point and
 * the working tree right now, plus untracked files.
 *
 * ONE diff against the branch point, not two. Diffing the branch point against the working
 * tree covers committed and uncommitted work together - which matters because enigma's own
 * workflow tells an agent to commit before validating, and diffing HEAD alone leaves an empty
 * diff there, so the gate would find nothing and pass a false claim in exactly the flow it
 * recommends. Unioning a working-tree diff with a `base..HEAD` diff also covered it, but
 * wrongly: a marker committed earlier and since deleted still showed up in the second diff,
 * so the gate blocked over something the agent had already fixed. A single diff always
 * describes the CURRENT state. Added lines only (the ratchet the changed-line linter uses),
 * so a repository's pre-existing markers never block a turn.
 */
export function addedLines(cwd: string): ScannedLines {
    const lines: AddedLine[] = [];
    let truncated = false;
    // Outside a repository there is no diff to read, and an empty result would otherwise be
    // indistinguishable from "nothing wrong" - the silent pass this whole module exists against.
    if (!inGitRepo(cwd)) return { lines, truncated, noRepo: true };
    const add = (file: string, line: number, text: string): boolean => {
        if (lines.length >= MAX_ADDED_LINES) { truncated = true; return false; }
        lines.push({ file, line, text });
        return true;
    };
    eachAddedLine(gitOut(cwd, ["diff", "--unified=0", "--no-color", branchPoint(cwd) || "HEAD"]), add);
    for (const path of gitOut(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").map((s) => s.trim()).filter(Boolean)) {
        if (!readInto(cwd, path, add, () => { truncated = true; })) break;
    }
    return { lines, truncated };
}

/** Every tracked file's lines, for the whole-repository sweep (`enigma verify --all`). */
function trackedLines(cwd: string): ScannedLines {
    const lines: AddedLine[] = [];
    let truncated = false;
    if (!inGitRepo(cwd)) return { lines, truncated, noRepo: true };
    const add = (file: string, line: number, text: string): boolean => {
        if (lines.length >= MAX_ADDED_LINES) { truncated = true; return false; }
        lines.push({ file, line, text });
        return true;
    };
    for (const path of gitOut(cwd, ["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean)) {
        if (!readInto(cwd, path, add, () => { truncated = true; })) break;
    }
    return { lines, truncated };
}

/**
 * Feed one file's lines to `sink`. Reports `onSkipped` only for a file skipped because it is
 * too large - that is coverage the caller has to disclose - and not for a binary one, which
 * has no lines to miss. Returns false when the sink asked to stop.
 */
function readInto(cwd: string, path: string, sink: (file: string, line: number, text: string) => boolean, onSkipped: () => void): boolean {
    const full = join(cwd, path);
    let size = 0;
    try { size = statSync(full).size; } catch { return true; }
    // Binary-ness is checked BEFORE size: a large image or archive has no lines to miss, so
    // announcing "only partially checked" for one would be noise in the single signal that is
    // supposed to mean coverage was genuinely incomplete.
    if (size > MAX_UNTRACKED_BYTES) { if (!isBinary(full)) onSkipped(); return true; }
    const text = readTextFile(full, MAX_UNTRACKED_BYTES);
    if (text === null) return true;
    const rows = text.split("\n");
    for (let i = 0; i < rows.length; i++) if (!sink(path, i + 1, rows[i]!)) return false;
    return true;
}

/** Whether a file looks binary, judged from a NUL byte in its opening bytes. */
function isBinary(path: string): boolean {
    let fd: number;
    try { fd = openSync(path, "r"); } catch { return false; }
    try {
        const buf = Buffer.alloc(4096);
        const read = readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, read).includes(0);
    } catch { return false; }
    finally { closeSync(fd); }
}

/** Read a text file, or null when it is missing, too large, or binary. */
function readTextFile(path: string, maxBytes: number): string | null {
    try {
        const buf = readFileSync(path);
        if (buf.length > maxBytes || buf.includes(0)) return null;
        return buf.toString("utf8");
    } catch { return null; }
}

/**
 * Whether a hit is a legitimate idiom given the lines preceding it in the file. `cache` holds
 * files already split for this scan: without it a Python port full of abstract methods - the
 * very case this exists for - re-reads the same file once per occurrence, inside a hook that
 * runs at the end of every turn.
 */
function suppressedByContext(cwd: string, file: string, line: number, notNear: RegExp, cache: Map<string, string[]>): boolean {
    let lines = cache.get(file);
    if (!lines) {
        const text = readTextFile(join(cwd, file), MAX_UNTRACKED_BYTES);
        lines = text === null ? [] : text.split("\n");
        cache.set(file, lines);
    }
    if (!lines.length) return false;
    const from = Math.max(0, line - 6);
    return lines.slice(from, line).some((l) => notNear.test(l));
}

/** Match the evidence patterns against a set of lines, reporting whether the cap cut it short. */
function scanLines(cwd: string, lines: AddedLine[]): { gaps: VerifyGap[]; capped: boolean } {
    const gaps: VerifyGap[] = [];
    let capped = false;
    const cache = new Map<string, string[]>();
    for (const entry of lines) {
        if (DOC_EXT.has(extname(entry.file).toLowerCase())) continue;
        if (IGNORE_RE.test(entry.text)) continue;
        for (const pattern of INCOMPLETE_PATTERNS) {
            if (!pattern.re.test(entry.text)) continue;
            if (pattern.notNear && suppressedByContext(cwd, entry.file, entry.line, pattern.notNear, cache)) break;
            gaps.push({ kind: "marker", file: entry.file, line: entry.line, detail: `${pattern.label}: ${entry.text.trim().slice(0, 160)}` });
            break;
        }
        // Say when the list was cut short: shown-is-all would let the model fix everything it
        // was given and still be blocked next turn by findings it was never told about.
        if (gaps.length >= MAX_GAPS) { capped = true; break; }
    }
    return { gaps, capped };
}

/** Evidence of unfinished work in the code this change produced, with the scan's coverage. */
function scanEvidence(cwd: string, all: boolean): VerifyScan {
    const scanned = all ? trackedLines(cwd) : addedLines(cwd);
    const { gaps, capped } = scanLines(cwd, scanned.lines);
    return { gaps, truncated: scanned.truncated, capped, noRepo: scanned.noRepo, scanned: scanned.lines.length };
}

/** Evidence of unfinished work in the code this change produced. */
export function scanGaps(cwd: string, all = false): VerifyGap[] {
    return scanEvidence(cwd, all).gaps;
}

/**
 * Run the project's own verification command and report a gap when it fails. Read from
 * the GLOBAL config only: a repo-local .enigma.json travels with a clone, so honouring
 * one here would let a cloned repository execute a command on the machine that runs it.
 */
export function runVerifyCommand(cwd: string, command: string): VerifyGap | null {
    // A real test suite is verbose, and Node's 1 MiB default output buffer would kill a
    // PASSING one and report it as a failure - a false block, which is how a gate like this
    // gets switched off. result.error separates "could not run it" from "it failed".
    const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim().slice(-1500);
    // A timeout also arrives as result.error, so it has to be told apart from "no such command"
    // first - otherwise someone with a merely slow test suite is sent looking for a typo.
    if (result.error) {
        const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" || result.signal !== null;
        const detail = timedOut
            ? `the project's verification command \`${command}\` did not finish within ${Math.round(TIMEOUT_MS / 1000)}s\n${output}`
            : `could not run the verification command \`${command}\`: ${result.error.message}`;
        return { kind: "command", detail };
    }
    if (result.status === 0) return null;
    return { kind: "command", detail: `the project's verification command \`${command}\` exited ${result.status}\n${output}` };
}

/** The configured verification command, or "" when none is set. */
export function verifyCommandOf(): string {
    return (readGlobalConfig().verifyCommand || "").trim();
}

/** The result of a full check: what it found, and whether it managed to look everywhere. */
export interface VerifyScan {
    gaps: VerifyGap[];
    /** A cap stopped the scan before it had read everything. */
    truncated: boolean;
    /** There were more findings than the report shows. */
    capped: boolean;
    /** There was no repository to read a change from, so nothing could be checked. */
    noRepo?: boolean;
    /** How many lines the scan actually examined. */
    scanned: number;
}

/**
 * All evidence: incompleteness markers, plus the verification command when configured.
 * `truncated` and `noRepo` report that the scan could not see everything (or anything), so a
 * partial pass is never presented as a clean one.
 *
 * The verification command runs only when the change produced something. A turn that merely
 * answered a question must not pay for a five-minute test suite, and - worse - must not be
 * blocked by a suite that was already red for reasons it had nothing to do with.
 */
export function collectGaps(cwd: string, opts: { all?: boolean; runCommand?: boolean } = {}): VerifyScan {
    const scan = scanEvidence(cwd, opts.all === true);
    const command = opts.runCommand === false || scan.scanned === 0 ? "" : verifyCommandOf();
    if (command) {
        const failure = runVerifyCommand(cwd, command);
        if (failure) scan.gaps.push(failure);
    }
    return scan;
}

/** Format evidence as a compact, model-facing list. */
export function formatGaps(gaps: VerifyGap[]): string {
    return gaps.map((g) => (g.file ? `- ${g.file}:${g.line} ${g.detail}` : `- ${g.detail}`)).join("\n");
}

// --- turn-end gate -------------------------------------------------------------------

/** Where the block counter lives (loop safety across hook invocations). */
function stateDir(): string {
    // enigmaHome() is the HOME directory, not ~/.enigma - the global config file is
    // ~/.enigma.json. Every other state file lives under ~/.enigma/, and joining without it
    // dropped verify-state.json straight into the user's home.
    return join(enigmaHome(), ".enigma");
}

function statePath(): string {
    return join(stateDir(), "verify-state.json");
}

/**
 * A stable identity for one set of findings, so the loop-safety budget is spent per PROBLEM
 * rather than per turn.
 *
 * Keying the budget on the turn was wrong: the payload's prompt id is not guaranteed, and
 * falling back to the session id meant two blocks anywhere in a session silenced the gate for
 * the rest of it, however many further false claims followed. Keyed by the evidence, a repeat
 * of the same unresolved findings is capped - which is the only thing a loop can be - while
 * a genuinely new problem always gets a fresh budget.
 */
function issueKey(session: string, gaps: VerifyGap[]): string {
    // The line number is deliberately excluded: editing anything above an untouched marker
    // moves it, and including the line would hand the same unfixed finding a fresh budget
    // every time, which is a loop with extra steps.
    const identity = gaps.map((g) => `${g.file || ""}:${g.detail.slice(0, 80)}`).sort().join("|");
    return `${session}:${createHash("sha1").update(identity).digest("hex").slice(0, 12)}`;
}

/**
 * Count this block against `key` and report whether the gate may still fire. Capped so a
 * model that cannot satisfy the gate is never trapped in an endless stop/continue loop.
 */
function mayBlock(key: string): boolean {
    const path = statePath();
    const state = readJson<Record<string, number>>(path) || {};
    const count = (state[key] || 0) + 1;
    if (count > MAX_BLOCKS_PER_ISSUE) return false;
    state[key] = count;
    // Keep the file bounded; the newest entries are the only ones a live turn can hit.
    const keys = Object.keys(state);
    for (const stale of keys.slice(0, Math.max(0, keys.length - 50))) delete state[stale];
    try {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(path, `${JSON.stringify(state)}\n`);
    } catch { /* a read-only home must not break the gate */ }
    return true;
}

/**
 * The message fed back to the model when a completion claim is contradicted by evidence.
 * Deliberately framed at maximum stakes: the whole point of this gate is that a false
 * "done" is a worse outcome than an honest "unfinished", and the model must feel that.
 */
function blockMessage(gaps: VerifyGap[], incomplete: { truncated?: boolean; capped?: boolean } = {}): string {
    const caveat = incomplete.capped
        ? "(Only the first findings are listed - there are more than these.)"
        : incomplete.truncated ? "(The change was too large to scan in full, so there may be more than this.)" : "";
    return [
        "enigma verify: STOP. You just reported this work as finished, but a deterministic check of what you actually produced contradicts that claim:",
        "",
        formatGaps(gaps),
        ...(caveat ? ["", caveat] : []),
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
    // open is exactly the silent pass it exists to prevent - so an unreadable payload says so
    // rather than returning quietly, like every other degraded path here.
    try { raw = JSON.parse((payload ?? readFileSync(0, "utf8")).replace(/^\uFEFF/, "")) || {}; }
    catch {
        process.stderr.write("enigma verify: the turn-end payload could not be read, so the completion check did not run.\n");
        return 0;
    }
    // NOTE: `stop_hook_active` is deliberately NOT honoured. It stays true for every stop that
    // happens while a turn continues because of a stop hook, so returning early on it capped the
    // gate at one block per prompt - and an agent could clear it by simply repeating "all done"
    // with nothing changed, which is precisely the behaviour being gated. Loop safety comes from
    // the evidence-keyed budget below instead, which bounds repeats without excusing them.
    const cwd = typeof raw.cwd === "string" && existsSync(raw.cwd) ? raw.cwd : process.cwd();
    if (!readConfigAt(cwd).verify) return 0;

    // The whole gate hangs off the final message, so losing it must be loud rather than a
    // permanent silent no-op that reads exactly like "nothing to report".
    let message = typeof raw.last_assistant_message === "string" ? raw.last_assistant_message : "";
    if (!message && typeof raw.transcript_path === "string") message = lastAssistantMessage(raw.transcript_path);
    if (!message) {
        process.stderr.write("enigma verify: the turn-end payload carried no final assistant message and none could be read from the transcript, so the completion check did not run.\n");
        return 0;
    }
    if (!claimsDone(message)) return 0;

    const { gaps, truncated, capped, noRepo } = collectGaps(cwd);
    if (!gaps.length) {
        if (noRepo) process.stderr.write("enigma verify: this directory is not a git repository, so there was no change to check this claim against.\n");
        else if (truncated) process.stderr.write("enigma verify: the change was too large to scan in full, so this claim was only partially checked.\n");
        return 0;
    }

    const session = String(raw.session_id || raw.prompt_id || "session");
    if (!mayBlock(issueKey(session, gaps))) return 0;
    process.stderr.write(`${blockMessage(gaps, { truncated, capped })}\n`);
    return 2;
}
