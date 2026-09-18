/**
 * A gate run's agents must authenticate as the account that pushed the run, never as
 * whichever session happened to start the shared daemon. The pusher's snapshot travels
 * over IPC and is applied to every child spawned inside the run's worktree.
 */
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { join, resolve } from "node:path";
import * as proto from "@/gate/ipc/protocol";
import * as accountEnv from "@/gate/account-env";
import { spawnConfigured } from "@/gate/shellenv";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";

const PUSHER_DIR = resolve(tmpdir(), "enigma-test-pusher-account");
const DAEMON_DIR = resolve(tmpdir(), "enigma-test-daemon-account");

test("captureAccountEnv covers every tool's account variable and maps unset to null", () => {
    const snapshot = accountEnv.captureAccountEnv({ CLAUDE_CONFIG_DIR: PUSHER_DIR, CODEX_HOME: "  " });
    for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "KIMI_CODE_HOME"]) {
        expect(Object.keys(snapshot)).toContain(key);
    }
    expect(snapshot.CLAUDE_CONFIG_DIR).toBe(PUSHER_DIR);
    expect(snapshot.CODEX_HOME).toBeNull();
    expect(snapshot.KIMI_CODE_HOME).toBeNull();
});

test("decodeAccountEnv rejects malformed snapshots and treats omitted variables as unset", () => {
    expect(accountEnv.decodeAccountEnv(undefined)).toBeUndefined();
    const decoded = accountEnv.decodeAccountEnv({ CLAUDE_CONFIG_DIR: PUSHER_DIR });
    expect(decoded?.CLAUDE_CONFIG_DIR).toBe(PUSHER_DIR);
    expect(decoded?.CODEX_HOME).toBeNull();
    expect(() => accountEnv.decodeAccountEnv({ PATH: PUSHER_DIR })).toThrow("unsupported variable");
    expect(() => accountEnv.decodeAccountEnv({ CLAUDE_CONFIG_DIR: "relative/dir" })).toThrow("absolute path");
    expect(() => accountEnv.decodeAccountEnv({ CLAUDE_CONFIG_DIR: 42 })).toThrow("absolute path");
    expect(() => accountEnv.decodeAccountEnv(["x"])).toThrow("must be an object");
});

test("push and rerun params carry the snapshot across the wire", () => {
    const snapshot = accountEnv.captureAccountEnv({ CLAUDE_CONFIG_DIR: PUSHER_DIR });
    const push = proto.decodePushReceivedParams(JSON.parse(JSON.stringify(proto.encodePushReceivedParams({
        gate: "/g", ref: "refs/heads/main", old: "a", new: "b", accountEnv: snapshot
    }))));
    expect(push.accountEnv).toEqual(snapshot);
    const rerun = proto.decodeRerunParams(JSON.parse(JSON.stringify(proto.encodeRerunParams({
        repoId: "r", branch: "main", accountEnv: snapshot
    }))));
    expect(rerun.accountEnv).toEqual(snapshot);
    expect(proto.decodeRerunParams({ repo_id: "r", branch: "main" }).accountEnv).toBeUndefined();
});

test("withRunAccountEnv overrides and removes account variables only inside the run's worktree", () => {
    const worktree = resolve(tmpdir(), "enigma-test-worktrees", "repo", "run");
    const base = { CLAUDE_CONFIG_DIR: DAEMON_DIR, CODEX_HOME: DAEMON_DIR, PATH: "p" };
    accountEnv.registerRunAccountEnv(worktree, accountEnv.captureAccountEnv({ CLAUDE_CONFIG_DIR: PUSHER_DIR }));
    try {
        const inside = accountEnv.withRunAccountEnv(join(worktree, "sub"), base);
        expect(inside.CLAUDE_CONFIG_DIR).toBe(PUSHER_DIR);
        expect("CODEX_HOME" in inside).toBe(false);
        expect(inside.PATH).toBe("p");
        expect(accountEnv.withRunAccountEnv(`${worktree}-other`, base)).toBe(base);
    } finally {
        accountEnv.unregisterRunAccountEnv(worktree);
    }
    expect(accountEnv.withRunAccountEnv(worktree, base)).toBe(base);
});

/** Spawns a child in `cwd` through the gate's spawn chokepoint and returns its CLAUDE_CONFIG_DIR. */
function childConfigDir(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((done, fail) => {
        const child = spawnConfigured(process.execPath, ["-e", "process.stdout.write(process.env.CLAUDE_CONFIG_DIR ?? '<unset>')"], {
            cwd, env, stdio: ["ignore", "pipe", "inherit"]
        });
        let out = "";
        child.stdout?.on("data", chunk => { out += chunk; });
        child.once("error", fail);
        child.once("exit", () => done(out));
    });
}

test("a spawned agent gets the pusher's account, not the daemon's", async () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-account-env-"));
    const worktree = join(root, "run");
    mkdirSync(worktree);
    const daemonEnv = { ...process.env, CLAUDE_CONFIG_DIR: DAEMON_DIR };
    try {
        accountEnv.registerRunAccountEnv(worktree, accountEnv.captureAccountEnv({ CLAUDE_CONFIG_DIR: PUSHER_DIR }));
        expect(await childConfigDir(worktree, daemonEnv)).toBe(PUSHER_DIR);

        // A pusher on the tool's default account: the daemon's managed dir must not leak.
        accountEnv.registerRunAccountEnv(worktree, accountEnv.captureAccountEnv({}));
        expect(await childConfigDir(worktree, daemonEnv)).toBe("<unset>");

        accountEnv.unregisterRunAccountEnv(worktree);
        expect(await childConfigDir(worktree, daemonEnv)).toBe(DAEMON_DIR);
    } finally {
        accountEnv.unregisterRunAccountEnv(worktree);
        rmSync(root, { recursive: true, force: true });
    }
});
