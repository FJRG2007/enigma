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
 *
 * Eject is the same question asked once per repository rather than once per run, and
 * it is the last owner of everything that repository holds: once the record is gone,
 * no later teardown knows the directories existed.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { test, expect, afterAll, setDefaultTimeout } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";

// The eject test drives the real git CLI, and process spawn is the slow part on
// Windows; bun's 5s default is fine on an idle machine and not on a loaded one.
setDefaultTimeout(60_000);

const ROOT = mkdtempSync(join(tmpdir(), "enigma-gate-teardown-"));
// Windows keeps a handle on SQLite's WAL files a moment after close, so cleanup is
// best-effort: the OS reclaims a temp dir on its own, and failing here would report a
// passing suite as broken.
afterAll(() => {
    try {
        rmSync(ROOT, { recursive: true, force: true });
    } catch { /* the OS reclaims a temp dir on its own */ }
});

const { Paths } = await import("../../src/gate/paths");
const { eject } = await import("../../src/gate/init");
const { findMainRepoRoot } = await import("../../src/gate/git");
const { RunManager } = await import("../../src/gate/daemon/manager");
const { Database, getRepoByPath, insertRepoWithIDAndFork } = await import("../../src/gate/db");
const { gitSafeEnv, setAgentTmpPaths } = await import("../../src/gate/agent/env");
const { removeOrphanedWorktrees } = await import("../../src/gate/daemon/daemon");

/** Reaches the teardown a run reaches through its pipeline's finally block. */
function releaseWorktreeOf(paths: InstanceType<typeof Paths>) {
    const db = new Database(paths.db());
    const mgr = new RunManager(db, paths);
    const manager = mgr as unknown as {
        releaseWorktree(gateDir: string, wtDir: string, phase: string): Promise<void>;
    };
    return {
        release: (wtDir: string): Promise<void> => manager.releaseWorktree(paths.repoDir("repo"), wtDir, "test"),
        close: (): void => db.close()
    };
}

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

    // The redirect follows the layout the daemon pinned, never the ambient one: the
    // daemon picks its root and only then applies the login shell's environment, so a
    // profile exporting ENIGMA_GATE_HOME would otherwise aim the child at a temp dir
    // this daemon never created and never reclaims.
    const previous = process.env.ENIGMA_GATE_HOME;
    process.env.ENIGMA_GATE_HOME = join(ROOT, "another-gate-home");
    setAgentTmpPaths(paths);
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
        setAgentTmpPaths(null);
        if (previous === undefined) delete process.env.ENIGMA_GATE_HOME;
        else process.env.ENIGMA_GATE_HOME = previous;
    }
});

test("a worktree git refuses to remove is deleted anyway, and only inside the layout", async () => {
    const paths = Paths.withRoot(join(ROOT, "fallback"));
    paths.ensureDirs();
    const worktree = paths.worktreeDir("repo", "run");
    const runTmp = paths.agentTmpDir("repo", "run");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src", "tracked.txt"), "content\n");
    mkdirSync(runTmp, { recursive: true });
    const { release, close } = releaseWorktreeOf(paths);

    try {
        // `git worktree remove` cannot succeed here - there is no bare repo to remove it
        // from - which is how the failure that routinely happens on Windows presents. The
        // run's directory would otherwise sit there until the next daemon start.
        await release(worktree);
        expect(existsSync(worktree), "a worktree git refused to remove survived teardown").toBe(false);
        expect(existsSync(runTmp), "the run's private temp dir survived teardown").toBe(false);

        // Teardown runs in a finally block and can be reached twice.
        await release(worktree);

        // Deleting outright is confined to a path that is exactly one run's directory:
        // anything else keeps whatever `git worktree remove` decided about it.
        const foreign = join(ROOT, "fallback-foreign");
        mkdirSync(foreign, { recursive: true });
        await release(foreign);
        expect(existsSync(foreign), "teardown deleted a path outside the worktrees layout").toBe(true);
    } finally {
        close();
    }
});

test("eject leaves nothing of the repo under the gate root", async () => {
    const paths = Paths.withRoot(join(ROOT, "eject"));
    paths.ensureDirs();
    const checkout = join(ROOT, "eject-checkout");
    mkdirSync(checkout, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout, stdio: "ignore" });
    // The record has to be keyed the way eject looks it up, which is the resolved root.
    const absRoot = findMainRepoRoot(checkout);

    const db = new Database(paths.db());
    try {
        const repoID = "ejec70000001";
        const runID = "01EJECTRUNID00000000000000";
        insertRepoWithIDAndFork(db, repoID, absRoot, "https://example.invalid/o/r.git", "", "main");
        mkdirSync(paths.repoDir(repoID), { recursive: true });
        mkdirSync(paths.worktreeDir(repoID, runID), { recursive: true });
        mkdirSync(join(paths.agentTmpDir(repoID, runID), "session"), { recursive: true });

        await eject(db, paths, checkout);

        expect(existsSync(paths.repoDir(repoID)), "the bare repo survived eject").toBe(false);
        expect(existsSync(join(paths.worktreesDir(), repoID)), "the repo's worktrees survived eject").toBe(false);
        // The one nothing else can reclaim: with the record deleted, no later teardown
        // knows this repo ever had a temp tree.
        expect(existsSync(join(paths.agentTmpRoot(), repoID)), "the repo's agent temp dirs survived eject").toBe(false);
        expect(getRepoByPath(db, absRoot), "the repo record survived eject").toBeNull();
        // The roots themselves are layout, not leftovers.
        expect(existsSync(paths.agentTmpRoot()), "the temp root must not be removed").toBe(true);
    } finally {
        db.close();
    }
});
