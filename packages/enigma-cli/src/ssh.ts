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

import { basename, join } from "node:path";
import { existsSync, writeFileSync, writeSync } from "node:fs";
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
  /** Short key the user connects with (e.g. "lirio-0"). Primary id; always set. */
  alias: string;
  /** The real server name (e.g. "lirio-production"). An ALTERNATE connect key when set. */
  name?: string;
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

/**
 * Resolve a connect key. Alias and name are both connect keys, so every lookup - read, edit and
 * remove alike - accepts either; matching on the alias only made `enigma ssh edit <name>` refuse
 * a connection that `enigma ssh <name>` connects to. An alias always wins over a name, so a row
 * saved before the keys were unique cannot shadow another connection's alias.
 */
function findConnection(connections: SshConnection[], key: string): SshConnection | null {
  return connections.find((c) => c.alias === key) ?? connections.find((c) => c.name === key) ?? null;
}

/** The raw connection (password still encrypted) by its alias OR its name, or null. */
export function getConnection(key: string): SshConnection | null {
  return findConnection(readStore().connections, key);
}

/** Fields accepted when creating or editing a connection (plain password; encrypted on write). */
export interface SshInput {
  /** Alternate connect key (the real server name); "" clears it. */
  name?: string;
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

/**
 * Tokens `enigma ssh <token>` already dispatches as a subcommand (see runSshCli in cli.ts).
 * A connection keyed with one of these could never be connected to - `enigma ssh tunnel` runs
 * the tunnel subcommand, it does not reach a server called "tunnel" - so they are refused up
 * front instead of saving a connection the user can never reach.
 */
export const RESERVED_CONNECTION_KEYS: readonly string[] = [
  "add", "delete", "edit", "forward", "fwd", "info", "list", "ls", "remove", "rm", "show", "tunnel", "tunnels",
];

/**
 * Tokens `enigma ssh tunnel <token>` dispatches as a tunnel operation. These only collide with a
 * SAVED FORWARD's name, which is the token itself in `enigma ssh tunnel <name>`. A standalone
 * tunnel is always run as `enigma ssh tunnel <op> <name>`, so its name is never a dispatch token
 * and one called "up" stays perfectly reachable - do not refuse those.
 */
export const RESERVED_TUNNEL_NAMES: readonly string[] = [
  "add", "down", "edit", "list", "remove", "rm", "start", "status", "stop", "up",
];

/** Why a name is the wrong shape, or null. The shared half of the checks below. */
function nameShapeIssue(value: string, label: string): string | null {
  if (!value) return `${label} is required.`;
  if (!ALIAS_RE.test(value)) return `${label} must be alphanumeric (dashes, dots and underscores allowed).`;
  return null;
}

/**
 * Why a connect key (an alias or a connection's name) cannot be used, or null when it is fine.
 * The single source of truth for the CLI, the TUI and the dashboard's real-time check, so all
 * three refuse the same values with the same wording.
 */
export function connectionKeyIssue(value: string, label = "Alias"): string | null {
  const shape = nameShapeIssue(value, label);
  if (shape) return shape;
  if (RESERVED_CONNECTION_KEYS.includes(value.toLowerCase()))
    return `'${value}' is an 'enigma ssh' subcommand, so 'enigma ssh ${value}' would never reach this server. Pick another ${label.toLowerCase()}.`;
  return null;
}

/** Why a standalone tunnel's name cannot be used, or null. Shape only - see RESERVED_TUNNEL_NAMES. */
export function tunnelNameIssue(value: string, label = "Tunnel name"): string | null {
  return nameShapeIssue(value, label);
}

/**
 * Why a typed port cannot be used, or null. Blank (or 0) is fine and means "clear it" - the
 * connection falls back to 22 - so every surface accepts the same range with the same wording
 * instead of silently dropping a typo back to the stored value.
 */
export function portIssue(value: string | number): string | null {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "") return null;
  // Decide on the SHAPE, never on the coercion: null, false and [] all coerce to 0, and a
  // bare `Number(raw) === 0` would read those as "clear it" at what is the /api/ssh boundary.
  const n = typeof raw === "number" ? raw : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (n === 0) return null;
  if (!Number.isInteger(n) || n < 1 || n > 65535) return "Port must be a whole number between 1 and 65535.";
  return null;
}

/** Why a saved forward's name cannot be used, or null. It IS the `enigma ssh tunnel <name>` token. */
export function forwardNameIssue(value: string, label = "Forward name"): string | null {
  const shape = nameShapeIssue(value, label);
  if (shape) return shape;
  if (RESERVED_TUNNEL_NAMES.includes(value.toLowerCase()))
    return `'${value}' is an 'enigma ssh tunnel' operation, so 'enigma ssh tunnel ${value}' would never run this forward. Pick another name.`;
  return null;
}

/**
 * The connect key (alias or name) that already belongs to a DIFFERENT connection, or null when
 * alias/name are free. Both alias and name are global connect keys, so neither may collide with
 * any other connection's alias or name - but a single connection may set name == its own alias.
 */
function keyConflict(connections: SshConnection[], selfAlias: string | null, alias: string, name?: string): string | null {
  for (const c of connections) {
    if (c.alias === selfAlias) continue;
    const keys = c.name ? [c.alias, c.name] : [c.alias];
    if (keys.includes(alias)) return alias;
    if (name && keys.includes(name)) return name;
  }
  return null;
}

/** Create a connection. Alias (and name, if given) must be unique connect keys; host is required. */
export function addConnection(alias: string, input: SshInput): { ok: boolean; error?: string } {
  const aliasIssue = connectionKeyIssue(alias);
  if (aliasIssue) return { ok: false, error: aliasIssue };
  const nameIssue = input.name ? connectionKeyIssue(input.name, "Name") : null;
  if (nameIssue) return { ok: false, error: nameIssue };
  if (!input.host) return { ok: false, error: "A host is required (--host)." };
  const store = readStore();
  const clash = keyConflict(store.connections, null, alias, input.name);
  if (clash) return { ok: false, error: `'${clash}' is already used by another connection (alias and name must be unique).` };
  const conn: SshConnection = { alias, host: input.host };
  applyInput(conn, input);
  store.connections.push(conn);
  writeStore(store);
  return { ok: true };
}

/** Update an existing connection, keyed by alias or name, with the provided fields (others untouched). */
export function updateConnection(key: string, input: SshInput): { ok: boolean; error?: string } {
  const store = readStore();
  const conn = findConnection(store.connections, key);
  if (!conn) return { ok: false, error: `Unknown connection '${key}'.` };
  // Only a NEW name is checked: a connection saved before the reserved keys existed would
  // otherwise be uneditable (every form resends its stored name), blocking an unrelated
  // host change until the user renamed it.
  const nameIssue = input.name && input.name !== conn.name ? connectionKeyIssue(input.name, "Name") : null;
  if (nameIssue) return { ok: false, error: nameIssue };
  const nextName = input.name !== undefined ? input.name : conn.name;
  const clash = keyConflict(store.connections, conn.alias, conn.alias, nextName || undefined);
  if (clash) return { ok: false, error: `'${clash}' is already used by another connection (alias and name must be unique).` };
  applyInput(conn, input);
  writeStore(store);
  return { ok: true };
}

/** Copy provided input fields onto a connection, encrypting the password. */
function applyInput(conn: SshConnection, input: SshInput): void {
  if (input.name !== undefined) conn.name = input.name || undefined;
  if (input.host !== undefined) conn.host = input.host;
  if (input.user !== undefined) conn.user = input.user || undefined;
  if (input.port !== undefined) conn.port = input.port || undefined; // 0 clears it (back to 22)
  if (input.identityFile !== undefined) conn.identityFile = input.identityFile || undefined;
  if (input.proxyJump !== undefined) conn.proxyJump = input.proxyJump || undefined;
  if (input.forwardAgent !== undefined) conn.forwardAgent = input.forwardAgent || undefined;
  if (input.options !== undefined) conn.options = input.options.length ? input.options : undefined;
  if (input.forwards !== undefined) conn.forwards = input.forwards.length ? input.forwards : undefined;
  // "" explicitly clears a stored password; undefined leaves it as-is.
  if (input.password !== undefined) conn.password = input.password ? encryptSecret(input.password) : undefined;
}

/** The outcome of parsing `enigma ssh add|edit` flags: the fields to write, or why they are bad. */
export interface ParsedConnectionFlags {
  input: SshInput;
  /** The caller must ask for a password interactively and assign it to `input.password`. */
  promptPassword: boolean;
  error?: string;
}

/**
 * Parse the flag list of `enigma ssh add|edit` into an SshInput. It lives here, beside the
 * validators, so the CLI refuses exactly what the TUI and the dashboard refuse: a port typo used
 * to coerce to `undefined`, which applyInput reads as "leave as-is", so the old port was kept
 * while the CLI still reported the connection as updated.
 */
export function parseConnectionFlags(flags: string[]): ParsedConnectionFlags {
  const input: SshInput = {};
  const options: string[] = [];
  const forwards: PortForward[] = [];
  let promptPassword = false;
  const fail = (error: string): ParsedConnectionFlags => ({ input, promptPassword, error });
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    const val = (): string => flags[++i] ?? "";
    switch (f) {
      case "--name": case "-n": input.name = val(); break;
      case "--no-name": input.name = ""; break;
      case "--host": case "-H": input.host = val(); break;
      case "--user": case "-u": input.user = val(); break;
      case "--port": case "-p": {
        const raw = val();
        const issue = portIssue(raw);
        if (issue) return fail(issue);
        input.port = Number(raw.trim()) || 0; // blank or 0 clears it (back to 22)
        break;
      }
      case "--no-port": input.port = 0; break;
      case "--identity": case "-i": input.identityFile = val(); break;
      case "--jump": case "-j": input.proxyJump = val(); break;
      case "--forward-agent": case "-A": input.forwardAgent = true; break;
      case "--no-forward-agent": input.forwardAgent = false; break;
      case "--option": case "-o": options.push(val()); break;
      case "--forward": case "-L": {
        const pf = parseForward(val());
        if (!pf) return fail("Bad forward spec. Examples: 8080  9090:8080  9090:dbhost:5432  R:8080:localhost:80  D:1080");
        forwards.push(pf);
        break;
      }
      case "--password": promptPassword = true; break;
      case "--password-value": input.password = val(); break; // scriptable; discouraged
      case "--no-password": input.password = ""; break;
      default: return fail(`Unknown flag: ${f}`);
    }
  }
  if (options.length) input.options = options;
  if (forwards.length) input.forwards = forwards;
  return { input, promptPassword };
}

/** Delete a connection by alias or name. Returns false when neither key matched. */
export function removeConnection(key: string): boolean {
  const store = readStore();
  const conn = findConnection(store.connections, key);
  if (!conn) return false;
  store.connections.splice(store.connections.indexOf(conn), 1);
  writeStore(store);
  return true;
}

/**
 * Add a saved forward to a connection. A named forward is run with `enigma ssh tunnel <name>`.
 * The key may be an alias OR a name (getConnection accepts both); the write goes through the
 * resolved alias so the forward always lands on the connection that was found.
 */
export function addForward(key: string, forward: PortForward): { ok: boolean; error?: string } {
  const conn = getConnection(key);
  if (!conn) return { ok: false, error: `Unknown connection '${key}'.` };
  const nameIssue = forward.name ? forwardNameIssue(forward.name) : null;
  if (nameIssue) return { ok: false, error: nameIssue };
  const forwards = [...(conn.forwards ?? []), forward];
  return updateConnection(conn.alias, { forwards });
}

/** Remove a saved forward by its index (as listed). Keyed by alias or name, like addForward. */
export function removeForward(key: string, index: number): { ok: boolean; error?: string } {
  const conn = getConnection(key);
  if (!conn) return { ok: false, error: `Unknown connection '${key}'.` };
  const forwards = [...(conn.forwards ?? [])];
  if (index < 0 || index >= forwards.length) return { ok: false, error: "No forward at that index." };
  forwards.splice(index, 1);
  return updateConnection(conn.alias, { forwards });
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

/**
 * Find a saved tunnel by name across ALL connections, so it can be run without naming the
 * server: `enigma ssh tunnel pg`. Returns the match, "ambiguous" when several servers have a
 * tunnel with that name (the caller asks the user to qualify it), or null when none do.
 */
export function findNamedForward(name: string): { conn: SshConnection; forward: PortForward } | "ambiguous" | null {
  const hits: { conn: SshConnection; forward: PortForward }[] = [];
  for (const conn of readStore().connections)
    for (const forward of conn.forwards ?? [])
      if (forward.name === name) hits.push({ conn, forward });
  if (hits.length > 1) return "ambiguous";
  return hits[0] ?? null;
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
  | "askpass"       // password auto-filled by enigma acting as SSH_ASKPASS (no external tool)
  | "plain-key"     // key/agent auth, plain ssh
  | "plain-prompt"; // password stored but running from dev (node/bun); ssh will prompt

/** Whether enigma can serve as SSH_ASKPASS: only from the compiled binary (dev node/bun can't). */
function askpassCapable(): boolean {
  const exe = basename(process.execPath).toLowerCase();
  return !(exe.startsWith("node") || exe.startsWith("bun"));
}

/**
 * The env that makes OpenSSH call enigma back as SSH_ASKPASS to supply this connection's
 * password. SSH_ASKPASS_REQUIRE=force uses it even with a terminal (OpenSSH >= 8.4); DISPLAY is
 * a fallback some builds still want. The password never lands here - only the alias to look up.
 */
export function askpassEnv(alias: string): NodeJS.ProcessEnv {
  return {
    SSH_ASKPASS: process.execPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: process.env.DISPLAY || ":0",
    ENIGMA_ASKPASS: "1",
    ENIGMA_SSH_ASKPASS_ALIAS: alias,
  };
}

/** The decrypted password OpenSSH should receive for a connection (empty when none/unknown). */
export function askpassAnswer(key: string): string {
  const conn = getConnection(key);
  return conn?.password ? decryptSecret(conn.password) : "";
}

/**
 * SSH_ASKPASS responder: print the saved connection's decrypted password (+ newline) to stdout so
 * OpenSSH can auto-fill it. Invoked as a subprocess by ssh with ENIGMA_ASKPASS=1; the connection
 * comes from ENIGMA_SSH_ASKPASS_ALIAS. Writes synchronously to fd 1 so the short-lived process
 * never exits before the password is flushed.
 */
export function emitAskpass(): void {
  try { writeSync(1, `${askpassAnswer(process.env.ENIGMA_SSH_ASKPASS_ALIAS || "")}\n`); } catch { /* stdout already closed */ }
}

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
  // Dependency-free auto-fill: OpenSSH invokes enigma itself as SSH_ASKPASS. accept-new avoids a
  // yes/no host-key prompt so the askpass only ever answers the password. This is the default
  // path when no external helper is installed - works on any OpenSSH >= 8.4, any OS.
  if (password && askpassCapable()) {
    return {
      command: sshBin,
      args: ["-o", "StrictHostKeyChecking=accept-new", ...buildSshArgs(conn, opts)],
      env: { ...process.env, ...askpassEnv(conn.alias) },
      mode: "askpass",
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
