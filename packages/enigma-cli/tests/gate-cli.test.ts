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
const { axiSubcommandHelp } = await import("../src/gate/cli/axi");

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
