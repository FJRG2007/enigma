/**
 * Standalone SSH tunnels: CRUD, server binding/rebinding, and live-status logic. Temp
 * ENIGMA_CONFIG_HOME (set BEFORE import) isolates the tunnel store, the run-state file and the
 * connection store. start/stop spawn a real `ssh -N`, so they are verified manually, not here -
 * this covers everything that does not spawn (the state file is written directly to exercise the
 * liveness probe). Must run under Bun: bun test tests/ssh-tunnels.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-tun-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const ssh = await import("../src/ssh");
const tun = await import("../src/ssh-tunnels");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

// Two connections to bind tunnels to.
ssh.addConnection("srv1", { host: "1.1.1.1", user: "root", name: "srv1-prod" });
ssh.addConnection("srv2", { host: "2.2.2.2" });

test("addTunnel validates the name, server and spec", () => {
  expect(tun.addTunnel("", "srv1", "9090:5432").ok).toBe(false);       // empty name
  expect(tun.addTunnel("bad name", "srv1", "9090:5432").ok).toBe(false); // spaces
  expect(tun.addTunnel("pg", "nope", "9090:5432").ok).toBe(false);      // unknown server
  expect(tun.addTunnel("pg", "srv1", "notaport").ok).toBe(false);       // bad spec
  expect(tun.addTunnel("pg", "srv1", "9090:5432").ok).toBe(true);
  expect(tun.addTunnel("pg", "srv1", "9090:5432").ok).toBe(false);      // duplicate name
});

test("a tunnel binds to a server by alias or name and lists its spec/target", () => {
  tun.addTunnel("byname", "srv1-prod", "8080:80"); // bound via the connection's name
  const list = tun.listTunnels();
  const pg = list.find((t) => t.name === "pg")!;
  expect(pg.server).toBe("srv1");
  expect(pg.spec).toBe("9090:localhost:5432");
  expect(pg.target).toBe("root@1.1.1.1");
  expect(pg.active).toBe(false);
  expect(pg.missing).toBe(false);
  expect(list.find((t) => t.name === "byname")!.target).toBe("root@1.1.1.1");
});

test("updateTunnel re-points the server, changes the spec and renames", () => {
  expect(tun.updateTunnel("pg", { server: "srv2" }).ok).toBe(true);
  expect(tun.getTunnel("pg")!.server).toBe("srv2");
  expect(tun.updateTunnel("pg", { server: "ghost" }).ok).toBe(false); // unknown server
  expect(tun.updateTunnel("pg", { spec: "7000:db:5432" }).ok).toBe(true);
  expect(tun.getTunnel("pg")!.hostPort).toBe(5432);
  expect(tun.updateTunnel("pg", { newName: "byname" }).ok).toBe(false); // name taken
  expect(tun.updateTunnel("pg", { newName: "pgsql" }).ok).toBe(true);
  expect(tun.getTunnel("pgsql")).not.toBeNull();
  expect(tun.getTunnel("pg")).toBeNull();
});

test("tunnelActive reflects the run-state pid and cleans a dead one", () => {
  const statePath = join(HOME, "ssh-tunnels-state.json");
  // A live pid (this test process) -> active.
  writeFileSync(statePath, JSON.stringify({ pgsql: { pid: process.pid, startedAt: 1 } }));
  expect(tun.tunnelActive("pgsql")).toBe(true);
  expect(tun.listTunnels().find((t) => t.name === "pgsql")!.active).toBe(true);
  // A dead pid -> inactive, and the stale record is cleared.
  writeFileSync(statePath, JSON.stringify({ pgsql: { pid: 2147483646, startedAt: 1 } }));
  expect(tun.tunnelActive("pgsql")).toBe(false);
});

test("a tunnel bound to a deleted server is flagged missing", () => {
  tun.addTunnel("orphan", "srv2", "5000:5000");
  ssh.removeConnection("srv2");
  const orphan = tun.listTunnels().find((t) => t.name === "orphan")!;
  expect(orphan.missing).toBe(true);
  expect(orphan.target).toBe("");
  // Starting a tunnel whose server is gone fails with a clear error (no spawn).
  expect(tun.startTunnel("orphan").ok).toBe(false);
});

test("removeTunnel deletes and reports unknown names", () => {
  expect(tun.removeTunnel("pgsql")).toBe(true);
  expect(tun.removeTunnel("pgsql")).toBe(false);
});
