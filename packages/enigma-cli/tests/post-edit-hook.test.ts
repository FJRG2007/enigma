/**
 * The merged post-edit hook at runtime: one process running trim, guardrails and the graph's blast
 * radius in a stated order, driven the way the host drives it - payload on stdin, exit code out.
 *
 * Three things are load-bearing and each has a test:
 *  - every step is gated on its OWN toggle, because one settings.json entry cannot encode three;
 *  - the trimmer runs BEFORE the readers. As three separate entries the host was free to run them
 *    concurrently, so guardrails could scan the file either side of the rewrite and nothing
 *    declared a winner; the merge is what made an order exist, so the order is what to guard;
 *  - a guardrails BLOCK still exits 2, which is the channel Claude Code feeds back to the model.
 *    Losing that would turn a gate into a silent no-op, which is the worst way for this to break.
 *
 * The code graph is off throughout: it is the slow step and none of the above depends on it.
 */
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = mkdtempSync(join(tmpdir(), "enigma-post-edit-hook-"));
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    delete process.env.ENIGMA_CONFIG_HOME;
});

/** Set the three post-edit toggles in the global .enigma.json the hook reads. */
function toggles(trim: boolean, guardrails: boolean): void {
    writeFileSync(join(HOME, ".enigma.json"), JSON.stringify({ trim, guardrails, codeGraph: false }));
}

/**
 * Run the hook the way the host does: the PostToolUse payload on stdin.
 *
 * The child's config home is passed explicitly rather than left to inheritance. Assigning
 * process.env in the parent is not enough to steer it, and the failure is silent and misleading -
 * the hook reads the REAL ~/.enigma.json, so the toggles under test are whatever the machine
 * running the suite happens to have, and the assertions pass or fail for the wrong reason.
 */
function hook(file: string): { status: number; stderr: string; } {
    const run = spawnSync(process.execPath, [join(ROOT, "src", "bin", "enigma.ts"), "__post-edit-hook"], {
        encoding: "utf8",
        input: JSON.stringify({ tool_input: { file_path: file } }),
        windowsHide: true,
        env: { ...process.env, HOME, USERPROFILE: HOME, ENIGMA_CONFIG_HOME: HOME },
    });
    return { status: run.status ?? 0, stderr: run.stderr || "" };
}

/**
 * Per-test budget. Each case starts a real CLI process, and that is the cost this whole feature is
 * about: measured at ~100 ms warm but 0.8-3.3 s cold on Windows with Defender scanning the runtime.
 * The default 5 s times out on a cold box and reads as a broken test rather than a slow one.
 */
const TIMEOUT = 30_000;

/** A file with the trailing blank line an agent's write tool leaves behind. */
function withTrailingBlank(name: string, body: string): string {
    const path = join(HOME, name);
    writeFileSync(path, `${body}\n\n`);
    return path;
}

test("trims the file the write tool padded, and exits 0", () => {
    toggles(true, false);
    const file = withTrailingBlank("a.ts", "export const a = 1;");
    expect(hook(file).status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("export const a = 1;\n");
}, TIMEOUT);

test("each step is gated on its own toggle", () => {
    // With trim off the file must come back byte for byte: the entry is still installed (guardrails
    // or the graph may want it), so the toggle is the only thing standing between them.
    toggles(false, false);
    const file = withTrailingBlank("b.ts", "export const b = 2;");
    expect(hook(file).status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("export const b = 2;\n\n");
}, TIMEOUT);

test("a guardrails BLOCK exits 2, and the trimmer has already run", () => {
    toggles(true, true);
    // db-uuid-pk: an auto-increment primary key in a .sql file is a block-severity violation.
    const file = withTrailingBlank("schema.sql", "CREATE TABLE users (id SERIAL PRIMARY KEY);");
    const run = hook(file);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("guardrails");
    // The order assertion. The trimmer writes and the scanner reads, so the write has to land
    // first; a concurrent pair could do this either way round and did, before the merge.
    expect(readFileSync(file, "utf8")).toBe("CREATE TABLE users (id SERIAL PRIMARY KEY);\n");
}, TIMEOUT);

test("a clean file passes both steps without a finding", () => {
    toggles(true, true);
    const file = withTrailingBlank("clean.sql", "CREATE TABLE users (id UUID PRIMARY KEY);");
    expect(hook(file).status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("CREATE TABLE users (id UUID PRIMARY KEY);\n");
}, TIMEOUT);
