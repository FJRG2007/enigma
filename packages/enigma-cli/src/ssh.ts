/**
 * SSH connection manager: save a server's credentials once (host, user, key or password,
 * jump host, port forwards) under a short alias, then reach it with `enigma ssh <alias>` -
 * no more remembering which server wants `-i cert.pem`, which wants a password, or the long
 * `-L 9090:db:5432` tunnel line. The same store powers the CLI, the TUI hub and the dashboard.
 *
 * Passwords are encrypted at rest with the shared secret-box (AES-256-GCM, machine-local key)
 * and auto-supplied on connect via sshpass (Linux/macOS) or plink (Windows/PuTTY) when present,
 * falling back to an interactive prompt. Everything here is Node-builtins + secret-box, so the
 * argv/spec builders are pure and unit-tested without ever spawning ssh.
 */

import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { encryptSecret, decryptSecret } from "./secret-box";
import { enigmaHome, isOnPath, readJson, resolveBin } from "./util";

const isWin = process.platform === "win32";

/** A saved port forward. `bind` is the listen side ("9090" or "127.0.0.1:9090"). */
export interface PortForward {
  /** local (-L, bring a remote port here), remote (-R), or dynamic SOCKS (-D). */
  type: "local" | "remote" | "dynamic";
  /** Listen side: a port ("9090") or an address:port ("127.0.0.1:9090"). */
  bind: string;
  /** Target host for local/remote forwards (unused for dynamic). */
  host?: string;
  /** Target port for local/remote forwards. */
  hostPort?: number;
  /** Optional short name so a single tunnel can be run by name (`enigma ssh tunnel <alias> <name>`). */
  name?: string;
}

/** A saved SSH connection. `password` is stored encrypted (enc:v1:...) and never displayed. */
export interface SshConnection {
  alias: string;
  host: string;
  user?: string;
  /** Defaults to 22 when unset. */
  port?: number;
  /** Path to a private key (-i). */
  identityFile?: string;
  /** Encrypted at rest; empty/absent means key- or agent-based auth. */
  password?: string;
  /** Jump host(s) for -J (ProxyJump), e.g. "bastion" or "user@bastion:22". */
  proxyJump?: string;
  /** Forward the local ssh-agent (-A). */
  forwardAgent?: boolean;
  /** Extra `-o Key=Value` options, stored as "Key=Value" tokens. */
  options?: string[];
  /** Port forwards applied on every connect. */
  forwards?: PortForward[];
}

/** A connection as shown to a UI: no password, just whether one is stored. */
export interface SshConnectionView extends Omit<SshConnection, "password"> {
  hasPassword: boolean;
}

interface SshStore { connections: SshConnection[]; }

function storePath(): string {
  return join(enigmaHome(), "ssh.json");
}

function readStore(): SshStore {
  const raw = existsSync(storePath()) ? readJson<SshStore>(storePath()) : null;
  return raw && Array.isArray(raw.connections) ? raw : { connections: [] };
}

function writeStore(store: SshStore): void {
  writeFileSync(storePath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/** Strip the password from a connection for display, keeping only whether one exists. */
function toView(c: SshConnection): SshConnectionView {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: Boolean(password) };
}

// --- CRUD -----------------------------------------------------------------------

/** All saved connections, passwords redacted, sorted by alias. */
export function listConnections(): SshConnectionView[] {
  return readStore().connections.map(toView).sort((a, b) => a.alias.localeCompare(b.alias));
}

/** The raw connection (password still encrypted) by alias, or null. */
export function getConnection(alias: string): SshConnection | null {
  return readStore().connections.find((c) => c.alias === alias) ?? null;
}

/** Fields accepted when creating or editing a connection (plain password; encrypted on write). */
export interface SshInput {
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** Plain-text password to store; "" clears a stored password. */
  password?: string;
  proxyJump?: string;
  forwardAgent?: boolean;
  options?: string[];
  forwards?: PortForward[];
}

const ALIAS_RE = /^[A-Za-z0-9][\w.-]*$/;

/** Create a connection. Alias must be unique and host is required. */
export function addConnection(alias: string, input: SshInput): { ok: boolean; error?: string } {
  if (!alias || !ALIAS_RE.test(alias)) return { ok: false, error: "Alias must be alphanumeric (dashes, dots and underscores allowed)." };
  if (!input.host) return { ok: false, error: "A host is required (--host)." };
  const store = readStore();
  if (store.connections.some((c) => c.alias === alias)) return { ok: false, error: `A connection named '${alias}' already exists.` };
  const conn: SshConnection = { alias, host: input.host };
  applyInput(conn, input);
  store.connections.push(conn);
  writeStore(store);
  return { ok: true };
}

/** Update an existing connection with the provided fields (others untouched). */
export function updateConnection(alias: string, input: SshInput): { ok: boolean; error?: string } {
  const store = readStore();
  const conn = store.connections.find((c) => c.alias === alias);
  if (!conn) return { ok: false, error: `Unknown connection '${alias}'.` };
  applyInput(conn, input);
  writeStore(store);
  return { ok: true };
}

/** Copy provided input fields onto a connection, encrypting the password. */
function applyInput(conn: SshConnection, input: SshInput): void {
  if (input.host !== undefined) conn.host = input.host;
  if (input.user !== undefined) conn.user = input.user || undefined;
  if (input.port !== undefined) conn.port = input.port || undefined;
  if (input.identityFile !== undefined) conn.identityFile = input.identityFile || undefined;
  if (input.proxyJump !== undefined) conn.proxyJump = input.proxyJump || undefined;
  if (input.forwardAgent !== undefined) conn.forwardAgent = input.forwardAgent || undefined;
  if (input.options !== undefined) conn.options = input.options.length ? input.options : undefined;
  if (input.forwards !== undefined) conn.forwards = input.forwards.length ? input.forwards : undefined;
  // "" explicitly clears a stored password; undefined leaves it as-is.
  if (input.password !== undefined) conn.password = input.password ? encryptSecret(input.password) : undefined;
}

/** Delete a connection. Returns false when the alias was not found. */
export function removeConnection(alias: string): boolean {
  const store = readStore();
  const before = store.connections.length;
  store.connections = store.connections.filter((c) => c.alias !== alias);
  if (store.connections.length === before) return false;
  writeStore(store);
  return true;
}

/** Add a saved forward to a connection. */
export function addForward(alias: string, forward: PortForward): { ok: boolean; error?: string } {
  const conn = getConnection(alias);
  if (!conn) return { ok: false, error: `Unknown connection '${alias}'.` };
  const forwards = [...(conn.forwards ?? []), forward];
  return updateConnection(alias, { forwards });
}

/** Remove a saved forward by its index (as listed). */
export function removeForward(alias: string, index: number): { ok: boolean; error?: string } {
  const conn = getConnection(alias);
  if (!conn) return { ok: false, error: `Unknown connection '${alias}'.` };
  const forwards = [...(conn.forwards ?? [])];
  if (index < 0 || index >= forwards.length) return { ok: false, error: "No forward at that index." };
  forwards.splice(index, 1);
  return updateConnection(alias, { forwards });
}

// --- port-forward specs (pure) --------------------------------------------------

/**
 * Parse a friendly tunnel spec into a PortForward. Grammar (type defaults to local):
 *   8080                -> local  127.0.0.1:8080 -> remote localhost:8080  (bring a remote port here)
 *   9090:8080           -> local  9090 -> remote localhost:8080
 *   9090:dbhost:5432    -> local  9090 -> remote dbhost:5432
 *   127.0.0.1:9090:db:5432 -> local 127.0.0.1:9090 -> remote db:5432
 *   R:8080:localhost:80 -> remote forward
 *   D:1080              -> dynamic SOCKS proxy on 1080
 * Returns null when the spec is malformed.
 */
export function parseForward(spec: string): PortForward | null {
  if (!spec) return null;
  let type: PortForward["type"] = "local";
  let rest = spec.trim();
  const m = rest.match(/^([LRD]):(.*)$/i);
  if (m) {
    const t = m[1]!.toUpperCase();
    type = t === "R" ? "remote" : t === "D" ? "dynamic" : "local";
    rest = m[2]!;
  }
  const parts = rest.split(":");
  if (type === "dynamic") {
    // D:1080 or D:127.0.0.1:1080
    const bind = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : parts[0]!;
    return isPort(parts[parts.length - 1]) ? { type, bind } : null;
  }
  // local / remote: [bindAddr:]bindPort[:host:hostPort]
  let bind: string, host: string, hostPort: string;
  if (parts.length === 1) { bind = parts[0]!; host = "localhost"; hostPort = parts[0]!; }
  else if (parts.length === 2) { bind = parts[0]!; host = "localhost"; hostPort = parts[1]!; }
  else if (parts.length === 3) { bind = parts[0]!; host = parts[1]!; hostPort = parts[2]!; }
  else if (parts.length === 4) { bind = `${parts[0]}:${parts[1]}`; host = parts[2]!; hostPort = parts[3]!; }
  else return null;
  const bindPort = bind.split(":").pop()!;
  if (!isPort(bindPort) || !isPort(hostPort) || !host) return null;
  return { type, bind, host, hostPort: Number(hostPort) };
}

function isPort(v: string | undefined): boolean {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

/** The ssh/plink flag + value for a forward, e.g. ["-L", "9090:dbhost:5432"]. */
export function forwardToArgs(f: PortForward): string[] {
  if (f.type === "dynamic") return ["-D", f.bind];
  const flag = f.type === "remote" ? "-R" : "-L";
  return [flag, `${f.bind}:${f.host}:${f.hostPort}`];
}

/** The spec string that reproduces a forward (the inverse of parseForward), e.g. "9090:db:5432". */
export function forwardSpec(f: PortForward): string {
  if (f.type === "dynamic") return `D:${f.bind}`;
  return `${f.type === "remote" ? "R:" : ""}${f.bind}:${f.host}:${f.hostPort}`;
}

/** A human one-liner for a forward, e.g. "pg: local 9090 -> dbhost:5432". */
export function describeForward(f: PortForward): string {
  const prefix = f.name ? `${f.name}: ` : "";
  if (f.type === "dynamic") return `${prefix}dynamic SOCKS on ${f.bind}`;
  return `${prefix}${f.type} ${f.bind} -> ${f.host}:${f.hostPort}`;
}

/**
 * Resolve a tunnel token to a forward: first a saved forward's NAME on this connection,
 * otherwise parse it as a spec. Lets `enigma ssh tunnel <alias> pg` run the saved "pg"
 * tunnel by name while still accepting ad-hoc specs like `9090:db:5432`.
 */
export function resolveForwardToken(conn: SshConnection, token: string): PortForward | null {
  const named = (conn.forwards ?? []).find((f) => f.name === token);
  return named ?? parseForward(token);
}

// --- command builders (pure) ----------------------------------------------------

/** "user@host" or just "host" when no user is set. */
export function sshTarget(conn: SshConnection): string {
  return conn.user ? `${conn.user}@${conn.host}` : conn.host;
}

export interface ConnectOpts {
  /** Forwards to apply; defaults to the connection's saved forwards. */
  forwards?: PortForward[];
  /** Open the tunnels only, no shell/command (-N). */
  tunnelOnly?: boolean;
  /** Extra args appended verbatim (e.g. a remote command). */
  extra?: string[];
}

/** Build the OpenSSH argv (without the leading "ssh"). Pure. */
export function buildSshArgs(conn: SshConnection, opts: ConnectOpts = {}): string[] {
  const args: string[] = [];
  if (conn.port) args.push("-p", String(conn.port));
  if (conn.identityFile) args.push("-i", conn.identityFile);
  if (conn.proxyJump) args.push("-J", conn.proxyJump);
  if (conn.forwardAgent) args.push("-A");
  for (const opt of conn.options ?? []) args.push("-o", opt);
  const forwards = opts.forwards ?? conn.forwards ?? [];
  for (const f of forwards) args.push(...forwardToArgs(f));
  if (opts.tunnelOnly) args.push("-N");
  args.push(sshTarget(conn));
  if (opts.extra?.length) args.push(...opts.extra);
  return args;
}

/**
 * Build the PuTTY plink argv (without the leading "plink"). Used on Windows for password
 * auto-fill. plink has no -J/-o equivalent, so ProxyJump and extra options are dropped
 * (the caller warns). The password rides -pw; a machine-local single-user tradeoff.
 */
export function buildPlinkArgs(conn: SshConnection, password: string, opts: ConnectOpts = {}): string[] {
  const args: string[] = ["-ssh", "-batch"];
  if (conn.port) args.push("-P", String(conn.port));
  if (conn.identityFile) args.push("-i", conn.identityFile);
  if (conn.forwardAgent) args.push("-A");
  const forwards = opts.forwards ?? conn.forwards ?? [];
  for (const f of forwards) args.push(...forwardToArgs(f));
  if (opts.tunnelOnly) args.push("-N");
  // enigma: plink exposes the password on argv; upgrade to -pwfile (a 0600 temp file) if a
  // ps-listing leak ever matters on a shared Windows host.
  if (password) args.push("-pw", password);
  args.push(sshTarget(conn));
  if (opts.extra?.length) args.push(...opts.extra);
  return args;
}

/** How a connection will actually be launched. */
export type LaunchMode =
  | "sshpass"       // password auto-filled via sshpass -e (SSHPASS env)
  | "plink"         // password auto-filled via plink -pw
  | "plain-key"     // key/agent auth, plain ssh
  | "plain-prompt"; // password stored but no helper present; ssh will prompt

export interface Launcher {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mode: LaunchMode;
  /** Non-fatal warnings (e.g. plink dropping ProxyJump). */
  warnings: string[];
}

/**
 * Resolve how to spawn a connection: pick sshpass/plink/plain, decrypt the password, and
 * assemble the command + args + env. Never spawns. The password only ever lands in the
 * SSHPASS env (sshpass) or plink's argv - never in this process's own environment beyond
 * the child it hands off.
 */
export function resolveLauncher(conn: SshConnection, opts: ConnectOpts = {}): Launcher {
  const warnings: string[] = [];
  const password = conn.password ? decryptSecret(conn.password) : "";
  const sshBin = resolveBin("ssh") || "ssh";

  if (password && !isWin && isOnPath("sshpass")) {
    return {
      command: resolveBin("sshpass") || "sshpass",
      args: ["-e", sshBin, ...buildSshArgs(conn, opts)],
      env: { ...process.env, SSHPASS: password },
      mode: "sshpass",
      warnings,
    };
  }
  if (password && isOnPath("plink")) {
    if (conn.proxyJump) warnings.push("plink does not support a jump host; the ProxyJump is ignored.");
    if (conn.options?.length) warnings.push("plink does not support -o options; they are ignored.");
    return {
      command: resolveBin("plink") || "plink",
      args: buildPlinkArgs(conn, password, opts),
      env: { ...process.env },
      mode: "plink",
      warnings,
    };
  }
  return {
    command: sshBin,
    args: buildSshArgs(conn, opts),
    env: { ...process.env },
    mode: password ? "plain-prompt" : "plain-key",
    warnings,
  };
}
