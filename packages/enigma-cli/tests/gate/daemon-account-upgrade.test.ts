/**
 * Per-run accounts only hold if the daemon serving the run applies them. An upgrade
 * leaves the previous binary's daemon running, and it ignores the account snapshot, so
 * the client must replace it - or refuse when replacing would cancel someone's run -
 * and the daemon must refuse a request that carries no snapshot at all.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gateDb from "@/gate/db";
import { Paths } from "@/gate/paths";
import { Server } from "@/gate/ipc/server";
import { Client } from "@/gate/ipc/client";
import * as proto from "@/gate/ipc/protocol";
import * as accountEnv from "@/gate/account-env";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";
import { RunManager } from "@/gate/daemon/manager";
import { ensureDaemon, isDaemonRunning, OutdatedDaemonError } from "@/gate/cli/daemonCmd";

const ROOT = mkdtempSync(join(tmpdir(), "enigma-gate-account-upgrade-"));

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** Serves health on the gate socket like a daemon that does (or does not) honor accounts. */
function fakeDaemon(paths: Paths, honorsAccounts: boolean): Server {
    const srv = new Server();
    srv.handle(proto.MethodHealth, () => honorsAccounts ? { status: "ok", account_env: true } : { status: "ok" });
    srv.handle(proto.MethodShutdown, () => {
        setTimeout(() => srv.close(), 10);
        return { ok: true };
    });
    void srv.serve(paths.socket());
    return srv;
}

async function honorsAccounts(paths: Paths): Promise<boolean> {
    const client = await Client.dial(paths.socket());
    try {
        return (await client.healthInfo()).accountEnv;
    } finally {
        client.close();
    }
}

test("an outdated daemon with active runs is refused, not reused", async () => {
    const paths = Paths.withRoot(join(ROOT, "busy"));
    paths.ensureDirs();
    const db = new gateDb.Database(paths.db());
    const repo = gateDb.insertRepo(db, join(ROOT, "busy-repo"), "", "main");
    const run = gateDb.insertRun(db, repo.id, "feature", "a".repeat(40), "b".repeat(40));
    gateDb.updateRunStatus(db, run.id, "running");
    db.close();
    const old = fakeDaemon(paths, false);
    try {
        await Bun.sleep(50);
        const attempt = ensureDaemon(paths, () => { throw new Error("must not start a second daemon"); });
        await expect(attempt).rejects.toBeInstanceOf(OutdatedDaemonError);
        await expect(ensureDaemon(paths, () => 0)).rejects.toThrow(run.id);
        expect(await honorsAccounts(paths)).toBe(false);
    } finally {
        old.close();
    }
});

/** A PID no process can hold, so the start wait reports the child as gone at once. */
const DEAD_PID = 0x7ffffffe;

test("an idle outdated daemon is stopped and a new one is spawned", async () => {
    const paths = Paths.withRoot(join(ROOT, "idle"));
    paths.ensureDirs();
    const old = fakeDaemon(paths, false);
    await Bun.sleep(50);
    let spawned = false;
    try {
        // A real replacement is a separate process; Bun cannot re-listen on the same named
        // pipe within one process on Windows, so the spawn is observed rather than served.
        const attempt = ensureDaemon(paths, () => {
            spawned = true;
            return DEAD_PID;
        });
        await expect(attempt).rejects.toThrow("exited while starting up");
        expect(spawned, "the outdated daemon was reused instead of replaced").toBe(true);
        expect(await isDaemonRunning(paths)).toBe(false);
    } finally {
        old.close();
    }
});

test("a daemon that honors accounts is reused as-is", async () => {
    const paths = Paths.withRoot(join(ROOT, "current"));
    paths.ensureDirs();
    const current = fakeDaemon(paths, true);
    try {
        await Bun.sleep(50);
        await ensureDaemon(paths, () => { throw new Error("must not start a second daemon"); });
        expect(await honorsAccounts(paths)).toBe(true);
    } finally {
        current.close();
    }
});

test("the daemon refuses a push or rerun without the pusher's account", async () => {
    const paths = Paths.withRoot(join(ROOT, "manager"));
    paths.ensureDirs();
    const db = new gateDb.Database(paths.db());
    try {
        const mgr = new RunManager(db, paths);
        const push = mgr.handlePushReceived({ gate: join(ROOT, "x.git"), ref: "refs/heads/main", old: "a".repeat(40), new: "b".repeat(40) });
        await expect(push).rejects.toThrow("no account snapshot");
        await expect(mgr.handleRerun("repo", "main", [], "")).rejects.toThrow("no account snapshot");
    } finally {
        db.close();
    }
});

test("health advertises account support only when the daemon says so", () => {
    expect(proto.decodeHealthResult({ status: "ok" }).accountEnv).toBe(false);
    expect(proto.decodeHealthResult({ status: "ok", account_env: true }).accountEnv).toBe(true);
});

test("a push to a daemon that does not know a set variable is resent without it", async () => {
    const paths = Paths.withRoot(join(ROOT, "older-keys"));
    paths.ensureDirs();
    const received: Record<string, unknown>[] = [];
    const srv = new Server();
    for (const method of [proto.MethodPushReceived, proto.MethodRerun]) {
        srv.handle(method, (params) => {
            const wire = (params as { account_env: Record<string, unknown>; }).account_env;
            received.push(wire);
            if ("ANTHROPIC_CONFIG_DIR" in wire) throw new Error("account_env: unsupported variable \"ANTHROPIC_CONFIG_DIR\"");
            return { run_id: "run-1" };
        });
    }
    void srv.serve(paths.socket());
    const accountDir = join(ROOT, "managed");
    const snapshot = { CLAUDE_CONFIG_DIR: accountDir, ANTHROPIC_CONFIG_DIR: join(accountDir, "anthropic"), CODEX_HOME: null };
    try {
        await Bun.sleep(50);
        const client = await Client.dial(paths.socket());
        try {
            expect(await client.pushReceived({ gate: "g", ref: "r", old: "o", new: "n", accountEnv: snapshot })).toBe("run-1");
            expect(await client.rerun({ repoId: "repo", branch: "main", accountEnv: snapshot })).toBe("run-1");
            expect(received).toEqual([
                { CLAUDE_CONFIG_DIR: accountDir, ANTHROPIC_CONFIG_DIR: join(accountDir, "anthropic") },
                { CLAUDE_CONFIG_DIR: accountDir },
                { CLAUDE_CONFIG_DIR: accountDir, ANTHROPIC_CONFIG_DIR: join(accountDir, "anthropic") },
                { CLAUDE_CONFIG_DIR: accountDir }
            ]);
        } finally {
            client.close();
        }
    } finally {
        srv.close();
    }
});

test("any other daemon error is not retried", () => {
    const env = { CLAUDE_CONFIG_DIR: join(ROOT, "managed") };
    expect(accountEnv.withoutUnsupportedKey(env, "account_env: \"CLAUDE_CONFIG_DIR\" must be an absolute path or null")).toBeNull();
    expect(accountEnv.withoutUnsupportedKey(env, "account_env: unsupported variable \"PATH\"")).toBeNull();
    expect(accountEnv.withoutUnsupportedKey(env, "account_env: unsupported variable \"CLAUDE_CONFIG_DIR\"")).toEqual({});
});
