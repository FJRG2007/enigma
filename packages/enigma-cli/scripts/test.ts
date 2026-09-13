/**
 * Run the test suite the way it is written: ONE PROCESS PER FILE.
 *
 * Every test file isolates itself by pointing HOME / USERPROFILE / ENIGMA_CONFIG_HOME at a
 * scratch dir BEFORE importing the module under test, because several modules resolve their
 * paths once at import (accounts.ts freezes the registry path, agents.ts freezes HOME). That
 * isolation is a per-process contract, and each file's header documents the per-file command.
 *
 * A bare `bun test` breaks it: all 87 files load into one process, the last assignment to those
 * shared variables wins, and files then read each other's temp homes. Measured here, that is 15
 * failures - every one of which passes when its file is run on its own, so the failures say
 * nothing about the code under test. Hence this runner rather than a suite-wide refactor: the
 * isolation the files already have is correct, it just has to be given a process each.
 *
 * Usage: bun scripts/test.ts [pattern]   - pattern filters by path substring.
 */

import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";

const TESTS = "tests";

/** Every *.test.ts under `dir`, recursively (the gate suite lives in a subdirectory). */
function testFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...testFiles(path));
        else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(path);
    }
    return out;
}

const pattern = process.argv[2];
const files = testFiles(TESTS)
    .map((f) => f.split(sep).join("/"))
    .filter((f) => !pattern || f.includes(pattern))
    .sort();

if (files.length === 0) {
    process.stderr.write(`No test files${pattern ? ` matching '${pattern}'` : ""}.\n`);
    process.exit(1);
}

/**
 * Per-test timeout, generous on purpose. The slowest suites build a real git repository per
 * case and were carrying this as a hand-written CI flag; a hang is still bounded by the job's
 * own timeout, so the only thing a tight limit buys here is a flake on a slow runner.
 */
const TIMEOUT_MS = 90_000;

const failed: string[] = [];
for (const file of files) {
    // Windows resolves `bun` through a shim rather than an .exe, which spawn only finds via the
    // shell - the same rule accounts.ts follows for the agent binaries.
    const run = spawnSync("bun", ["test", file, "--timeout", String(TIMEOUT_MS)], { stdio: "inherit", shell: process.platform === "win32" });
    if (run.status !== 0) failed.push(file);
}

process.stdout.write(`\n${files.length - failed.length}/${files.length} test file(s) passed.\n`);
if (failed.length > 0) {
    process.stdout.write(`Failed:\n${failed.map((f) => `  ${f}`).join("\n")}\n`);
    process.exit(1);
}
