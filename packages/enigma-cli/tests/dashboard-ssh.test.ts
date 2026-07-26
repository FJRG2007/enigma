/**
 * Dashboard SSH bridge: the shaping + action layer the loopback server calls. A temp
 * ENIGMA_CONFIG_HOME (set BEFORE import) isolates the ssh.json store and the secret-box key,
 * and no ssh is ever spawned - connect/tunnel only build the command string.
 * Must run under Bun: bun test tests/dashboard-ssh.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";

const HOME = mkdtempSync(join(tmpdir(), "enigma-dash-ssh-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const { applySshAction, listSshData } = await import("../src/dashboard-ssh");
const ssh = await import("../src/ssh");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("add saves a connection and every refresh carries the reserved keys", async () => {
  const res = await applySshAction("add", { alias: "lirio-0", serverName: "lirio-prod", host: "1.2.3.4", user: "root", port: 2222 });
  expect(res.ok).toBe(true);
  expect(res.connections?.[0]?.alias).toBe("lirio-0");
  expect(res.reserved?.connection).toContain("tunnel");
  expect(listSshData().reserved.connection).toEqual(ssh.RESERVED_CONNECTION_KEYS);
});

test("a blanked Port field really clears the stored port", async () => {
  expect(ssh.getConnection("lirio-0")!.port).toBe(2222);
  // The form sends 0 for a blank Port while editing; omitting it means "leave as-is".
  const kept = await applySshAction("edit", { alias: "lirio-0", host: "1.2.3.4" });
  expect(kept.ok).toBe(true);
  expect(ssh.getConnection("lirio-0")!.port).toBe(2222);
  const cleared = await applySshAction("edit", { alias: "lirio-0", host: "1.2.3.4", port: 0 });
  expect(cleared.ok).toBe(true);
  expect(ssh.getConnection("lirio-0")!.port).toBeUndefined();
});

test("an out-of-range port is refused instead of silently clearing the stored one", async () => {
  await applySshAction("edit", { alias: "lirio-0", port: 2222 });
  const res = await applySshAction("edit", { alias: "lirio-0", port: 70000 });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("65535");
  expect(ssh.getConnection("lirio-0")!.port).toBe(2222);
});

test("a non-numeric port from a non-UI caller is refused, not read as a clear", async () => {
  // The form always sends a number or 0, but /api/ssh accepts any JSON: null, false and [] all
  // coerce to 0, which must not wipe the stored port behind an "Updated ..." reply.
  await applySshAction("edit", { alias: "lirio-0", port: 2222 });
  for (const bad of [null, false, [], "abc"]) {
    const res = await applySshAction("edit", { alias: "lirio-0", port: bad as never });
    expect(res.ok).toBe(false);
    expect(ssh.getConnection("lirio-0")!.port).toBe(2222);
  }
});

test("edit and remove work with the connection's name, like connect does", async () => {
  const edited = await applySshAction("edit", { alias: "lirio-prod", user: "deploy" });
  expect(edited.ok).toBe(true);
  expect(ssh.getConnection("lirio-0")!.user).toBe("deploy");
  await applySshAction("add", { alias: "tmp-0", serverName: "tmp-prod", host: "h" });
  const removed = await applySshAction("remove", { alias: "tmp-prod" });
  expect(removed.ok).toBe(true);
  expect(ssh.getConnection("tmp-0")).toBeNull();
});

test("a reserved alias is refused with the CLI's own wording", async () => {
  const res = await applySshAction("add", { alias: "tunnel", host: "h" });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("enigma ssh");
});

test("forwards can be managed with the connection's name as the key", async () => {
  const added = await applySshAction("forward-add", { alias: "lirio-prod", spec: "9090:db:5432", name: "pg" });
  expect(added.ok).toBe(true);
  expect(ssh.getConnection("lirio-0")!.forwards).toHaveLength(1);
  const removed = await applySshAction("forward-remove", { alias: "lirio-prod", index: 0 });
  expect(removed.ok).toBe(true);
  expect(ssh.getConnection("lirio-0")!.forwards).toBeUndefined();
});

test("a forward named after a tunnel operation is refused", async () => {
  const res = await applySshAction("forward-add", { alias: "lirio-0", spec: "9090:5432", name: "start" });
  expect(res.ok).toBe(false);
  expect(res.error).toContain("enigma ssh tunnel");
});

test("connect and tunnel return the command the browser cannot spawn", async () => {
  const res = await applySshAction("connect", { alias: "lirio-0" });
  expect(res.command).toBe("enigma ssh lirio-0");
  expect((await applySshAction("tunnel", { alias: "lirio-0" })).command).toBe("enigma ssh tunnel lirio-0");
  expect((await applySshAction("connect", { alias: "nope" })).ok).toBe(false);
  expect((await applySshAction("bogus", {})).error).toContain("unknown action");
});
