/**
 * Completion gate: claim detection, the evidence scan over what a change actually produced,
 * the turn-end hook's decision table (including its loop-safety cap), and port parity.
 *
 * Temp HOME + ENIGMA_CONFIG_HOME (set BEFORE import) isolate the global config and the
 * hook's block-counter state, so the test never reads or writes the real ~/.enigma.
 * A throwaway git repository per test supplies the diff the scan reads; nothing here
 * spawns an agent or touches the user's own repositories.
 */
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-verify-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
// The hook stands aside inside a gate step agent, so an ambient ENIGMA_GATE=1 (the suite run
// from inside an enigma gate pipeline) would make every case below pass open and fail here.
// The one test that exercises that path sets the variable itself.
delete process.env.ENIGMA_GATE;

const { claimsDone, asksToContinue, scanGaps, collectGaps, runVerifyHook } = await import("../src/verify");
const { parityReport, formatParity } = await import("../src/verify-parity");

const repos: string[] = [];
afterAll(() => {
    for (const dir of repos) rmSync(dir, { recursive: true, force: true });
    rmSync(HOME, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): void {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

/** A git repository whose only commit holds `committed`, so later writes read as the change. */
function repoWith(committed: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "enigma-verify-repo-"));
    repos.push(dir);
    const git = (...args: string[]): void => { execFileSync("git", args, { cwd: dir, stdio: "ignore" }); };
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("config", "commit.gpgsign", "false");
    write(dir, ".keep", "");
    for (const [path, content] of Object.entries(committed)) write(dir, path, content);
    git("add", "-A");
    git("commit", "-qm", "base");
    return dir;
}

function write(dir: string, path: string, content: string): void {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
}

test("recognises a completion claim in English and Spanish", () => {
    for (const message of [
        "All done - the port is finished.",
        "Everything is implemented and working.",
        "The migration is now complete.",
        "Ya está todo.",
        "Listo, no falta nada.",
        "Nothing is missing.",
    ]) expect(claimsDone(message)).toBe(true);
});

test("does not treat progress notes or honest reports as a claim", () => {
    for (const message of [
        "I added the parser; next I will wire the CLI.",
        "Done with the parser, but the exporter is still pending.",
        "The port is complete except for two modules I could not finish.",
        "He implementado el parser. Falta el exportador.",
        "Should I use Zod or valibot here?",
        "",
    ]) expect(claimsDone(message)).toBe(false);
});

test("recognises a turn that stops to ask whether to continue", () => {
    for (const message of [
        "Tasks 1-4 are done. Shall I continue with tasks 5-8 in this order, or do you prefer another?",
        "Do you want me to keep going with the rest?",
        "Should I move on to the remaining endpoints?",
        "Which order should I do them in?",
        "He terminado las tareas 1-4. ¿Sigo con las tareas 5-8 en este orden, o prefieres otro?",
        "¿Quieres que siga con el resto?",
        "¿Continúo con la migración?",
        "¿Por dónde empiezo?",
    ]) expect(asksToContinue(message)).not.toBe("");
});

test("leaves alone a question that genuinely needs the user", () => {
    for (const message of [
        // A blocker: the agent cannot get past it on its own.
        "I finished the client, but I need an API key for the staging environment. Can I continue once you provide it?",
        "¿Sigo? Necesito las credenciales de producción para el despliegue.",
        // An irreversible action always needs a human yes.
        "The rewrite is ready. Shall I proceed with the force-push to main?",
        "¿Procedo a borrar la tabla antigua?",
        // A decision that is the user's, not a judgment call.
        "Should I go ahead with the breaking change to the public API, or keep it backwards compatible?",
        // A plan is meant to be approved before it runs.
        "Here is the plan for the migration. Shall I proceed once you approve the plan?",
        // The user explicitly asked to be checked in with.
        "As you asked, checking in before the next batch - shall I continue?",
        // Ordinary work with no question at all.
        "I ported the parser and moved on to the exporter; continuing with the CLI next.",
        "Sigo con el exportador y después el CLI.",
        // A design question is not a request for permission to continue.
        "Should I use Zod or valibot here?",
        "",
    ]) expect(asksToContinue(message)).toBe("");
});

test("denies the stop when the turn asks permission to continue", () => {
    // No evidence in the code is needed or read: the message itself says the work stopped.
    const dir = repoWith();
    write(dir, "src/new.ts", "export const parse = (s: string): number => Number(s);\n");
    expect(runVerifyHook(payload(dir, "Tasks 1-4 are done. ¿Sigo con las tareas 5-8 en este orden, o prefieres otro?"))).toBe(2);
    // Planning is exempt - a plan is presented precisely so the user can approve it.
    expect(runVerifyHook(payload(dir, "¿Sigo con las tareas 5-8?", { permission_mode: "plan" }))).toBe(0);
    // Naming a real blocker is the way out, and it must work on the first try.
    expect(runVerifyHook(payload(dir, "I cannot continue without the deploy credentials. Shall I proceed once you add them?"))).toBe(0);
});

test("stands down after repeated asks so a turn is never trapped", () => {
    const dir = repoWith();
    const same = { session_id: "asking-session" };
    const question = "Done with the first half. Should I continue with the rest?";
    expect(runVerifyHook(payload(dir, question, same))).toBe(2);
    expect(runVerifyHook(payload(dir, question, same))).toBe(2);
    expect(runVerifyHook(payload(dir, question, same))).toBe(0);
});

test("flags incompleteness only in what the change produced", () => {
    // The committed file already carries a marker: pre-existing debt must never block a turn.
    const dir = repoWith({ "src/old.ts": "// TODO: rewrite this someday\nexport const a = 1;\n" }); // enigma:verify-ignore
    expect(scanGaps(dir)).toEqual([]);

    write(dir, "src/new.ts", "export function parse() {\n    // TODO: implement the real parser\n    return null;\n}\n"); // enigma:verify-ignore
    const gaps = scanGaps(dir);
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.file).toBe("src/new.ts");
    expect(gaps[0]!.line).toBe(2);
    expect(gaps[0]!.kind).toBe("marker");
});

test("flags an unimplemented code path in a modified file", () => {
    const dir = repoWith({ "src/api.ts": "export function run() {\n    return 1;\n}\n" });
    write(dir, "src/api.ts", "export function run() {\n    throw new Error(\"not implemented\");\n}\n"); // enigma:verify-ignore
    const gaps = scanGaps(dir);
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.detail).toContain("unimplemented code path");
});

test("ignores documents, ignore-marked lines, and abstract-method idioms", () => {
    const dir = repoWith();
    write(dir, "PLAN.md", "- TODO: write the docs\n"); // enigma:verify-ignore
    write(dir, "src/kept.ts", "const x = 1; // TODO: revisit - enigma:verify-ignore\n");
    write(dir, "src/base.py", "class Base(ABC):\n    @abstractmethod\n    def run(self):\n        raise NotImplementedError\n"); // enigma:verify-ignore
    expect(scanGaps(dir)).toEqual([]);
});

test("runs the configured verification command and reports its failure", () => {
    const dir = repoWith();
    write(dir, "src/new.ts", "export const a = 1;\n");
    writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ verifyCommand: "node -e \"process.exit(3)\"" }));
    try {
        const { gaps } = collectGaps(dir);
        expect(gaps.length).toBe(1);
        expect(gaps[0]!.kind).toBe("command");
        expect(gaps[0]!.detail).toContain("exited 3");
    } finally {
        writeFileSync(join(HOME, ".enigma.json"), "{}");
    }
});

test("runs the verification command once per piece of new work, not once per claim", () => {
    // Two failure modes, one rule. Gating on a dirty tree skipped the suite exactly when the
    // agent had committed - the flow enigma prescribes. Gating on the branch's line count ran
    // it on every conversational turn, since on a branch with earlier commits that count is
    // always positive. The question is whether anything has moved since it last passed.
    const dir = repoWith({ "src/app.ts": "export const a = 1;\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    write(dir, "src/more.ts", "export const b = 2;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "work, then report - nothing left uncommitted");
    writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ verifyCommand: "node -e \"\"" }));
    try {
        // Committed work still gets verified.
        expect(collectGaps(dir).ranCommand).toBe(true);
        // A second claim with nothing changed since does not pay for it again.
        expect(collectGaps(dir).ranCommand).toBe(false);
        // New work brings it back.
        write(dir, "src/again.ts", "export const c = 3;\n");
        expect(collectGaps(dir).ranCommand).toBe(true);
    } finally {
        writeFileSync(join(HOME, ".enigma.json"), "{}");
    }
});

/** A Stop payload for `dir`, with a fresh prompt id unless one is given. */
let promptSeq = 0;
function payload(dir: string, message: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ cwd: dir, last_assistant_message: message, prompt_id: `p${promptSeq++}`, ...extra });
}

test("denies the stop only when a claim is contradicted by evidence", () => {
    const dir = repoWith();
    write(dir, "src/new.ts", "// TODO: finish this\n"); // enigma:verify-ignore

    // Claim + evidence -> blocked.
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(2);
    // Evidence but no claim -> the turn is free to end.
    expect(runVerifyHook(payload(dir, "I started the parser; continuing next turn."))).toBe(0);
    // stop_hook_active must NOT excuse the claim: it stays set for every stop while the turn
    // continues, so honouring it let an agent clear the gate by repeating "all done" unchanged.
    expect(runVerifyHook(payload(dir, "All done.", { stop_hook_active: true }))).toBe(2);
});

test("stands aside inside a gate step agent", () => {
    // A gate step answers with the structured JSON its step asked for, so there is no
    // completion claim to judge - and denying the stop would spend another agent turn inside
    // a pipeline that already owns review, test and lint. Same payload, both directions.
    const dir = repoWith();
    write(dir, "src/new.ts", "// TODO: finish this\n"); // enigma:verify-ignore
    const claim = payload(dir, "All done, everything is implemented.");
    expect(runVerifyHook(claim)).toBe(2);

    const previous = process.env.ENIGMA_GATE;
    process.env.ENIGMA_GATE = "1";
    try {
        expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);
    } finally {
        if (previous === undefined) delete process.env.ENIGMA_GATE;
        else process.env.ENIGMA_GATE = previous;
    }
});

test("a moved marker does not buy a fresh block budget", () => {
    // The budget is keyed on the findings, not their position: inserting a line above an
    // untouched marker must not reset it, or the cap can be dodged indefinitely.
    const dir = repoWith();
    write(dir, "src/new.ts", "// TODO: finish this\n"); // enigma:verify-ignore
    const same = { session_id: "drift-session" };
    expect(runVerifyHook(payload(dir, "All done.", same))).toBe(2);
    write(dir, "src/new.ts", "const unrelated = 1;\n// TODO: finish this\n"); // enigma:verify-ignore
    expect(runVerifyHook(payload(dir, "All done.", same))).toBe(2);
    write(dir, "src/new.ts", "const a = 1;\nconst b = 2;\n// TODO: finish this\n"); // enigma:verify-ignore
    expect(runVerifyHook(payload(dir, "All done.", same))).toBe(0);
});

test("lets a claim through when the work holds up", () => {
    const dir = repoWith();
    write(dir, "src/new.ts", "export const parse = (s: string): number => Number(s);\n");
    expect(runVerifyHook(payload(dir, "All done - the parser is implemented and tested."))).toBe(0);
});

test("stands down after repeated blocks on one prompt", () => {
    const dir = repoWith();
    write(dir, "src/new.ts", "// TODO: finish this\n"); // enigma:verify-ignore
    const same = { prompt_id: "stuck-prompt" };
    expect(runVerifyHook(payload(dir, "All done.", same))).toBe(2);
    expect(runVerifyHook(payload(dir, "All done.", same))).toBe(2);
    // Third attempt: the gate gives up rather than trapping the turn in a loop.
    expect(runVerifyHook(payload(dir, "All done.", same))).toBe(0);
});

test("a repo can switch the gate off for itself", () => {
    const dir = repoWith();
    write(dir, "src/new.ts", "// TODO: finish this\n"); // enigma:verify-ignore
    write(dir, ".enigma.json", JSON.stringify({ verify: false }));
    expect(runVerifyHook(payload(dir, "All done."))).toBe(0);
});

test("still sees the work after the agent commits it", () => {
    // enigma's own workflow tells an agent to commit before validating. Against HEAD alone
    // that leaves an empty diff, so the gate would find nothing and wave the claim through.
    const dir = repoWith({ "src/app.ts": "export const a = 1;\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    write(dir, "src/new.ts", "// TODO: finish this\n"); // enigma:verify-ignore
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "wip");

    expect(scanGaps(dir).length).toBe(1);
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(2);
});

test("stops reporting a marker once it has been removed", () => {
    // Committed evidence has to reflect the CURRENT state: blocking over something already
    // fixed is a false block, and false blocks are how a gate like this gets switched off.
    const dir = repoWith({ "src/app.ts": "export const a = 1;\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    write(dir, "src/new.ts", "// TODO: finish this\nexport const b = 2;\n"); // enigma:verify-ignore
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "wip");
    expect(scanGaps(dir).length).toBe(1);

    write(dir, "src/new.ts", "export const b = 2;\n");
    expect(scanGaps(dir)).toEqual([]);
});

test("does not mistake ordinary code for a placeholder", () => {
    const dir = repoWith();
    write(dir, "src/theme.css", ":root { --placeholder-color: #999; }\n");
    write(dir, "src/link.html", "<a href=\"#placeholder\">jump</a>\n");
    write(dir, "package.json", "{ \"scripts\": { \"build\": \"module-build build --stub\" } }\n");
    expect(scanGaps(dir)).toEqual([]);
});

test("a marker committed before the branch existed stays out of scope", () => {
    const dir = repoWith({ "src/old.ts": "// TODO: someone else's debt\n" }); // enigma:verify-ignore
    git(dir, "checkout", "-q", "-b", "feature");
    write(dir, "src/new.ts", "export const clean = true;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "clean work");
    expect(scanGaps(dir)).toEqual([]);
});

test("falls back to the transcript when the payload has no final message", () => {
    const dir = repoWith();
    write(dir, "src/new.ts", "// TODO: finish this\n"); // enigma:verify-ignore
    const transcript = join(dir, "session.jsonl");
    writeFileSync(transcript, [
        JSON.stringify({ type: "user", message: { role: "user", content: "port it" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All done, everything is implemented." }] } }),
        "",
    ].join("\n"));
    expect(runVerifyHook(JSON.stringify({ cwd: dir, transcript_path: transcript, prompt_id: "no-message" }))).toBe(2);
});

test("says so when it cannot read the final message at all", () => {
    const dir = repoWith();
    write(dir, "src/new.ts", "// TODO: finish this\n"); // enigma:verify-ignore
    const said: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown; }).write = (chunk: string): boolean => { said.push(String(chunk)); return true; };
    try {
        expect(runVerifyHook(JSON.stringify({ cwd: dir, prompt_id: "no-message-at-all" }))).toBe(0);
    } finally {
        (process.stderr as { write: unknown; }).write = original;
    }
    expect(said.join("")).toContain("completion check did not run");
});

test("parity reports a module the port never carried over", () => {
    const source = mkdtempSync(join(tmpdir(), "enigma-parity-src-"));
    const target = mkdtempSync(join(tmpdir(), "enigma-parity-dst-"));
    repos.push(source, target);
    write(source, "parser.ts", "export function parseHeader() {}\nexport function parseBody() {}\n");
    write(source, "exporter.ts", "export function exportCsv() {}\nexport function exportJson() {}\n");
    // The port renames across conventions but skips the exporter entirely.
    write(target, "parser.py", "def parse_header():\n    pass\n\ndef parse_body():\n    pass\n");

    const report = parityReport(source, target);
    expect(report.absent.length).toBe(1);
    expect(report.absent[0]!.module).toBe("exporter.ts");
    expect(report.absent[0]!.missing).toEqual(["exportCsv", "exportJson"]);
    expect(report.coverage).toBe(50);
});

test("parity refuses to call an empty comparison a pass", () => {
    const source = mkdtempSync(join(tmpdir(), "enigma-parity-empty-src-"));
    const target = mkdtempSync(join(tmpdir(), "enigma-parity-empty-dst-"));
    repos.push(source, target);
    write(target, "app.ts", "export function run() {}\n");

    const report = parityReport(source, target);
    expect(report.empty).toBe(true);
    expect(formatParity(report)).toContain("NOTHING TO COMPARE");
    // 100% coverage over zero symbols must never read as "every module has a counterpart".
    expect(formatParity(report)).not.toContain("Every source module");
});

test("a repository before its first commit is fully covered, not truncated", () => {
    // Every file is untracked and read in full, so there is nothing incomplete to report -
    // but diffing HEAD fails there, and treating that as a failed scan told a scaffolding turn
    // its work had only been partially checked.
    const dir = mkdtempSync(join(tmpdir(), "enigma-verify-fresh-"));
    repos.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    write(dir, "src/new.ts", "// TODO: finish this\n"); // enigma:verify-ignore
    const scan = collectGaps(dir);
    expect(scan.truncated).toBe(false);
    expect(scan.gaps.length).toBe(1);
});

test("does not silently pass outside a git repository", () => {
    const plain = mkdtempSync(join(tmpdir(), "enigma-verify-nogit-"));
    repos.push(plain);
    write(plain, "src/new.ts", "// TODO: finish this\n"); // enigma:verify-ignore
    const scan = collectGaps(plain);
    expect(scan.noRepo).toBe(true);
    expect(scan.gaps).toEqual([]);
});

test("a fresh problem gets its own block budget", () => {
    const dir = repoWith();
    write(dir, "src/a.ts", "// TODO: first problem\n"); // enigma:verify-ignore
    const same = { session_id: "one-session" };
    expect(runVerifyHook(payload(dir, "All done.", same))).toBe(2);
    expect(runVerifyHook(payload(dir, "All done.", same))).toBe(2);
    // The same unresolved evidence has spent its budget...
    expect(runVerifyHook(payload(dir, "All done.", same))).toBe(0);
    // ...but a different problem in the same session must still be caught, which keying the
    // budget on the turn (rather than on the evidence) silently prevented.
    write(dir, "src/b.ts", "// FIXME: second problem\n"); // enigma:verify-ignore
    expect(runVerifyHook(payload(dir, "All done.", same))).toBe(2);
});

test("parity accepts a faithful port across naming conventions", () => {
    const source = mkdtempSync(join(tmpdir(), "enigma-parity-ok-src-"));
    const target = mkdtempSync(join(tmpdir(), "enigma-parity-ok-dst-"));
    repos.push(source, target);
    write(source, "parser.ts", "export function parseHeader() {}\nexport function parseBody() {}\n");
    write(target, "parser.py", "def parse_header():\n    pass\n\ndef parse_body():\n    pass\n");

    const report = parityReport(source, target);
    expect(report.absent).toEqual([]);
    expect(report.partial).toEqual([]);
    expect(report.coverage).toBe(100);
});
