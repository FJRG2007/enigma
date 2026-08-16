/**
 * The code graph riding along in a session: the hook runtime behind `enigma __codegraph-hook`.
 *
 * Registering the MCP tools makes the graph AVAILABLE; these hooks make it ARRIVE. Four events,
 * each answering a question the agent would otherwise spend tool calls rediscovering:
 *
 *   session-start  the repo's shape, once, so a new session does not start blind
 *   prompt         the nodes this task touches, as locators
 *   post-edit      what depends on the file just written - the blast radius, before it breaks
 *   stop           refresh the graph in the background when the turn changed code
 *
 * Two budget rules shape everything here, and both are the difference between help and noise:
 *
 * 1. PER-PROMPT INJECTION IS FULL-PRICE, EVERY TURN. The session-start block is written once and
 *    rides the prompt cache; a per-prompt block is fresh input on every single turn. So the prompt
 *    hook emits LOCATORS ONLY - never inlined source - and the agent pulls the span itself when a
 *    pointer looks right. Inlining there would spend thousands of tokens a turn to save a read
 *    that may never happen.
 * 2. A HOOK THAT FIRES ON EVERY PROMPT MUST STAY SILENT MOST OF THE TIME. A pack that is emitted
 *    regardless of whether it matches teaches the agent to ignore the channel. So: short prompts
 *    are skipped, a weak match is dropped, and a pointer already injected this session is never
 *    injected again.
 *
 * A hook must never break the session it rides in: every path here fails soft and exits 0.
 */

import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** Prompts shorter than this ("ok", "continue", "fix it") carry nothing to retrieve on. */
const MIN_PROMPT_CHARS = 12;

/** Locators injected per prompt. Three is enough to point; more reads as a dump. */
const PROMPT_HITS = 3;

/**
 * Two floors, and a pack is injected when the top hit clears EITHER.
 *
 * They measure different evidence. `coverageStrong` is the share of the query matched in the
 * hit's NAME - precise, and the signal a wordy question relies on. `coverage` is the share matched
 * anywhere - broader, and what a question phrased in the codebase's own vocabulary scores on. A
 * single floor fails one shape or the other: measured on this repo, "where is drift between the
 * graph and the working tree detected" scores 0.32 broad but resolves perfectly, while "how are
 * guardrail rules loaded" scores 0.54 broad on a 0.21 name match. Conversational prompts
 * ("thanks, continue", "what about the weather") topped out at 0.19 on BOTH.
 *
 * Tuned on six probes against one repo, so treat them as a starting point rather than a result;
 * the chatter margin on the strong floor is the thinner of the two.
 */
const STRONG_FLOOR = 0.25;
const BROAD_FLOOR = 0.40;

/** Pointers remembered per session, so a long session cannot grow its dedup list without bound. */
const INJECTED_CAP = 60;

/** Blast-radius dependents listed after an edit. Past this it stops being a warning and is a list. */
const BLAST_CAP = 12;

interface HookInput {
    prompt?: string;
    cwd?: string;
    session_id?: string;
    tool_input?: { file_path?: string; };
}

interface SessionState { injected: string[]; dirty: boolean; }

/**
 * The payload is read by the CALLER, synchronously, before any `await` - see cli.ts. An await lets
 * Node's stdin machinery drain the pipe, and a hook that then reads fd 0 gets an empty string and
 * silently does nothing. So this only parses.
 */
function parsePayload(raw: string): HookInput {
    try { return JSON.parse(raw) as HookInput; } catch { return {}; }
}

/** The project a hook is speaking about. The host states it; cwd is the fallback. */
function projectDir(input: HookInput): string {
    return resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
}

/**
 * The one output shape a host reads back as context. Anything else printed to stdout is either
 * ignored or shown as noise, so every emission goes through here.
 */
function emit(event: string, additionalContext: string): void {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}

// --- per-session state ---------------------------------------------------------------

function stateDir(): string {
    return join(process.env.ENIGMA_CODEGRAPH_DIR || join(homedir(), ".enigma", "codegraph"), "sessions");
}

function stateFile(dir: string, sessionId: string): string {
    const key = `${dir}|${sessionId}`.replace(/[^A-Za-z0-9]/g, "").slice(-40) || "default";
    return join(stateDir(), `${key}.json`);
}

function readState(dir: string, sessionId: string): SessionState {
    try {
        const parsed = JSON.parse(readFileSync(stateFile(dir, sessionId), "utf8")) as Partial<SessionState>;
        return { injected: Array.isArray(parsed.injected) ? parsed.injected : [], dirty: parsed.dirty === true };
    } catch { return { injected: [], dirty: false }; }
}

function writeState(dir: string, sessionId: string, state: SessionState): void {
    try {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(stateFile(dir, sessionId), JSON.stringify({ injected: state.injected.slice(-INJECTED_CAP), dirty: state.dirty }));
    } catch { /* best-effort: losing session state costs a duplicate injection, never correctness */ }
}

/**
 * Leave the two numbers the status line shows behind in a file.
 *
 * The status line is a Node script and the engine is compiled into the Bun binary, so it can never
 * call this code - exactly the split the gate snapshot exists for. A hook that has already run the
 * engine is the cheapest place to record them.
 */
function writeStatuslineSnapshot(root: string, symbols: number, stale: number): void {
    try {
        const dir = process.env.ENIGMA_CODEGRAPH_DIR || join(homedir(), ".enigma", "codegraph");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "statusline.json"), JSON.stringify({ root, symbols, stale }));
    } catch { /* best-effort: a missing snapshot just hides the segment */ }
}

// --- handlers ------------------------------------------------------------------------

/**
 * The orientation block, written once per session and carried by the prompt cache from then on.
 *
 * It names the tools as well as the map. A tool the agent is never told about is a tool it does
 * not call, and this is the one channel that fires every session regardless of which skill loads.
 */
async function sessionStart(dir: string): Promise<void> {
    const q = await import("./codegraph-query");
    const fmt = await import("./codegraph-format");
    const cg = await import("./codegraph");
    let project: string;
    try { project = cg.ensureProjectForCwd(dir); } catch { return; }

    const directive = [
        "[enigma] This repo is indexed as a code graph. To find, understand or change code, ask the graph before grepping - it answers from a prebuilt index with exact file:line. Pick the ONE tool that fits and act on its answer; most tasks need a single call.",
        "  - enigma_codegraph_ask: where a task's code lives, ranked, with the source inlined. The default for \"how does X work\" / \"where is Y\".",
        "  - enigma_codegraph_trace: exact edges. Who calls a symbol, or what it calls with direction out. Run it BEFORE changing anything shared.",
        "  - enigma_codegraph_skeleton: a file's whole API surface, no bodies.",
        "  - enigma_codegraph_grep: every occurrence, grouped by enclosing symbol - when you need them ALL, not the top matches.",
    ].join("\n");

    const map = q.codeGraphMap({ project, refresh: false, maxDirs: 8 });
    const fresh = q.codeGraphCheck(project);
    const stale = fresh && fresh.stale > 0 ? `\n${fresh.stale} file(s) changed since the last index; the next query refreshes them.` : "";
    writeStatuslineSnapshot(dir, map?.totals.symbols ?? 0, fresh?.stale ?? 0);
    emit("SessionStart", map ? `${directive}\n\n${fmt.formatMap(map).trimEnd()}${stale}` : directive);
}

/**
 * Locators for the task in the prompt.
 *
 * Silence is the common case by design: a prompt too short to retrieve on, a match too weak to
 * trust, or a set of pointers this session has already been given all emit nothing. What survives
 * is small and new.
 */
/**
 * The project covering `dir`, or null after starting a background index for it.
 *
 * The three hooks on a 10 s budget must never index inline. A cold index is seconds of work - 16 s
 * for this monorepo before the scan was scoped to what git owns, 3 s after - and the per-prompt
 * hook spends it between the user pressing enter and the model seeing the turn. It does not
 * degrade gracefully either: the host kills the hook at its timeout and discards the output, so
 * the cost is paid on EVERY prompt and buys nothing. Session start is the one hook that may index
 * inline (once per session, on a 20 s budget); the rest hand the work to a detached process and
 * stay silent until it lands.
 */
function coveringProject(cg: typeof import("./codegraph"), dir: string): string | null {
    const project = cg.findProjectForCwd(dir);
    if (project) return project;
    backgroundIndex(dir);
    return null;
}

/** Index `dir` without waiting for it. Best-effort: the next query refreshes anyway. */
function backgroundIndex(dir: string): void {
    try {
        const child = spawn(process.execPath, [process.argv[1], "codegraph", "index", dir], { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
    } catch { /* nothing to do about it here, and a hook must never fail the turn */ }
}

async function prompt(input: HookInput, dir: string): Promise<void> {
    const text = String(input.prompt ?? "").trim();
    if (text.length < MIN_PROMPT_CHARS) return;
    const q = await import("./codegraph-query");
    const cg = await import("./codegraph");
    const project = coveringProject(cg, dir);
    if (!project) return;

    const answer = q.codeGraphAsk(text, { project, limit: PROMPT_HITS * 2 });
    if (!answer || !answer.hits.length) return;
    // A lexical answer whose top hit barely overlaps the question is a coincidence, not a lead.
    // A structural answer ("who calls X") came from edges, so it needs no lexical gate.
    if (answer.mode === "lexical" && (answer.coverageStrong ?? 0) < STRONG_FLOOR && (answer.coverage ?? 0) < BROAD_FLOOR) return;

    const state = readState(dir, input.session_id ?? "default");
    const seen = new Set(state.injected);
    const pointer = (h: { path: string; line: number; }): string => `${h.path}:${h.line}`;
    const fresh = answer.hits.filter((h) => !seen.has(pointer(h))).slice(0, PROMPT_HITS);
    if (!fresh.length) return;

    const lines = fresh.map((h) => `  - ${h.name} (${h.symbolKind}) ${h.path}:${h.line}-${h.endLine}`);
    emit("UserPromptSubmit", `[enigma] Code graph - nodes this task touches (locators; read or ask for the source as needed):\n${lines.join("\n")}`);
    state.injected = [...state.injected, ...fresh.map(pointer)];
    writeState(dir, input.session_id ?? "default", state);
}

/**
 * What depends on the file just written.
 *
 * Timed to be useful: after the edit lands, while the agent is still on that file and can widen
 * the change, rather than after tests fail. Nothing is emitted when nothing depends on it - the
 * common case for a leaf file, and silence is the correct answer there.
 */
async function postEdit(input: HookInput, dir: string): Promise<void> {
    const file = input.tool_input?.file_path;
    if (!file) return;
    const q = await import("./codegraph-query");
    const cg = await import("./codegraph");
    const project = coveringProject(cg, dir);
    if (!project) return;

    const state = readState(dir, input.session_id ?? "default");
    state.dirty = true;
    writeState(dir, input.session_id ?? "default", state);

    const rel = relative(dir, resolve(file)).split("\\").join("/");
    if (!rel || rel.startsWith("..")) return;
    // `refresh: false` on purpose: the edit is milliseconds old and re-indexing the whole tree on
    // every write would make editing progressively slower. The Stop hook syncs once per turn.
    const trace = q.codeGraphTrace(rel, { project, refresh: false, depth: 1 });
    if (!trace || !trace.hits.length) return;
    const shown = trace.hits.slice(0, BLAST_CAP);
    const more = trace.hits.length - shown.length;
    const lines = shown.map((h) => `  - ${h.name} (${h.kind}) ${h.path}:${h.line}`);
    emit("PostToolUse", `[enigma] Blast radius of ${basename(rel)} - ${trace.hits.length} dependent(s):\n${lines.join("\n")}${more > 0 ? `\n  ... +${more} more` : ""}`);
}

/**
 * Bring the graph back in step with the code, once, at the end of a turn that changed something.
 *
 * Detached so the turn never waits on it, and only when this session actually edited a file:
 * re-indexing after a turn that only read code would be pure cost.
 */
async function stop(input: HookInput, dir: string): Promise<void> {
    const sessionId = input.session_id ?? "default";
    const state = readState(dir, sessionId);
    if (!state.dirty) return;
    writeState(dir, sessionId, { ...state, dirty: false });
    try {
        const q = await import("./codegraph-query");
        const cg = await import("./codegraph");
        const project = cg.findProjectForCwd(dir);
        if (!project) throw new Error("not indexed yet");
        const fresh = q.codeGraphCheck(project);
        const map = q.codeGraphMap({ project, refresh: false });
        writeStatuslineSnapshot(dir, map?.totals.symbols ?? 0, fresh?.stale ?? 0);
    } catch { /* the snapshot is cosmetic; the re-index below is the real work */ }
    backgroundIndex(dir);
}

/**
 * Hook entry. Every event fails soft: a hook that throws would break the session it rides in, and
 * the graph is an accelerator - never a dependency of the turn succeeding.
 */
export async function runCodeGraphHook(event: string, payload: string): Promise<number> {
    try {
        const { readConfig } = await import("./config");
        if (!readConfig().config.codeGraph) return 0;
        const input = parsePayload(payload);
        const dir = projectDir(input);
        if (!existsSync(dir)) return 0;
        if (event === "session-start") await sessionStart(dir);
        else if (event === "prompt") await prompt(input, dir);
        else if (event === "post-edit") await postEdit(input, dir);
        else if (event === "stop") await stop(input, dir);
    } catch { /* never break the session */ }
    return 0;
}
