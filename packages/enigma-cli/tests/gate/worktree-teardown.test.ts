/**
 * What a finished gate run is allowed to leave on disk.
 *
 * Every run gets a brand-new worktree path that is never revisited, so anything the
 * teardown misses accumulates one directory per run, forever. Three things were
 * missed: the per-repository directory holding the worktrees (removed with unlink,
 * which cannot remove a directory, so it failed silently inside a catch), the bare
 * repo's administrative entry for a worktree the fallback path deleted directly, and
 * whatever the agent kept in the machine's temp dir keyed by that unique working
 * directory - state no agent ever comes back for.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";

const ROOT = mkdtempSync(join(tmpdir(), "enigma-gate-teardown-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const { Paths } = await import("../../src/gate/paths");
const { gitSafeEnv } = await import("../../src/gate/agent/env");
const { removeOrphanedWorktrees } = await import("../../src/gate/daemon/daemon");

test("startup recovery leaves no per-repository directory or run temp dir behind", async () => {
    const paths = Paths.withRoot(join(ROOT, "recovery"));
    paths.ensureDirs();
    const repoID = "abc123def456";
    const runID = "01TESTRUNID0000000000000000";
    const worktree = paths.worktreeDir(repoID, runID);
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "tracked.txt"), "content\n");
    mkdirSync(join(paths.agentTmpDir(repoID, runID), "session"), { recursive: true });

    await removeOrphanedWorktrees(paths);

    expect(existsSync(worktree), "the worktree survived recovery").toBe(false);
    // The regression: unlink cannot remove a directory, so this one used to stay forever
    // and one empty directory per repository piled up under worktrees/.
    expect(
        existsSync(join(paths.worktreesDir(), repoID)),
        "the per-repository directory survived recovery"
    ).toBe(false);
    expect(existsSync(paths.agentTmpRoot()), "a finished run's temp dir survived recovery").toBe(false);
    // The roots themselves are layout, not leftovers.
    expect(existsSync(paths.worktreesDir()), "the worktrees root must not be removed").toBe(true);
});

test("only a gate worktree path maps to a private temp dir", () => {
    const paths = Paths.withRoot(join(ROOT, "mapping"));

    expect(paths.agentTmpDirForWorktree(paths.worktreeDir("repo", "run"))).toBe(paths.agentTmpDir("repo", "run"));
    expect(paths.agentTmpDirForWorktree(""), "an empty path").toBeNull();
    expect(paths.agentTmpDirForWorktree(paths.worktreesDir()), "the worktrees root itself").toBeNull();
    // Someone's own checkout keeps the machine's temp dir: it is not ours to redirect.
    expect(paths.agentTmpDirForWorktree(join(ROOT, "a-real-checkout")), "a path outside the gate").toBeNull();
    // One level deeper is a directory inside a worktree, not a worktree.
    expect(
        paths.agentTmpDirForWorktree(join(paths.worktreeDir("repo", "run"), "src")),
        "a path inside a worktree"
    ).toBeNull();
});

test("an agent in a gate worktree gets the run's own temp dir, and only once it exists", () => {
    const root = join(ROOT, "env");
    const paths = Paths.withRoot(root);
    const worktree = paths.worktreeDir("repo", "run");
    const runTmp = paths.agentTmpDir("repo", "run");
    mkdirSync(worktree, { recursive: true });

    const previous = process.env.ENIGMA_GATE_HOME;
    process.env.ENIGMA_GATE_HOME = root;
    try {
        // Pointing a child at a temp dir that does not exist breaks every tool that
        // writes a temp file, which is worse than the leak the redirect prevents.
        expect(gitSafeEnv(worktree).TMPDIR, "redirected before the run provisioned it").not.toBe(runTmp);

        mkdirSync(runTmp, { recursive: true });
        const env = gitSafeEnv(worktree);
        expect(env.TMPDIR).toBe(runTmp);
        expect(env.TEMP).toBe(runTmp);
        expect(env.TMP).toBe(runTmp);

        // An agent launched anywhere else keeps whatever the machine gave it.
        expect(gitSafeEnv(join(ROOT, "elsewhere")).TEMP, "redirected outside a gate worktree").toBe(process.env.TEMP);
    } finally {
        if (previous === undefined) delete process.env.ENIGMA_GATE_HOME;
        else process.env.ENIGMA_GATE_HOME = previous;
    }
});
