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
 * (lines added since the branch left the default branch, plus untracked files) and, when
 * configured, run the project's own verification command. Evidence against a claim exits 2,
 * which feeds the findings back and denies the stop, so the model must either finish the work
 * or state what is missing.
 *
 * The same failure has a second face, and this gate catches that one too: a turn that ends by
 * ASKING whether to continue - "shall I go on with the rest?", "in this order or another?" -
 * when the user already asked for all of it. Nothing is missing from the code there; the work
 * simply stopped, and the user has to spend a turn saying "yes" to a question with only one
 * answer. That one needs no diff at all: the message announces it.
 *
 * Cost model: both checks are regexes over one string, so a turn that neither claims nor asks
 * costs nothing, and a turn that does claim pays one git diff. No model tokens are spent
 * unless the gate actually fires, and then only on the findings.
 *
 * Precision over recall throughout: a false block would train the user to switch this
 * off, so every pattern matches only unambiguous evidence, documents legitimately
 * tracking TODOs are excluded, and a line carrying `enigma:verify-ignore` is skipped.
 */

import { createHash } from "node:crypto";
import { join, extname } from "node:path";
import { readConfigAt, readGlobalConfig } from "./config";
import { lastAssistantMessage } from "./claude-transcripts";
import { execFileSync, spawnSync } from "node:child_process";
import { enigmaHome, readJson, isGateAgentRun } from "./util";
import { checkFile, findProjectRoot, recordFindings, type Finding } from "./guardrails";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";

/** One piece of evidence that the work is not finished. */
export interface VerifyGap {
    /**
     * `marker` = an incompleteness marker in produced code; `command` = the project's check
     * failed; `stop-short` = the turn ended asking permission to continue instead of continuing;
     * `convention` = a guardrail rule the produced code breaks (see scanConventions).
     */
    kind: "marker" | "command" | "stop-short" | "convention";
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

/** Absolute ceiling per session, so an ever-changing finding set cannot cycle forever. */
const MAX_BLOCKS_PER_SESSION = 10;

/**
 * Evidence patterns. Each matches only an unambiguous "this is not finished" signal.
 * `notNear` suppresses a hit when the preceding lines show it is a legitimate idiom
 * (a Python abstract method raises the unimplemented error by design, for example).
 */
const INCOMPLETE_PATTERNS: Array<{ id: string; re: RegExp; label: string; notNear?: RegExp; }> = [
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

// --- stop-short detection ------------------------------------------------------------

/**
 * Questions that hand assigned work back to the user instead of doing it: may I continue,
 * shall I move on to the next item, in this order or another one. They are the same failure
 * as a false completion claim seen from the other side - the turn ends with the work
 * unfinished - except that here the model announces it, so no diff is needed to catch it.
 *
 * Matched only inside a sentence that actually asks (it must carry a question mark), so a
 * progress note saying what comes next is never mistaken for a request for permission.
 */
const CONTINUE_ASK_RE = new RegExp([
    // English: offering to keep working rather than keeping working.
    "\\b(?:shall|should|can|may)\\s+i\\s+(?:\\w+\\s+){0,3}?(?:continue|proceed|carry\\s+on|keep\\s+going|go\\s+ahead|go\\s+on|move\\s+on|start\\s+(?:with|on)|begin\\s+with)\\b",
    "\\b(?:do\\s+you\\s+want|would\\s+you\\s+like|want)\\s+me\\s+to\\s+(?:\\w+\\s+){0,3}?(?:continue|proceed|carry\\s+on|keep\\s+going|go\\s+ahead|go\\s+on|move\\s+on)\\b",
    "\\b(?:ready|ok|okay|fine)\\s+for\\s+me\\s+to\\s+(?:continue|proceed|go\\s+ahead|keep\\s+going)\\b",
    // English: asking the user to sequence work that was already assigned.
    "\\bin\\s+(?:this|that|the\\s+same)\\s+order\\b[^?]*\\bor\\b",
    "\\b(?:which|what)\\s+order\\b",
    "\\bwhich\\s+(?:one|task|item)\\s+(?:first|should\\s+i)\\b",
    // Spanish - the exact phrasing this gate was reported for ("¿Sigo con las tareas 5-8...?").
    "(?:^|[¿\\s])(?:sigo|continúo|continuo|prosigo|procedo|avanzo|empiezo|arranco)\\b",
    "\\b(?:quieres|querés|prefieres|preferís|te\\s+parece(?:\\s+bien)?)\\s+que\\s+(?:\\w+\\s+){0,3}?(?:siga|sigo|continúe|continue|prosiga|proceda|empiece|avance)\\b",
    "\\ben\\s+(?:este|ese|el\\s+mismo)\\s+orden\\b",
    "\\ben\\s+qué\\s+orden\\b",
    "\\bprefieres\\s+otro\\b",
].join("|"), "i");

/**
 * Reasons a turn may legitimately stop and ask, per the completion policy: access the agent
 * does not have, an irreversible or destructive action, a decision that is genuinely the
 * user's, a gate finding that must be escalated verbatim, or a check-in the user asked for.
 *
 * Matched over the WHOLE message and kept deliberately broad, because the asymmetry runs the
 * other way here: a missed stop-short costs one nagging question, while a false block on a
 * question that HAD to be asked is how a gate gets switched off. It also doubles as the way
 * out - an agent blocked over a genuine blocker only has to name the blocker to pass.
 */
const LEGITIMATE_STOP_RE = new RegExp([
    // Access or credentials the agent cannot obtain by itself.
    "\\b(?:credentials?|api\\s+key|access\\s+token|password|secret|log\\s?in|sign\\s?in|authenticate|authorization|2fa|otp|no\\s+access|don'?t\\s+have\\s+access|do\\s+not\\s+have\\s+access|permission\\s+to\\s+access)\\b",
    "\\b(?:credencial(?:es)?|contraseña|clave|token|no\\s+tengo\\s+acceso|sin\\s+acceso|iniciar\\s+sesión|autenticar|permisos?)\\b",
    // Irreversible or destructive actions, which always need a human yes.
    "\\b(?:force[-\\s]push|reset\\s+--hard|rebase|drop\\s+(?:the\\s+)?(?:table|database|schema)|delete|remove\\s+permanently|overwrite|truncate|wipe|deploy|publish|release|production|prod|irreversible|destructive|rollback)\\b",
    "\\b(?:borrar|eliminar|sobrescribir|forzar|producción|desplegar|publicar|irreversible|destructiv[oa])\\b",
    // Decisions that are the user's to make, not judgment calls.
    "\\b(?:business\\s+decision|product\\s+decision|breaking\\s+change|pricing|billing|cost|budget|which\\s+account|legal|compliance|your\\s+call|up\\s+to\\s+you)\\b",
    "\\b(?:decisión\\s+de\\s+negocio|cambio\\s+incompatible|factura(?:ción)?|coste|presupuesto|qué\\s+cuenta|tú\\s+decides)\\b",
    // A gate run must escalate its ask-user findings verbatim, and a plan is meant to be approved.
    "\\bask-user\\b|\\benigma\\s+gate\\b",
    "\\b(?:approve|approval|sign\\s+off|confirm)\\b[^?]*\\bplan\\b|\\bplan\\b[^?]*\\b(?:approve|approval|sounds?\\s+good|looks?\\s+(?:good|right))\\b",
    "\\b(?:apruebas|apruebo|aprobar)\\b[^?]*\\bplan\\b|\\bplan\\b[^?]*\\b(?:apruebas|te\\s+parece)\\b",
    // The user explicitly asked to be checked in with - saying so is the documented way out.
    "\\b(?:as\\s+(?:you\\s+)?(?:asked|requested|instructed)|you\\s+asked\\s+me\\s+to\\s+(?:check|confirm|ask|stop))\\b",
    "\\b(?:como\\s+(?:me\\s+)?pediste|me\\s+pediste\\s+que\\s+(?:preguntara|confirmara|parara))\\b",
    // Same escape hatch as the code scan, for a question a repository considers legitimate.
    "enigma:verify-ignore",
].join("|"), "i");

/**
 * Whether the final message ends the turn by asking permission to continue work that was
 * already assigned, without naming a reason that makes stopping legitimate.
 *
 * Returns the question itself (trimmed) so the block can quote it back, or "" for a message
 * that is free to end the turn.
 */
export function asksToContinue(message: string): string {
    if (!message || typeof message !== "string") return "";
    if (LEGITIMATE_STOP_RE.test(message)) return "";
    for (const sentence of message.split(/(?<=[.!?\n])\s+/)) {
        if (!sentence.includes("?")) continue;
        if (CONTINUE_ASK_RE.test(sentence)) return sentence.trim().slice(0, 200);
    }
    return "";
}

/**
 * The message fed back when a turn stops to ask whether to continue. It answers the question
 * (the answer is always yes) and points at the only exit: name a real blocker instead.
 */
function stopShortMessage(question: string): string {
    return [
        "enigma verify: STOP. You are ending the turn by asking whether - or in which order - to continue with work you were already asked to do:",
        "",
        `  "${question}"`,
        "",
        "The answer is yes. It is always yes. Do not ask it: sequencing, ordering and priority among items the user already asked for are routine judgment calls that are yours to make, and a question about them turns finished work into a wait.",
        "Continue now, in this same turn: pick the most sensible order yourself, work through every remaining item, verify each one actually works, and only then report - completely, honestly, and with what you could not verify named explicitly.",
        "The only reasons to stop and ask are a genuine blocker: access or credentials you do not have, an irreversible or destructive action, or a decision that is genuinely the user's (business, legal, cost). If that is what this is, say so plainly - name the blocker, why it blocks you, and everything you finished before hitting it - instead of asking for permission to keep going.",
    ].join("\n");
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

/** Whether the repository has any commit yet - a fresh one has no HEAD to diff against. */
function hasCommits(cwd: string): boolean {
    return gitTry(cwd, ["rev-parse", "--verify", "HEAD"]) !== null;
}

/**
 * Run git in `cwd`. Returns null when the command FAILED, which an empty string cannot
 * express: a diff too large for the buffer throws, and reading that as "no changes" would
 * report a clean pass over work nobody looked at.
 */
function gitTry(cwd: string, args: string[]): string | null {
    try { return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); }
    catch { return null; }
}

/** Run git in `cwd`, treating failure as empty output (for probes where that is the answer). */
function gitOut(cwd: string, args: string[]): string {
    return gitTry(cwd, args) ?? "";
}

/**
 * Where this branch left the default branch, so the work it has already committed counts as
 * evidence. Returns null when nothing resolves - a detached HEAD, no remote, a repository
 * with no commits - and the caller then falls back to the working tree alone rather than
 * failing: this runs inside a turn-end hook and must never break the turn.
 */
function branchPoint(cwd: string): string | null {
    const refs: string[] = [];
    // NOT the branch's own upstream. Tried, and it silently defeated the whole point: after
    // `git push -u`, the upstream IS this branch, so the merge-base equals HEAD and the scan
    // collapses to the working tree - losing every committed change, which is the hole this
    // exists to close. The integration branch is what matters, so the remote's default head
    // leads. On a develop-style flow without origin/HEAD the fallbacks can pick an older base
    // and over-attribute; that is the lesser evil, because it is visible and answerable,
    // whereas a silent pass is the failure this whole module exists to prevent.
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
        // git appends a TAB (and timestamp) to the header when the path contains a space, and
        // keeping it produces a path that does not exist - so findings point nowhere and the
        // idiom exemption, which has to read the file, silently stops working.
        if (raw.startsWith("+++ ") && previous.startsWith("--- ")) { file = raw.slice(4).replace(/\t.*$/, "").replace(/^b\//, ""); previous = raw; continue; }
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
    // quotepath off here as well as on the listings: git escapes a non-ASCII path in the diff
    // header too, and the escaped form neither matches a real file nor can be opened by the
    // idiom exemption - so findings point nowhere and the exemption quietly stops applying.
    const base = branchPoint(cwd);
    const diff = gitTry(cwd, ["-c", "core.quotepath=false", "diff", "--unified=0", "--no-color", base || "HEAD"]);
    // Before the first commit there is no HEAD to diff against, and that is not incomplete
    // coverage: every file is untracked and read in full below. Only a real failure counts.
    if (diff === null && hasCommits(cwd)) truncated = true;
    else if (diff !== null) eachAddedLine(diff, add);
    const untracked = gitTry(cwd, ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"]);
    if (untracked === null) truncated = true;
    for (const path of (untracked ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) {
        if (!readInto(cwd, path, add, () => { truncated = true; })) break;
    }
    return { lines, truncated };
}

/**
 * Whether there is anything new to verify since the command last ran here: an uncommitted
 * change, or a commit made since the last run.
 *
 * Dirtiness alone was not enough - it skipped the command exactly when the agent had committed
 * its work, which is the flow enigma prescribes. The branch's line count was not enough either
 * - on a branch with earlier commits it is always positive, so every conversational turn paid
 * for the suite. "Has anything moved since we last checked" is the question that was actually
 * being asked.
 */
function hasNewWork(cwd: string): boolean {
    const status = gitTry(cwd, ["status", "--porcelain"]);
    // A failed status counts as new work: better to run the check than to skip it silently.
    if (status === null || status.trim() !== "") return true;
    const head = gitOut(cwd, ["rev-parse", "HEAD"]).trim();
    return head !== "" && head !== lastVerifiedHead(cwd);
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
    const tracked = gitTry(cwd, ["-c", "core.quotepath=false", "ls-files"]);
    if (tracked === null) truncated = true;
    for (const path of (tracked ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) {
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
function scanLines(cwd: string, lines: AddedLine[]): { gaps: VerifyGap[]; capped: boolean; } {
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
    return { gaps, truncated: scanned.truncated, capped, noRepo: scanned.noRepo, scanned: scanned.lines.length, ranCommand: false };
}

/** Evidence of unfinished work in the code this change produced. */
export function scanGaps(cwd: string, all = false): VerifyGap[] {
    return scanEvidence(cwd, all).gaps;
}

// --- conventions: the rules the produced code breaks -----------------------------------
//
// WHY THIS IS HERE AND NOT ONLY IN THE POST-EDIT HOOK. The guardrails engine runs per edit over a
// WHOLE file, which forces every rule to be precise enough that a repository's existing code never
// fires it - and a convention whose defect is already common (a mutation that waits for the server
// before touching the UI, measured in 116 of 140 mutating UI files) cannot meet that bar, so it
// simply had no gate at all. It also has no way to reach the model with a WARNING: a warn exits 0,
// which the hook prints to stdout and the model never sees, so a suggestion is a suggestion nobody
// receives.
//
// Running the same rules over the lines the change ADDED fixes both. There is no legacy backlog by
// construction, so a rule may be as demanding as the convention actually is, and the turn-end hook
// can deny the stop - which is the only channel that reaches the model at all. The cost is one
// diff per turn that produced code, and nothing when it produced none.

/** How many files one sweep will open, so a large branch cannot stall the end of a turn. */
const MAX_CONVENTION_FILES = 200;

/** A convention sweep: the gaps to report, and the findings behind them for the ledger. */
export interface ConventionScan {
    /** Blocking violations: these deny the stop. */
    gaps: VerifyGap[];
    /** Advisory findings, carried along when a block already fires - a warn never denies a stop. */
    notes: VerifyGap[];
    /** Everything found, for the ledger. */
    findings: Finding[];
}

/**
 * Guardrail violations on lines this change ADDED. Reported as gaps so they travel through the
 * same block, budget and message machinery as every other piece of evidence.
 *
 * Intersecting findings with the added lines is the ratchet the changed-line linter uses: a
 * violation that was already in the file is not this change's to answer for, and blocking on one
 * is how a gate gets switched off. A finding with no line (a whole-file budget, a project-level
 * check) is deliberately dropped here - it is not anchored to anything the change added, and the
 * post-edit hook already owns it.
 *
 * SEVERITY IS NOT REDEFINED HERE, deliberately. It would have been easy to let this channel deny
 * the stop over a warning too - the turn-end hook is the only one that can reach the model at all,
 * and every warn rule is otherwise printed into the void. But a warn is advisory BY DESIGN (use
 * fuse.js for that search box, consider AI Elements for that chat), and a gate that stops a turn
 * over advice is a gate that gets switched off, which costs the blocking rules too. So a warn
 * rides along in the message when something blocking already fired, and is always recorded in the
 * ledger - and a convention that genuinely must not be skipped is expressed the honest way, by
 * being a `block` rule. The diff stage is what makes that affordable: a demanding rule can only
 * fire on code the current change added.
 */
export function scanConventions(cwd: string, scanned?: ScannedLines): ConventionScan {
    const empty: ConventionScan = { gaps: [], notes: [], findings: [] };
    if (readConfigAt(cwd).guardrails === false) return empty;
    const lines = (scanned ?? addedLines(cwd)).lines;
    if (!lines.length) return empty;
    const added = new Map<string, Set<number>>();
    for (const entry of lines) {
        if (IGNORE_RE.test(entry.text)) continue;
        let set = added.get(entry.file);
        if (!set) { set = new Set(); added.set(entry.file, set); }
        set.add(entry.line);
    }
    const scan: ConventionScan = { gaps: [], notes: [], findings: [] };
    let files = 0;
    for (const [file, numbers] of added) {
        if (++files > MAX_CONVENTION_FILES) break;
        const text = readTextFile(join(cwd, file), MAX_UNTRACKED_BYTES);
        if (text === null) continue;
        let findings: Finding[];
        // The engine is deliberately self-contained and never throws for a bad rule, but a
        // hand-authored custom rule is still user input reaching a turn-end hook: a failure here
        // must cost the sweep, never the turn.
        try { findings = checkFile(file, text, findProjectRoot(join(cwd, file)), "diff"); }
        catch { continue; }
        for (const f of findings) {
            if (!f.line || !numbers.has(f.line)) continue;
            const gap: VerifyGap = { kind: "convention", file, line: f.line, detail: `${f.ruleId}: ${f.message}` };
            (f.severity === "block" ? scan.gaps : scan.notes).push(gap);
            scan.findings.push(f);
            if (scan.gaps.length + scan.notes.length >= MAX_GAPS) return scan;
        }
    }
    return scan;
}

/**
 * The message fed back when the produced code breaks a convention. It states the rule, and it
 * states the two ways out - fix it, or mark the line - because a gate with no exit is a gate that
 * gets disabled the first time it is wrong.
 */
function conventionMessage(gaps: VerifyGap[], notes: VerifyGap[] = []): string {
    return [
        "enigma verify: STOP. The code this change added breaks conventions this project enforces:",
        "",
        formatGaps(gaps),
        ...(notes.length ? ["", "Also flagged as suggestions on the same change (not blocking, worth doing while you are here):", formatGaps(notes)] : []),
        "",
        "These are not style preferences: each one is a rule that was written down because the defect kept shipping, and each was measured against real code before it was turned on. You wrote these lines in this turn, so they are yours to fix now - not in a follow-up, and not by mentioning them in your reply.",
        "Fix every finding above, then end the turn. If one of them is genuinely wrong for this code - the operation really does need the server's answer first, the design really does call for the other shape - mark that specific line with the escape hatch the rule names (an `enigma:` note) and say in your reply which one you marked and why. Silently leaving it is the one option that is not available.",
    ].join("\n");
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
    const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
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
    /** Whether the project's verification command was actually run. */
    ranCommand: boolean;
}

/**
 * All evidence: incompleteness markers, plus the verification command when configured.
 * `truncated` and `noRepo` report that the scan could not see everything (or anything), so a
 * partial pass is never presented as a clean one.
 *
 * The verification command runs only when the scan saw produced code AND something has moved
 * since it last passed here (see hasNewWork). A turn that merely answered a question must not
 * pay for a five-minute test suite, and - worse - must not be blocked by a suite that was
 * already red for reasons it had nothing to do with. The line count cannot decide that: it
 * covers the whole branch, so on any branch with earlier commits it is always positive and
 * every conversational turn would have paid.
 */
export function collectGaps(cwd: string, opts: { all?: boolean; runCommand?: boolean; conventions?: boolean; } = {}): VerifyScan {
    const scan = scanEvidence(cwd, opts.all === true);
    // The CLI asks for these; the hook runs the sweep itself, before the claim path, because a
    // broken convention has to be reported whether or not the turn claimed anything.
    if (opts.conventions) scan.gaps.push(...scanConventions(cwd).gaps);
    const produced = scan.scanned > 0 && (opts.all === true || hasNewWork(cwd));
    const command = opts.runCommand === false || !produced ? "" : verifyCommandOf();
    if (command) {
        const failure = runVerifyCommand(cwd, command);
        if (failure) scan.gaps.push(failure);
        else rememberVerifiedHead(cwd);
    }
    return { ...scan, ranCommand: Boolean(command) };
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
    // `session` must never be a shared constant: a payload with no session id would otherwise
    // put every project in one budget, where two blocks anywhere stand the gate down everywhere.
    // The line number is deliberately excluded: editing anything above an untouched marker
    // moves it, and including the line would hand the same unfixed finding a fresh budget
    // every time, which is a loop with extra steps.
    const identity = gaps.map((g) => `${g.file || ""}:${g.detail.slice(0, 80)}`).sort().join("|");
    return `${session}:${createHash("sha1").update(identity).digest("hex").slice(0, 12)}`;
}

/** The commit the verification command last passed on in `cwd`, or "" when it never has. */
function lastVerifiedHead(cwd: string): string {
    const state = readJson<Record<string, number | string>>(statePath()) || {};
    const value = state[`head:${cwd}`];
    return typeof value === "string" ? value : "";
}

/** Record the commit the verification command just passed on, so it is not re-run for it. */
function rememberVerifiedHead(cwd: string): void {
    const head = gitOut(cwd, ["rev-parse", "HEAD"]).trim();
    if (!head) return;
    const path = statePath();
    const state = readJson<Record<string, number | string>>(path) || {};
    state[`head:${cwd}`] = head;
    try {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(path, `${JSON.stringify(state)}\n`);
    } catch { /* a read-only home must not break the gate */ }
}

/**
 * Count this block against `key` and report whether the gate may still fire. Capped so a
 * model that cannot satisfy the gate is never trapped in an endless stop/continue loop:
 * per set of findings, and again by an absolute ceiling per session, because a model that
 * produces a slightly different finding set each round would otherwise earn a fresh budget
 * forever and the stop/continue cycle would never end.
 */
function mayBlock(key: string, session: string): boolean {
    const path = statePath();
    const state = readJson<Record<string, number>>(path) || {};
    const sessionKey = `total:${session}`;
    const total = (Number(state[sessionKey]) || 0) + 1;
    if (total > MAX_BLOCKS_PER_SESSION) return false;
    const count = (state[key] || 0) + 1;
    if (count > MAX_BLOCKS_PER_ISSUE) return false;
    state[sessionKey] = total;
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
function blockMessage(gaps: VerifyGap[], incomplete: { truncated?: boolean; capped?: boolean; } = {}): string {
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
    // A gate step agent answers with the structured JSON its step asked for, never with a
    // completion claim this gate could judge, so there is nothing here to check - and denying
    // its stop would only spend another agent turn inside a pipeline that already owns
    // review, test and lint. The pipeline's own steps are the completion gate there.
    if (isGateAgentRun()) return 0;
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
    const session = String(raw.session_id || raw.prompt_id || cwd);
    // Checked BEFORE the completion claim, and without reading git at all: a turn that reports
    // progress AND asks whether to continue passes the claim check (nothing it produced is
    // unfinished) and would end there, leaving the actual problem - the work it stopped short
    // of - unexamined. Planning is exempt, since a plan is meant to be approved before it runs.
    const question = raw.permission_mode === "plan" ? "" : asksToContinue(message);
    if (question) {
        const asked: VerifyGap = { kind: "stop-short", detail: question };
        if (!mayBlock(issueKey(session, [asked]), session)) return 0;
        process.stderr.write(`${stopShortMessage(question)}\n`);
        return 2;
    }
    // Conventions are checked whether or not the turn claims anything. A claim is what makes an
    // UNFINISHED item a lie, but a rule broken in the produced code is a defect on its own - and
    // this is the only channel that reaches the model with one, since the post-edit hook can print
    // a warning but never feed it back. Checked before the claim path so the concrete, fixable
    // finding is what the model gets first.
    const conventions = scanConventions(cwd);
    if (conventions.findings.length) {
        // Recorded either way, and that is the point of the ledger: a finding the loop-safety
        // budget stood down on - or one that was only ever advisory - is a rule the agent got away
        // with skipping, which is exactly what was previously invisible. mayBlock has a side
        // effect, so it is called once, and only when there is something blocking to spend it on.
        const blocking = conventions.gaps.length > 0 && mayBlock(issueKey(session, conventions.gaps), session);
        // Per FINDING, not per turn: an advisory finding that merely rode along in a blocking
        // message was never enforced, and recording it as "blocked" would overstate the one column
        // the ledger exists for - what the agent was actually stopped over.
        recordFindings(conventions.findings.filter((f) => f.severity === "block"), blocking ? "blocked" : "warned", "diff");
        recordFindings(conventions.findings.filter((f) => f.severity === "warn"), "warned", "diff");
        if (blocking) {
            process.stderr.write(`${conventionMessage(conventions.gaps, conventions.notes)}\n`);
            return 2;
        }
    }
    if (!claimsDone(message)) return 0;

    const { gaps, truncated, capped, noRepo } = collectGaps(cwd);
    if (!gaps.length) {
        if (noRepo) process.stderr.write("enigma verify: this directory is not a git repository, so there was no change to check this claim against.\n");
        else if (truncated) process.stderr.write("enigma verify: the change was too large to scan in full, so this claim was only partially checked.\n");
        return 0;
    }

    if (!mayBlock(issueKey(session, gaps), session)) return 0;
    process.stderr.write(`${blockMessage(gaps, { truncated, capped })}\n`);
    return 2;
}
