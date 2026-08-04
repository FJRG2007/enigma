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
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-verify-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
// The turn-end sweep records what it found, and it must never append to the real ledger.
process.env.ENIGMA_GUARDRAILS_LOG = join(HOME, "guardrail-log.jsonl");
// Same for the gate run ledger the unvalidated-work check reads: it must be this test's own,
// or the machine's real gate history would decide the result.
process.env.ENIGMA_GATE_HOME = join(HOME, "gate");
// The hook stands aside inside a gate step agent, so an ambient ENIGMA_GATE=1 (the suite run
// from inside an enigma gate pipeline) would make every case below pass open and fail here.
// The one test that exercises that path sets the variable itself.
delete process.env.ENIGMA_GATE;

const { claimsDone, asksToContinue, gateSkipped, scanGaps, scanConventions, collectGaps, runVerifyHook, unsourcedTrailers } = await import("../src/verify");
const { recordGateRun, lastGateRun, validatingRun } = await import("../src/gate-ledger");
const { parityReport, formatParity } = await import("../src/verify-parity");
const { readLedger } = await import("../src/guardrails");

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

/** The branch a throwaway repository landed on - `git init` follows the machine's default. */
function branchOf(dir: string): string {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
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

test("reads a turn that hands the quality gate back as a skip", () => {
    for (const message of [
        // The message this check was reported for: the gate named, not run, handed back.
        "El gate (enigma gate) sigue sin ejecutarse: este repo no tiene .enigma.json. Dime si quieres que lo inicialice y lo lance.",
        "Todo listo. No he ejecutado el gate porque el repo no está inicializado; si quieres lo lanzo.",
        "The quality gate has not run yet - let me know if you want me to launch it.",
        "I skipped the enigma gate for this change.",
        "Shall I run the gate now?",
    ]) expect(gateSkipped(message)).not.toBe("");

    for (const message of [
        // It ran: the PR it leaves ready is the user's to merge, which is not a skip.
        "The gate ran and every check passed; the PR is ready for you to review and merge.",
        "El gate pasó todos los checks. Te dejo el PR listo para revisar y mergear.",
        // Each reason the policy accepts, stated - which is the documented way out.
        "No he lanzado el gate porque me pediste que me lo saltara.",
        "The gate was not run: this repo sets gate: false.",
        "The gate did not run because the branch is a protected branch.",
        // A run that parked on a finding must be escalated verbatim, not treated as a skip.
        "The gate parked on an ask-user finding: it wants to know whether to drop the legacy column.",
        // Nothing to do with the gate.
        "I did not run the tests for the docs change.",
        "Refactored the login gateway; it did not run into the retry path.",
        // Ordinary prose about the gate's own CODE: "the gate <noun>" is not the pipeline, and
        // an everyday closer is not an offer to run it. This is the daily vocabulary of the
        // repository the check ships from, so reading it as a skipped run blocks routine turns.
        "Refactored the gate daemon so the snapshot writer and the ledger share one broadcast. Let me know if you want the docs note updated too.",
        "I added the gate view to the dashboard. Shall I also wire the settings bridge?",
        "The gate pipeline docs are now in docs/notes/gate.md. Tell me if you want a shorter version.",
        "Documented the gate ledger. Shall I run the tests as well?",
        "The gate daemon was not started in this session.",
        // `gate` as the head of a compound noun survives a RUN verb in front of it too, and the
        // verb itself must be a whole word - `Restarted` is not `start`.
        "I ran the gate tests but did not run the full suite.",
        "Restarted the gate daemon; the dashboard bridge was not started.",
        // An everyday closer whose verb only spells a run verb in the other language: `corr`,
        // `pas` and `start` against a bare `it` turned "correct it" into an offer to run.
        "The quality gate flagged a stray import. Let me know if you want me to correct it.",
        "The quality gate found one failing test. Tell me if you want me to start it locally.",
        // The gate could not be stood up at all. Not a policy reason but a fact about the
        // machine, and it has to be an exit or the block orders something that cannot succeed.
        "The gate did not run because the daemon failed to start.",
        "The quality gate has not run: this repo has no origin remote, so `enigma gate init` cannot complete.",
        "El gate sigue sin ejecutarse: no hay remoto configurado en este repo.",
        // Reported as run, with an offer about something else entirely.
        "The gate run passed all checks and the PR is ready. Let me know if you want anything changed before merging.",
    ]) expect(gateSkipped(message)).toBe("");
});

test("denies the stop when the turn reports the gate as skipped", () => {
    // No diff is read for this one either: the message itself says the work ends unvalidated.
    const dir = repoWith();
    write(dir, "src/new.ts", "export const total = 1;\n");
    expect(runVerifyHook(payload(dir, "El refactor está terminado. El gate sigue sin ejecutarse; dime si quieres que lo lance."))).toBe(2);
    // Naming an accepted reason clears it on the first try, exactly like a real blocker does.
    expect(runVerifyHook(payload(dir, "El refactor está terminado. No he lanzado el gate porque me pediste que me lo saltara."))).toBe(0);
    // A repo that opted out is not skipping anything.
    write(dir, ".enigma.json", JSON.stringify({ gate: false }));
    expect(runVerifyHook(payload(dir, "Listo. El gate sigue sin ejecutarse, dime si quieres que lo lance."))).toBe(0);
});

test("denies the stop when committed work never reached an enabled gate", () => {
    // The check stands down entirely until something records runs, so that an install whose
    // daemon still predates the ledger does not read "no record" as "never validated". One
    // run for an unrelated repository is enough to prove the recording side is alive.
    recordGateRun({ repoPath: join(tmpdir(), "some-other-repo"), branch: "main", headSha: "0".repeat(7), status: "completed", at: 1 });
    const dir = repoWith({ "src/app.ts": "export const a = 1;\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    const commit = (file: string): void => {
        write(dir, file, "export const total = 1;\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", "work");
    };

    // FIRST SIGHTING ONLY STARTS THE WATCH: commits that predate this check (or the gate being
    // switched on) are not this turn's doing, and blocking over them would be a false block.
    commit("src/one.ts");
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);

    // Committed afterwards, with no run recorded for this repository: unvalidated work.
    commit("src/two.ts");
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(2);

    // A recorded run that saw those commits clears it - and a stale one does not.
    recordGateRun({ repoPath: dir, branch: "feature", headSha: "abc1234", status: "completed", at: 1 });
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(2);
    recordGateRun({ repoPath: dir, branch: "feature", headSha: "abc1234", status: "completed", at: Math.floor(Date.now() / 1000) + 5 });
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);
    expect(lastGateRun(join(dir, "src"))?.branch).toBe("feature");

    // A turn that claims nothing is not claiming the unvalidated work is finished.
    commit("src/three.ts");
    expect(runVerifyHook(payload(dir, "Pushed the first half; continuing next turn."))).toBe(0);
});

test("lets the ending a successful run prescribes close the turn", () => {
    // The prescribed report after a passing run hands the PR back, and what it offers is a
    // review, not a run - so no ledger is needed to tell it apart from a skip.
    const dir = repoWith({ "src/app.ts": "export const a = 1;\n" });
    expect(runVerifyHook(payload(dir, "The gate run passed all checks and the PR is ready. Let me know if you want anything changed before merging."))).toBe(0);
    expect(runVerifyHook(payload(dir, "El gate pasó todos los checks. Te dejo el PR listo; dime si quieres que lo mergee."))).toBe(0);

    // Offering to RUN it is the skipped shape whatever precedes it, and there the ledger - not
    // the phrasing - decides: a run that already saw this HEAD makes the report true.
    const offer = "The gate run passed all checks. Let me know if you want me to run it again.";
    expect(runVerifyHook(payload(dir, offer))).toBe(2);
    recordGateRun({ repoPath: dir, branch: branchOf(dir), headSha: "abc1234", status: "checks-passed", at: Math.floor(Date.now() / 1000) + 5 });
    expect(runVerifyHook(payload(dir, offer))).toBe(0);
});

test("a run on another branch does not vouch for this one", () => {
    // The pipeline reviews, fixes and pushes ONE branch. A run recorded for a different branch
    // of the same repository saw none of this work, so it must not stand the check down.
    recordGateRun({ repoPath: join(tmpdir(), "one-more-repo"), branch: "main", headSha: "0".repeat(7), status: "completed", at: 1 });
    const dir = repoWith({ "src/app.ts": "export const a = 1;\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    const commit = (file: string): void => {
        write(dir, file, "export const total = 1;\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", "work");
    };

    commit("src/one.ts");
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);
    commit("src/two.ts");
    const at = Math.floor(Date.now() / 1000) + 5;
    recordGateRun({ repoPath: dir, branch: "other", headSha: "abc1234", status: "completed", at });
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(2);
    recordGateRun({ repoPath: dir, branch: "feature", headSha: "abc1234", status: "completed", at });
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);
});

test("a run that was aborted or failed vouches for nothing", () => {
    // Otherwise the whole check has a one-command way out: start a run, abort it, and the
    // ledger entry it leaves behind stands the gate down for those commits forever.
    recordGateRun({ repoPath: join(tmpdir(), "a-fifth-repo"), branch: "main", headSha: "0".repeat(7), status: "completed", at: 1 });
    const dir = repoWith({ "src/app.ts": "export const a = 1;\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    const commit = (file: string): void => {
        write(dir, file, "export const total = 1;\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", "work");
    };

    commit("src/one.ts");
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);
    commit("src/two.ts");
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(2);
    const at = Math.floor(Date.now() / 1000) + 5;

    // A run recorded in flight clears the turn - being parked awaiting the driving agent is
    // not a skip - but its own in-flight stamps must not survive it being aborted.
    recordGateRun({ repoPath: dir, runId: "run-a", branch: "feature", headSha: "abc1234", status: "running", at });
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);
    recordGateRun({ repoPath: dir, runId: "run-a", branch: "feature", headSha: "abc1234", status: "cancelled", at });
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(2);

    // A run that really did clear this work, then a later one that dies: the failure must not
    // take the earlier run's answer with it, or an aborted retry becomes a false block.
    recordGateRun({ repoPath: dir, runId: "run-b", branch: "feature", headSha: "abc1234", status: "completed", at });
    // NOTE on the explicit timeout at the end of this test: it drives the hook nine times, far
    // more than any real turn, and the hook grew one more git subprocess per call when the
    // co-author source check landed. Nothing here is slow on its own.
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);
    recordGateRun({ repoPath: dir, runId: "run-c", branch: "feature", headSha: "def5678", status: "running", at: at + 10 });
    recordGateRun({ repoPath: dir, runId: "run-c", branch: "feature", headSha: "def5678", status: "failed", at: at + 10 });
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);
    expect(lastGateRun(dir)?.status).toBe("failed");
    expect(validatingRun(lastGateRun(dir))?.status).toBe("completed");
    expect(validatingRun(lastGateRun(dir))?.at).toBe(at);
}, 20_000);

test("keeps the gate's watch anchor when the block-counter state is pruned", () => {
    recordGateRun({ repoPath: join(tmpdir(), "yet-another-repo"), branch: "main", headSha: "0".repeat(7), status: "completed", at: 1 });
    const dir = repoWith({ "src/app.ts": "export const a = 1;\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    const commit = (file: string): void => {
        write(dir, file, "export const total = 1;\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", "work");
    };
    commit("src/one.ts");
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);

    // The state file is shared by every repository and session on this machine and is capped at
    // its newest keys. The watch is written once and never rewritten, so it is the first thing
    // an insertion-order prune reaches - and losing it re-arms the watch at now, which exempts
    // every commit made so far.
    const state = join(HOME, ".enigma", "verify-state.json");
    const counters = JSON.parse(readFileSync(state, "utf8")) as Record<string, number>;
    for (let i = 0; i < 60; i++) counters[`filler:${i}`] = 1;
    writeFileSync(state, JSON.stringify(counters));

    commit("src/two.ts");
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(2);
    expect(Object.keys(JSON.parse(readFileSync(state, "utf8"))).some((key) => key.startsWith("gatewatch:"))).toBe(true);
    // And the block survives its own pruning, rather than standing down on the next turn.
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(2);
});

test("does not order a run the gate CLI would refuse over a dirty tree", () => {
    recordGateRun({ repoPath: join(tmpdir(), "another-repo"), branch: "main", headSha: "0".repeat(7), status: "completed", at: 1 });
    const dir = repoWith({ "src/app.ts": "export const a = 1;\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    const commit = (file: string): void => {
        write(dir, file, "export const total = 1;\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", "work");
    };

    commit("src/one.ts");
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);
    commit("src/two.ts");
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(2);

    // Same unvalidated commits, plus an uncommitted edit: `axi run` refuses a dirty tree, so
    // ordering a run here would leave no way out but a commit the user never asked for.
    write(dir, "src/three.ts", "export const total = 3;\n");
    expect(runVerifyHook(payload(dir, "All done, everything is implemented."))).toBe(0);
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

/** A handler that changes server state and only then touches the UI - the shape the rule names. */
const SERVER_FIRST = [
    "export function Rows({ items, setItems }) {",
    "    const remove = async (id) => {",
    "        await fetch(`/api/items/${id}`, { method: \"DELETE\" });",
    "        setItems((prev) => prev.filter((item) => item.id !== id));",
    "    };",
    "}",
].join("\n");

test("the convention sweep reports only what the change added", () => {
    // The committed file breaks the same rule: a repository's existing code is not this change's
    // to answer for, and blocking on it is how a gate gets switched off. Same ratchet as markers.
    const dir = repoWith({ "src/Legacy.tsx": SERVER_FIRST });
    write(dir, "src/New.tsx", SERVER_FIRST);
    const { gaps, findings } = scanConventions(dir);
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.kind).toBe("convention");
    expect(gaps[0]!.file).toBe("src/New.tsx");
    expect(gaps[0]!.detail).toContain("fe-server-first-mutation");
    expect(findings[0]!.ruleId).toBe("fe-server-first-mutation");
});

test("a broken convention denies the stop even when the turn claims nothing", () => {
    // The claim path cannot catch this: nothing about the code is unfinished, it is wrong - and a
    // warn from the post-edit hook exits 0, so this is the only channel that reaches the model.
    const dir = repoWith();
    write(dir, "src/New.tsx", SERVER_FIRST);
    expect(runVerifyHook(payload(dir, "Added the delete action.", { session_id: "conv-1" }))).toBe(2);
    // Fixed: the update is applied first and rolled back on failure, so the sweep is silent.
    write(dir, "src/New.tsx", [
        "export function Rows({ items, setItems }) {",
        "    const remove = async (id) => {",
        "        const previous = items;",
        "        setItems((prev) => prev.filter((item) => item.id !== id));",
        "        const res = await fetch(`/api/items/${id}`, { method: \"DELETE\" });",
        "        if (!res.ok) setItems(previous);",
        "    };",
        "}",
    ].join("\n"));
    expect(runVerifyHook(payload(dir, "Added the delete action.", { session_id: "conv-2" }))).toBe(0);
});

test("the sweep reads, and never writes", () => {
    // Repairs belong to the post-edit hook, where the file is dirty by construction. A sweep that
    // wrote to source could rewrite a line that is ALREADY COMMITTED - enigma's own flow is
    // commit-then-validate - leaving the working tree silently disagreeing with the commit every
    // later gate step reads, with one best-effort notice as the only way anyone heard about it.
    const added = '<span className="truncate">{user.name}</span>\n';
    const dir = repoWith({ "src/Legacy.tsx": '<span className="truncate">{user.email}</span>\n' });
    write(dir, "src/Row.tsx", added);
    const scan = scanConventions(dir);
    expect(readFileSync(join(dir, "src/Row.tsx"), "utf8")).toBe(added);
    // Unrepaired, so it is reported - which is what the sweep is for.
    expect(scan.gaps.length).toBe(1);
    expect(scan.gaps[0]!.file).toBe("src/Row.tsx");
    expect(scan.gaps[0]!.detail).toContain("fe-truncated-value-unreachable");
});

test("a clipped value the fixer declines still reaches the model", () => {
    // A fallback expression, a call, a component that may not forward the attribute: the fixer
    // declines all of them in the hook, so the sweep is where they land. Declining is safe;
    // guessing is not.
    const dir = repoWith();
    write(dir, "src/Row.tsx", '<span className="truncate">{user.name ?? "Unknown"}</span>\n');
    const scan = scanConventions(dir);
    expect(scan.gaps.length).toBe(1);
    expect(scan.gaps[0]!.detail).toContain("fe-truncated-value-unreachable");
    expect(readFileSync(join(dir, "src/Row.tsx"), "utf8")).not.toContain("title=");
});

test("the convention sweep stands aside when guardrails are off for the project", () => {
    const dir = repoWith();
    write(dir, "src/New.tsx", SERVER_FIRST);
    write(dir, ".enigma.json", JSON.stringify({ guardrails: false }));
    expect(scanConventions(dir).gaps).toEqual([]);
});

test("a suggestion never denies the stop, but it is recorded", () => {
    // Severity keeps its meaning here: a warn rule is advice, and a gate that stops a turn over
    // advice is a gate that gets switched off - which would cost the blocking rules too. What it
    // must NOT do is vanish, which is what happened before: the post-edit hook prints a warn to
    // stdout, exits 0, and nothing anywhere remembers that the rule was skipped.
    const dir = repoWith();
    write(dir, "src/route.ts", "export const handler = (req, res) => {\n    const body = req.body;\n    res.json(body);\n};\n");
    const scan = scanConventions(dir);
    expect(scan.gaps).toEqual([]);
    expect(scan.notes.some((n) => n.detail.includes("be-validate-input-ts"))).toBe(true);
    expect(runVerifyHook(payload(dir, "Added the handler.", { session_id: "warn-only" }))).toBe(0);
    expect(readLedger().some((e) => e.rule === "be-validate-input-ts" && e.outcome === "warned")).toBe(true);
});

test("a hand-run check reports the suggestions too, without failing on them", () => {
    // The turn-end hook shows these; dropping them here made the command a person runs by hand
    // answer a narrower question than the gate it is supposed to stand in for.
    const dir = repoWith();
    write(dir, "src/route.ts", "export const handler = (req, res) => {\n    const body = req.body;\n    res.json(body);\n};\n");
    const scan = collectGaps(dir, { conventions: true, runCommand: false });
    expect(scan.gaps).toEqual([]);
    expect(scan.notes?.some((n) => n.detail.includes("be-validate-input-ts"))).toBe(true);
});

test("the convention sweep says when its list was cut short", () => {
    // Shown-is-all would let the model fix everything it was given and be blocked again next turn
    // by findings it was never told about - and the dropped ones never reach the ledger either.
    const dir = repoWith();
    const handlers = Array.from({ length: 26 }, (_, n) => [
        `    const remove${n} = async (id) => {`,
        '        await fetch("/api/items/" + id, { method: "DELETE" });',
        "        setItems((prev) => prev.filter((item) => item.id !== id));",
        "    };",
    ].join("\n")).join("\n");
    write(dir, "src/Many.tsx", `export function Rows({ setItems }) {\n${handlers}\n}\n`);
    const scan = scanConventions(dir);
    expect(scan.gaps.length).toBe(25);
    expect(scan.capped).toBe(true);
});

test("convention blocks spend their own budget, not the completion gate's", () => {
    // Both channels counted against one session-wide ceiling, so a handful of heuristic convention
    // findings early in a session could exhaust it - and the completion-claim gate, the primary one
    // and the reason this module exists, then stopped firing silently for the rest of that session.
    const dir = repoWith();
    const session = "own-budget";
    write(dir, "src/New.tsx", SERVER_FIRST);
    expect(runVerifyHook(payload(dir, "Added the delete action.", { session_id: session }))).toBe(2);
    const state = JSON.parse(readFileSync(join(HOME, ".enigma", "verify-state.json"), "utf8"));
    expect(state[`conventions:${session}`]).toBe(1);
    expect(state[`total:${session}`]).toBeUndefined();
    // The same issue still stands down on its own after two blocks, so a turn is never trapped.
    expect(runVerifyHook(payload(dir, "Added the delete action.", { session_id: session }))).toBe(2);
    expect(runVerifyHook(payload(dir, "Added the delete action.", { session_id: session }))).toBe(0);
});

// --- an identity that came from nowhere ------------------------------------------------

/**
 * A transcript file holding exactly `records`, one JSON object per line, opened by a timed record
 * the way a real session is. That timestamp is the session clock the provenance check compares
 * HEAD's committer date against, so the default sits far enough in the past that every commit
 * these tests make falls inside the session; the case that needs a session younger than the
 * commit passes its own.
 */
function transcriptOf(records: unknown[], startedAt = "2000-01-01T00:00:00.000Z"): string {
    const dir = mkdtempSync(join(tmpdir(), "enigma-verify-tx-"));
    repos.push(dir);
    const path = join(dir, "session.jsonl");
    const lines = [{ type: "system", timestamp: startedAt }, ...records].map((r) => JSON.stringify(r));
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
}

/** A transcript holding one user message and one tool result, in Claude Code's JSONL shape. */
function transcript(userText: string, toolResult = ""): string {
    return transcriptOf([
        { type: "user", message: { role: "user", content: [{ type: "text", text: userText }] } },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } },
        ...(toolResult ? [{ type: "user", message: { role: "user", content: [{ type: "tool_result", content: toolResult }] } }] : []),
    ]);
}

/** A commit crediting `email` as a co-author, on top of the repository's base commit. */
function coAuthored(dir: string, email: string, extra = ""): void {
    write(dir, "feature.txt", "work");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `feat: add the thing\n\n${extra}Co-authored-by: Someone <${email}>`);
}

test("blocks a co-author address that came from nowhere", () => {
    const dir = repoWith();
    coAuthored(dir, "team.fjrg2007@gmail.com");
    const gaps = unsourcedTrailers(dir, transcript("Add me as co-contributor, my username is FJRG2007."));
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.kind).toBe("source");
    expect(gaps[0]!.detail).toContain("team.fjrg2007@gmail.com");
});

test("clears an address the user actually typed", () => {
    // The whole discrimination: the trailer is identical, only its provenance differs.
    const dir = repoWith();
    coAuthored(dir, "team.fjrg2007@gmail.com");
    expect(unsourcedTrailers(dir, transcript("Add me as co-author: team.fjrg2007@gmail.com"))).toEqual([]);
    // Case is not provenance - git and mail treat the domain case-insensitively.
    expect(unsourcedTrailers(dir, transcript("co-author: Team.FJRG2007@Gmail.com"))).toEqual([]);
});

test("a tool result does not vouch for an address", () => {
    // The value the agent invented three turns ago comes back through its own tool output, so
    // reading a tool_result as a source would let a fabrication clear itself.
    const dir = repoWith();
    coAuthored(dir, "invented@example.org");
    const gaps = unsourcedTrailers(dir, transcript("add the co-author", "Co-authored-by: X <invented@example.org>"));
    expect(gaps.length).toBe(1);
});

test("clears an address the repository already knows", () => {
    const dir = repoWith();
    // The identity that made the base commit is vouched for by definition.
    coAuthored(dir, "test@example.com");
    expect(unsourcedTrailers(dir, transcript("add a co-author"))).toEqual([]);
    // As is one the project recorded in .mailmap without it ever having committed. This case
    // commits the mailmap in the SAME commit as the trailer, which is precisely the residual the
    // committed-tree read does not close - it raises the bar to "written and committed", not to
    // "the turn cannot vouch for itself", and it still passes for that reason.
    write(dir, ".mailmap", "Someone Else <known@example.org>\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "chore: mailmap\n\nCo-authored-by: Someone Else <known@example.org>");
    expect(unsourcedTrailers(dir, transcript("add a co-author"))).toEqual([]);
});

test("the mailmap is read from the repository root, not from the session's directory", () => {
    // `cwd` here is the Stop payload's, which the user freely sets to a monorepo package. Reading
    // `join(cwd, ".mailmap")` found nothing there and denied the turn over an address the project
    // had explicitly recorded - the direction this check must never fail in.
    const dir = repoWith({ ".mailmap": "Someone Else <known@example.org>\n" });
    mkdirSync(join(dir, "packages", "thing"), { recursive: true });
    coAuthored(dir, "known@example.org");
    expect(unsourcedTrailers(join(dir, "packages", "thing"), transcript("add a co-author"))).toEqual([]);
});

test("an uncommitted mailmap does not vouch for the address the turn invented", () => {
    // Same self-vouching class as a tool result and as this hook's own feedback: the block message
    // says to get the address from a source, and writing the invented person into the working
    // tree's .mailmap reads like doing exactly that.
    const dir = repoWith();
    coAuthored(dir, "invented@example.org");
    write(dir, ".mailmap", "Someone <invented@example.org>\n");
    expect(unsourcedTrailers(dir, transcript("add the co-author")).length).toBe(1);
});

test("clears an address that committed on a branch HEAD cannot reach", () => {
    // Alice pushes to main while this work sits off it: her address is in the repository, just not
    // among HEAD's ancestors, and a HEAD-only walk read it as coming from nowhere.
    const dir = repoWith();
    const base = branchOf(dir);
    git(dir, "checkout", "-qb", "alice");
    write(dir, "hers.txt", "work");
    git(dir, "add", "-A");
    git(dir, "-c", "user.email=alice@example.org", "-c", "user.name=Alice", "commit", "-qm", "feat: alice's work");
    git(dir, "checkout", "-q", base);
    coAuthored(dir, "alice@example.org");
    expect(unsourcedTrailers(dir, transcript("credit alice"))).toEqual([]);
});

test("the escape hatch and every unreadable source fail open", () => {
    const dir = repoWith();
    coAuthored(dir, "sourced@example.org", "enigma:allow-unsourced-trailer\n\n");
    expect(unsourcedTrailers(dir, transcript("add a co-author"))).toEqual([]);
    // No transcript at all is "cannot tell", never "the user never said it".
    const other = repoWith();
    coAuthored(other, "unknown@example.org");
    expect(unsourcedTrailers(other, "")).toEqual([]);
    expect(unsourcedTrailers(other, join(HOME, "no-such-session.jsonl"))).toEqual([]);
    // Outside a repository there is nothing to read and nothing to block.
    const plain = mkdtempSync(join(tmpdir(), "enigma-verify-notrepo-"));
    repos.push(plain);
    expect(unsourcedTrailers(plain, transcript("hello"))).toEqual([]);
});

test("a commit with no co-author trailer is never reported", () => {
    const dir = repoWith();
    write(dir, "feature.txt", "work");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "feat: no trailers here");
    expect(unsourcedTrailers(dir, transcript("do the thing"))).toEqual([]);
});

test("this hook's own feedback does not vouch for the address it just blocked", () => {
    // THE CHANNEL THAT ACTUALLY FIRES IN PRODUCTION, and the one that would have let the check
    // clear the exact value it blocked: the block message quotes the invented address verbatim,
    // Claude Code appends the hook's stderr to the transcript as a `user` record with STRING
    // content, and reading it as provenance means the fabrication ships on the second turn.
    // The shape below is the one verified on real transcripts, isMeta included.
    const dir = repoWith();
    coAuthored(dir, "team.fjrg2007@gmail.com");
    const feedback = transcriptOf([
        { type: "user", message: { role: "user", content: [{ type: "text", text: "Add me as co-contributor, my username is FJRG2007." }] } },
        {
            type: "user",
            isMeta: true,
            isSidechain: false,
            message: { role: "user", content: "Stop hook feedback:\n[enigma __verify-hook]: enigma verify: STOP. This change credits someone using a value you do not have:\n- commit abc12345 credits <team.fjrg2007@gmail.com> as a co-author, and that address appears nowhere." },
        },
    ]);
    expect(unsourcedTrailers(dir, feedback).length).toBe(1);
});

test("no agent-authored user record vouches for an address", () => {
    const dir = repoWith();
    coAuthored(dir, "invented@example.org");
    const quoted = "please credit invented@example.org";
    // A prompt the AGENT wrote for a subagent is not the user speaking.
    expect(unsourcedTrailers(dir, transcriptOf([
        { type: "user", isSidechain: true, message: { role: "user", content: quoted } },
    ])).length).toBe(1);
    // Slash-command scaffolding, the stdout of a command the agent ran and the report a background
    // task hands back are all stored as plain user strings, and none of them carries isMeta - so
    // the tag set has to be checked too. `<task-notification>` is the largest of the three in the
    // real corpus and its body is text the AGENT wrote, quoting what it just did.
    for (const wrapper of [
        "<command-name>commit</command-name>",
        "<local-command-stdout>Co-authored-by: X <invented@example.org></local-command-stdout>",
        `<system-reminder>${quoted}</system-reminder>`,
        `<task-notification>Agent finished.\n<summary>Committed with Co-authored-by: X <invented@example.org></summary></task-notification>`,
    ]) {
        expect(unsourcedTrailers(dir, transcriptOf([
            { type: "user", message: { role: "user", content: wrapper } },
        ])).length).toBe(1);
    }
    // But a REAL prompt keeps its provenance when the harness appends a reminder to it: the
    // synthetic block is stripped, not used to discard what the user actually wrote.
    expect(unsourcedTrailers(dir, transcriptOf([
        { type: "user", message: { role: "user", content: `${quoted}\n<system-reminder>be careful</system-reminder>` } },
    ]))).toEqual([]);
});

test("a slash command's arguments are the user speaking, unlike the command's own name", () => {
    // `/commit please credit invented@example.org` is stored as all three wrappers in ONE user
    // string. Dropping `<command-args>` with the other two read an address the user typed verbatim
    // as unsourced and denied the turn over a correct commit - the direction this check must never
    // fail in. The leading `<command-message>` must not discard the record either.
    const dir = repoWith();
    coAuthored(dir, "invented@example.org");
    expect(unsourcedTrailers(dir, transcriptOf([
        {
            type: "user",
            message: {
                role: "user",
                content: "<command-message>commit is running…</command-message>\n<command-name>/commit</command-name>\n<command-args>please credit invented@example.org</command-args>",
            },
        },
    ]))).toEqual([]);
});

test("only HEAD is examined, so no finding ever prescribes a history rewrite", () => {
    // The remediation this check gives is an amend, which reaches HEAD and nothing else. Scanning
    // wider reported commits whose only safe fix would be an interactive rebase - the very outcome
    // the check exists to prevent - and re-flagged an old honest trailer every session in a
    // repository with no remote. The accepted loss is asserted here, not just commented.
    const dir = repoWith();
    coAuthored(dir, "invented@example.org");
    expect(unsourcedTrailers(dir, transcript("do the thing")).length).toBe(1);
    // One more commit on top and the invented trailer is no longer HEAD's, so it is not reported.
    write(dir, "later.txt", "more");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "chore: follow-up with no trailer");
    expect(unsourcedTrailers(dir, transcript("do the thing"))).toEqual([]);
});

test("a pushed HEAD is out of scope, so a pulled trailer never denies the turn", () => {
    // The provenance evidence is per session while a commit is not, so any tip that arrived from
    // the remote reads as unsourced. The case that made it concrete: a pulled GitHub squash-merge
    // carries a Co-authored-by whose address is in neither %ae nor %ce, because squashing discards
    // the co-author's own commits - an honest trailer, blocked, and told to amend shared history.
    const dir = repoWith();
    const remote = mkdtempSync(join(tmpdir(), "enigma-verify-remote-"));
    repos.push(remote);
    execFileSync("git", ["init", "-q", "--bare"], { cwd: remote, stdio: "ignore" });
    git(dir, "remote", "add", "origin", remote);
    coAuthored(dir, "squashed@users.noreply.github.com");
    // Unpushed it is exactly what an amend can still fix, so it is reported.
    expect(unsourcedTrailers(dir, transcript("do the thing")).length).toBe(1);
    git(dir, "push", "-q", "origin", "HEAD");
    expect(unsourcedTrailers(dir, transcript("do the thing"))).toEqual([]);
});

test("an unpushed HEAD committed before this session began is out of scope", () => {
    // Unpushed is not the same as "this turn made it". A feature branch nobody has pushed can carry
    // an honest trailer the user typed in session 1 - and session 2 cannot read session 1's
    // transcript, while a co-author who has never committed is in neither %ae nor %ce - so the
    // address read as invented and the turn was denied over work it had not touched, with a
    // remedy that amends someone else's commit.
    const dir = repoWith();
    coAuthored(dir, "alice@corp.example");
    const prompt = [{ type: "user", message: { role: "user", content: [{ type: "text", text: "carry on with the branch" }] } }];
    const afterTheCommit = new Date(Date.now() + 60_000).toISOString();
    expect(unsourcedTrailers(dir, transcriptOf(prompt, afterTheCommit))).toEqual([]);
    // A session that was already running when the commit was made still sees it, or the scoping
    // would have turned the check off rather than aimed it.
    expect(unsourcedTrailers(dir, transcriptOf(prompt)).length).toBe(1);
});

test("a source block keys on the address, not the sha, and spends its own budget", () => {
    // Two failures in one: the detail leads with the commit sha, so keying the budget on it handed
    // every amend a fresh allowance while draining the session-wide ceiling that the
    // completion-claim and stop-short gates depend on.
    const dir = repoWith();
    const session = "source-budget";
    coAuthored(dir, "invented@example.org");
    const hookArgs = { session_id: session, transcript_path: transcript("add the co-author please") };
    expect(runVerifyHook(payload(dir, "Added the co-author.", hookArgs))).toBe(2);
    const stateFile = (): Record<string, number> => JSON.parse(readFileSync(join(HOME, ".enigma", "verify-state.json"), "utf8"));
    expect(stateFile()[`source:${session}`]).toBe(1);
    expect(stateFile()[`total:${session}`]).toBeUndefined();
    // Amending rewrites the sha while the finding is unchanged, so the SAME key must be spent.
    const keyOf = (state: Record<string, number>): string => Object.keys(state).find((k) => k.startsWith(`source:${session}:`))!;
    const before = keyOf(stateFile());
    git(dir, "commit", "-q", "--amend", "-m", "feat: add the thing\n\nCo-authored-by: Someone <invented@example.org>");
    expect(runVerifyHook(payload(dir, "Added the co-author.", hookArgs))).toBe(2);
    expect(keyOf(stateFile())).toBe(before);
    expect(stateFile()[before]).toBe(2);
    // And it still stands down after two blocks on that one issue, so the turn is never trapped.
    expect(runVerifyHook(payload(dir, "Added the co-author.", hookArgs))).toBe(0);
});
