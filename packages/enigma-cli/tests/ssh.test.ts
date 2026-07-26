/**
 * SSH connection manager: the pure builders/parsers plus CRUD with encrypted passwords.
 * Temp ENIGMA_CONFIG_HOME (set BEFORE import) isolates both the ssh.json store and the
 * secret-box key file - no ssh is ever spawned. PATH is manipulated per-test to exercise
 * the launcher's helper detection (sshpass/plink) deterministically.
 * Must run under Bun: bun test tests/ssh.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-ssh-"));
const BIN = mkdtempSync(join(tmpdir(), "enigma-ssh-bin-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
const ORIGINAL_PATH = process.env.PATH || "";

const ssh = await import("../src/ssh");
const { isEncryptedSecret } = await import("../src/secret-box");

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(HOME, { recursive: true, force: true });
  rmSync(BIN, { recursive: true, force: true });
});

// --- CRUD + encryption ----------------------------------------------------------

test("add validates alias and host, and rejects duplicates", () => {
  expect(ssh.addConnection("", { host: "h" }).ok).toBe(false);
  expect(ssh.addConnection("bad alias", { host: "h" }).ok).toBe(false);
  expect(ssh.addConnection("nohost", {}).ok).toBe(false);
  expect(ssh.addConnection("server1", { host: "1.2.3.4", user: "root" }).ok).toBe(true);
  expect(ssh.addConnection("server1", { host: "5.6.7.8" }).ok).toBe(false); // duplicate
});

test("name is a second connect key: unique across servers, resolvable, same-server name==alias ok", () => {
  expect(ssh.addConnection("lirio-0", { host: "h", name: "lirio-prod" }).ok).toBe(true);
  // Both keys resolve to the same connection.
  expect(ssh.getConnection("lirio-0")!.alias).toBe("lirio-0");
  expect(ssh.getConnection("lirio-prod")!.alias).toBe("lirio-0");
  // A new server may not reuse either key (alias or name) of another.
  expect(ssh.addConnection("x1", { host: "h", name: "lirio-0" }).ok).toBe(false);   // name clashes with an alias
  expect(ssh.addConnection("lirio-prod", { host: "h" }).ok).toBe(false);            // alias clashes with a name
  // A single server may set name == its own alias.
  expect(ssh.addConnection("solo", { host: "h", name: "solo" }).ok).toBe(true);
  // Editing to clear the name frees it for reuse.
  ssh.updateConnection("lirio-0", { name: "" });
  expect(ssh.getConnection("lirio-prod")).toBeNull();
  expect(ssh.addConnection("reuse", { host: "h", name: "lirio-prod" }).ok).toBe(true);
});

test("a CLI subcommand cannot be used as an alias, a name or a forward name", () => {
  // `enigma ssh tunnel` dispatches the tunnel subcommand, so a server keyed "tunnel" would be
  // unreachable; the same holds for a saved forward named after a tunnel operation.
  for (const word of ["tunnel", "list", "add", "remove", "TUNNEL"]) {
    const res = ssh.addConnection(word, { host: "h" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("enigma ssh");
  }
  expect(ssh.addConnection("ok-alias", { host: "h", name: "forward" }).ok).toBe(false);
  expect(ssh.addConnection("ok-alias", { host: "h" }).ok).toBe(true);
  expect(ssh.updateConnection("ok-alias", { name: "tunnels" }).ok).toBe(false);
  expect(ssh.updateConnection("ok-alias", { name: "ok-name" }).ok).toBe(true);
  // A forward's name IS the token in `enigma ssh tunnel <name>`, so operations are refused.
  expect(ssh.addForward("ok-alias", { ...ssh.parseForward("9090:5432")!, name: "start" }).ok).toBe(false);
  expect(ssh.addForward("ok-alias", { ...ssh.parseForward("9090:5432")!, name: "pg" }).ok).toBe(true);
});

test("a name already stored stays editable, so a pre-reserved connection is not locked out", () => {
  // Written straight to the store: this is what a connection saved before the keys were
  // reserved looks like. Every edit form resends the stored name, so re-validating it would
  // make the row uneditable - only a CHANGED name is checked.
  const store = JSON.parse(readFileSync(join(HOME, "ssh.json"), "utf8")) as { connections: { alias: string; host: string; name?: string }[] };
  store.connections.push({ alias: "legacy", host: "h", name: "tunnel" });
  writeFileSync(join(HOME, "ssh.json"), JSON.stringify(store));
  expect(ssh.updateConnection("legacy", { name: "tunnel", host: "newhost" }).ok).toBe(true);
  expect(ssh.getConnection("legacy")!.host).toBe("newhost");
  expect(ssh.updateConnection("legacy", { name: "list" }).ok).toBe(false); // a new reserved name still is
});

test("the reserved lists match the issue helpers, so every surface refuses the same names", () => {
  expect(ssh.connectionKeyIssue("lirio-0")).toBeNull();
  expect(ssh.connectionKeyIssue("")).toContain("required");
  expect(ssh.connectionKeyIssue("bad alias")).toContain("alphanumeric");
  expect(ssh.forwardNameIssue("pg")).toBeNull();
  for (const word of ssh.RESERVED_CONNECTION_KEYS) expect(ssh.connectionKeyIssue(word)).toBeTruthy();
  for (const word of ssh.RESERVED_TUNNEL_NAMES) expect(ssh.forwardNameIssue(word)).toBeTruthy();
  // A standalone tunnel is run as `enigma ssh tunnel start <name>`, so its name is only shaped.
  for (const word of ssh.RESERVED_TUNNEL_NAMES) expect(ssh.tunnelNameIssue(word)).toBeNull();
  expect(ssh.tunnelNameIssue("bad name")).toContain("alphanumeric");
});

test("askpassAnswer returns the decrypted password by alias or name, else empty", () => {
  ssh.addConnection("pwconn", { host: "h", name: "pw-name", password: "hunter2" });
  expect(ssh.askpassAnswer("pwconn")).toBe("hunter2");
  expect(ssh.askpassAnswer("pw-name")).toBe("hunter2"); // resolves by name too
  expect(ssh.askpassAnswer("missing")).toBe("");
  ssh.addConnection("nopw", { host: "h" });
  expect(ssh.askpassAnswer("nopw")).toBe("");
});

test("askpassEnv wires enigma as SSH_ASKPASS with force", () => {
  const env = ssh.askpassEnv("lirio-0");
  expect(env.SSH_ASKPASS).toBe(process.execPath);
  expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
  expect(env.ENIGMA_ASKPASS).toBe("1");
  expect(env.ENIGMA_SSH_ASKPASS_ALIAS).toBe("lirio-0");
  expect(env.DISPLAY).toBeTruthy();
});

test("password is stored encrypted, never in plain text", () => {
  ssh.addConnection("secret", { host: "h", user: "u", password: "hunter2" });
  const raw = ssh.getConnection("secret")!;
  expect(raw.password).toBeTruthy();
  expect(raw.password).not.toContain("hunter2");
  expect(isEncryptedSecret(raw.password!)).toBe(true);
});

test("list redacts the password and reports hasPassword", () => {
  const view = ssh.listConnections().find((c) => c.alias === "secret")!;
  expect((view as Record<string, unknown>).password).toBeUndefined();
  expect(view.hasPassword).toBe(true);
});

test("update changes fields and an empty password clears it", () => {
  ssh.updateConnection("secret", { host: "newhost", password: "" });
  const raw = ssh.getConnection("secret")!;
  expect(raw.host).toBe("newhost");
  expect(raw.password).toBeUndefined();
});

test("remove deletes and reports unknown aliases", () => {
  expect(ssh.removeConnection("secret")).toBe(true);
  expect(ssh.removeConnection("secret")).toBe(false);
});

// --- forward specs --------------------------------------------------------------

test("parseForward handles the friendly and typed grammar", () => {
  expect(ssh.parseForward("8080")).toEqual({ type: "local", bind: "8080", host: "localhost", hostPort: 8080 });
  expect(ssh.parseForward("9090:8080")).toEqual({ type: "local", bind: "9090", host: "localhost", hostPort: 8080 });
  expect(ssh.parseForward("9090:dbhost:5432")).toEqual({ type: "local", bind: "9090", host: "dbhost", hostPort: 5432 });
  expect(ssh.parseForward("127.0.0.1:9090:db:5432")).toEqual({ type: "local", bind: "127.0.0.1:9090", host: "db", hostPort: 5432 });
  expect(ssh.parseForward("R:8080:localhost:80")).toEqual({ type: "remote", bind: "8080", host: "localhost", hostPort: 80 });
  expect(ssh.parseForward("D:1080")).toEqual({ type: "dynamic", bind: "1080" });
  expect(ssh.parseForward("d:127.0.0.1:1080")).toEqual({ type: "dynamic", bind: "127.0.0.1:1080" });
});

test("parseForward rejects malformed specs", () => {
  expect(ssh.parseForward("")).toBeNull();
  expect(ssh.parseForward("notaport")).toBeNull();
  expect(ssh.parseForward("70000")).toBeNull();
  expect(ssh.parseForward("9090:db:notaport")).toBeNull();
});

test("forwardToArgs and describeForward render each type", () => {
  expect(ssh.forwardToArgs({ type: "local", bind: "9090", host: "db", hostPort: 5432 })).toEqual(["-L", "9090:db:5432"]);
  expect(ssh.forwardToArgs({ type: "remote", bind: "8080", host: "localhost", hostPort: 80 })).toEqual(["-R", "8080:localhost:80"]);
  expect(ssh.forwardToArgs({ type: "dynamic", bind: "1080" })).toEqual(["-D", "1080"]);
  expect(ssh.describeForward({ type: "local", bind: "9090", host: "db", hostPort: 5432 })).toBe("local 9090 -> db:5432");
  expect(ssh.describeForward({ type: "local", bind: "9090", host: "db", hostPort: 5432, name: "pg" })).toBe("pg: local 9090 -> db:5432");
});

test("forwardSpec round-trips through parseForward", () => {
  for (const spec of ["9090:db:5432", "R:8080:localhost:80", "D:1080"]) {
    expect(ssh.forwardSpec(ssh.parseForward(spec)!)).toBe(spec);
  }
});

test("named forwards persist and run by name via resolveForwardToken", () => {
  ssh.addConnection("named", { host: "h" });
  ssh.addForward("named", { ...ssh.parseForward("9090:db:5432")!, name: "pg" });
  const conn = ssh.getConnection("named")!;
  expect(conn.forwards![0]!.name).toBe("pg");
  // A token matching a saved name resolves to that forward...
  expect(ssh.resolveForwardToken(conn, "pg")).toEqual(conn.forwards![0]!);
  // ...an ad-hoc spec still parses...
  expect(ssh.resolveForwardToken(conn, "D:1080")).toEqual({ type: "dynamic", bind: "1080" });
  // ...and an unknown name that is not a spec is null.
  expect(ssh.resolveForwardToken(conn, "nope")).toBeNull();
});

test("findNamedForward resolves a tunnel by name across servers", () => {
  ssh.addConnection("srvA", { host: "a" });
  ssh.addConnection("srvB", { host: "b" });
  ssh.addForward("srvA", { ...ssh.parseForward("9090:5432")!, name: "uniq" });
  const hit = ssh.findNamedForward("uniq");
  expect(hit).not.toBeNull();
  expect((hit as { conn: { alias: string } }).conn.alias).toBe("srvA");
  // The same name on two servers is ambiguous (the CLI asks the user to qualify it).
  ssh.addForward("srvB", { ...ssh.parseForward("8080:80")!, name: "uniq" });
  expect(ssh.findNamedForward("uniq")).toBe("ambiguous");
  expect(ssh.findNamedForward("missing")).toBeNull();
});

test("port 0 clears a stored port, so a blanked field does not silently keep the old one", () => {
  ssh.addConnection("portconn", { host: "h", port: 2222 });
  expect(ssh.getConnection("portconn")!.port).toBe(2222);
  ssh.updateConnection("portconn", { port: 0 });
  expect(ssh.getConnection("portconn")!.port).toBeUndefined();
});

test("addForward and removeForward persist on the connection", () => {
  // NOTE: "fwd" itself is a reserved key (it is the `forward` subcommand's alias).
  ssh.addConnection("fwdconn", { host: "h" });
  ssh.addForward("fwdconn", ssh.parseForward("9090:db:5432")!);
  ssh.addForward("fwdconn", ssh.parseForward("D:1080")!);
  expect(ssh.getConnection("fwdconn")!.forwards).toHaveLength(2);
  expect(ssh.removeForward("fwdconn", 0).ok).toBe(true);
  expect(ssh.getConnection("fwdconn")!.forwards).toEqual([{ type: "dynamic", bind: "1080" }]);
  expect(ssh.removeForward("fwdconn", 9).ok).toBe(false);
});

// --- command builders -----------------------------------------------------------

test("buildSshArgs assembles flags in order with the target last", () => {
  const conn = {
    alias: "a", host: "example.com", user: "root", port: 2222, identityFile: "/k.pem",
    proxyJump: "bastion", forwardAgent: true, options: ["Compression=yes"],
    forwards: [ssh.parseForward("9090:db:5432")!],
  };
  expect(ssh.buildSshArgs(conn, { tunnelOnly: true, extra: ["uptime"] })).toEqual([
    "-p", "2222", "-i", "/k.pem", "-J", "bastion", "-A",
    "-o", "Compression=yes", "-L", "9090:db:5432", "-N", "root@example.com", "uptime",
  ]);
});

test("buildSshArgs falls back to a bare host and no-user target", () => {
  expect(ssh.buildSshArgs({ alias: "a", host: "h" })).toEqual(["h"]);
  expect(ssh.sshTarget({ alias: "a", host: "h", user: "me" })).toBe("me@h");
});

test("buildPlinkArgs uses -P/-pw and drops unsupported options", () => {
  const conn = { alias: "a", host: "h", user: "u", port: 2222, proxyJump: "bastion", options: ["X=Y"] };
  const args = ssh.buildPlinkArgs(conn, "pw", { forwards: [ssh.parseForward("D:1080")!] });
  expect(args).toContain("-ssh");
  expect(args).toContain("-batch");
  expect(args).toEqual(expect.arrayContaining(["-P", "2222", "-D", "1080", "-pw", "pw", "u@h"]));
  expect(args).not.toContain("-J");
  expect(args).not.toContain("-o");
});

// --- launcher selection ---------------------------------------------------------

function fakeBin(name: string): void {
  writeFileSync(join(BIN, name), "#!/bin/sh\n");
  writeFileSync(join(BIN, `${name}.exe`), ""); // Windows PATHEXT resolution
}

test("resolveLauncher uses plain ssh for key auth", () => {
  process.env.PATH = "";
  const l = ssh.resolveLauncher({ alias: "a", host: "h", identityFile: "/k.pem" });
  expect(l.mode).toBe("plain-key");
  expect(l.args).toContain("-i");
  expect(l.env.SSHPASS).toBeUndefined();
});

test("resolveLauncher falls back to a prompt when a password has no helper", () => {
  process.env.PATH = ""; // no sshpass, no plink
  const conn = ssh.getConnection("fwdconn")!;
  const l = ssh.resolveLauncher({ ...conn, password: (ssh.addConnection("pw1", { host: "h", password: "s" }), ssh.getConnection("pw1")!.password) });
  expect(l.mode).toBe("plain-prompt");
});

test("resolveLauncher auto-fills via plink when present", () => {
  fakeBin("plink");
  process.env.PATH = BIN;
  ssh.addConnection("pw2", { host: "h", user: "u", password: "topsecret", proxyJump: "bastion" });
  const l = ssh.resolveLauncher(ssh.getConnection("pw2")!);
  expect(l.mode).toBe("plink");
  expect(l.args).toContain("-pw");
  expect(l.args).toContain("topsecret");
  expect(l.warnings.some((w) => /jump host/i.test(w))).toBe(true);
});
