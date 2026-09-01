/**
 * Gate CLI ergonomics: the argv budget that decides whether a prompt rides in argv or on stdin,
 * `--instructions @file`, and the `--help` texts. All pure - no agent is spawned, no run starts.
 * The spawn paths themselves are exercised by real runs; what is testable here is the decision.
 * Must run under Bun: bun test tests/gate-cli.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const DIR = mkdtempSync(join(tmpdir(), "enigma-gate-cli-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const { promptFitsArgv, ARGV_PROMPT_BUDGET } = await import("../src/gate/agent/argv");
const { readInstructions } = await import("../src/gate/cli/axiDrive");
const { gateSubcommandHelp } = await import("../src/gate/cli/index");
const { runAxi, axiSubcommandHelp } = await import("../src/gate/cli/axi");
const { Paths } = await import("../src/gate/paths");
const { Database, insertRepo, insertRun, updateRunPRURL } = await import("../src/gate/db");
const { findGitRoot } = await import("../src/gate/git");

test("a normal prompt rides in argv; an oversized one is routed to stdin", () => {
  expect(promptFitsArgv("review this diff")).toBe(true);
  // The wall that produced `ENAMETOOLONG: name too long, uv_spawn`: a review prompt carrying the
  // intent, the findings and the diff. Over the budget it must NOT go in argv.
  expect(promptFitsArgv("x".repeat(ARGV_PROMPT_BUDGET + 1))).toBe(false);
  // The other args share the budget, so a big schema pushes a borderline prompt over.
  const borderline = "x".repeat(ARGV_PROMPT_BUDGET - 100);
  expect(promptFitsArgv(borderline)).toBe(true);
  expect(promptFitsArgv(borderline, ["y".repeat(200)])).toBe(false);
});

test("--instructions takes text directly or @file, and says why a bad path failed", () => {
  expect(readInstructions("keep the fix minimal")).toBe("keep the fix minimal");
  expect(readInstructions("")).toBe("");

  const path = join(DIR, "notes.txt");
  // Multi-line with quotes: exactly what a command line mangles and a file does not.
  writeFileSync(path, "line one\n\"quoted\" and 'single'\nline three\n");
  expect(readInstructions(`@${path}`)).toBe("line one\n\"quoted\" and 'single'\nline three");

  expect(() => readInstructions("@")).toThrow(/needs a file path/);
  // The error must name the path, not just "ENOENT".
  expect(() => readInstructions(`@${join(DIR, "missing.txt")}`)).toThrow(/missing\.txt/);
});

test("axi merge validates the method before it can touch a repository", async () => {
  // The guard that matters: an unknown method must be rejected as usage, not passed
  // to the provider, and never after the command has already started merging.
  let out = "";
  const io = { stdout: (s: string) => { out += s; }, stderr: () => {} };
  const daemon = { ensureDaemon: async () => {}, isDaemonRunning: async () => false };

  const code = await runAxi(["merge", "--method", "octopus"], { io, daemon });
  expect(code).toBe(2);
  expect(out).toContain("unknown merge method");
  expect(out).toContain("squash");

  // And the command is documented where an agent looks for it.
  expect(axiSubcommandHelp("merge")).toContain("usage: enigma gate axi merge");
  expect(axiSubcommandHelp("merge")).toContain("--force");
  expect(axiSubcommandHelp("run")).toContain("--merge");

  // The user's "merge it" outlives the invocation that carried it: under the
  // default assisted policy the drive that reaches CI-green is a `respond`, so the
  // flag has to exist there too or the instruction is silently dropped.
  expect(axiSubcommandHelp("respond")).toContain("--merge");
  out = "";
  const respondCode = await runAxi(["respond", "--merge"], { io, daemon });
  expect(respondCode).toBe(2);
  expect(out).toContain("--action is required");
});

test("axi merge refuses a run id that belongs to another repository", async () => {
  // The gate database is global, so a run id from any checkout on the machine
  // resolves here - but the provider slug comes from the CURRENT repo, so merging
  // it would land PR #N of the wrong repository, and no flag undoes that.
  const paths = Paths.withRoot(join(DIR, "cross-repo"));
  paths.ensureDirs();
  const db = new Database(paths.db());
  insertRepo(db, findGitRoot("."), "https://github.com/acme/here.git", "main");
  const other = insertRepo(db, join(DIR, "elsewhere"), "https://github.com/acme/there.git", "main");
  const foreign = insertRun(db, other.id, "feature", "a".repeat(40), "b".repeat(40));
  updateRunPRURL(db, foreign.id, "https://github.com/acme/there/pull/7");
  db.close();

  let out = "";
  const io = { stdout: (s: string) => { out += s; }, stderr: () => {} };
  const daemon = { ensureDaemon: async () => {}, isDaemonRunning: async () => false };

  const code = await runAxi(["merge", "--run", foreign.id], { io, daemon, paths });
  expect(code).toBe(1);
  expect(out).toContain("belongs to another repository");
  // And nothing about the other repo's PR was acted on.
  expect(out).not.toContain("merged");
});

test("--help prints usage for every subcommand instead of running it", () => {
  // The regression that made this necessary: `enigma gate rerun --help` started a rerun.
  expect(gateSubcommandHelp("rerun")).toContain("usage: enigma gate rerun");
  expect(gateSubcommandHelp("init")).toContain("usage: enigma gate init");
  expect(gateSubcommandHelp("nonsense")).toContain("usage: enigma gate <init|");
  // And `axi run --help` answered "unknown flag --help" - the command /gate tells agents to run.
  expect(axiSubcommandHelp("run")).toContain("--intent");
  expect(axiSubcommandHelp("respond")).toContain("@<file>");
  expect(axiSubcommandHelp("nonsense")).toContain("usage: enigma gate axi");
});
