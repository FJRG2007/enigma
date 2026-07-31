/**
 * Standalone SSH tunnels: a named port-forward bound to a saved connection, managed as its own
 * top-level entity (not nested under a server, so it can be re-pointed to a different server by
 * editing one field). Each tunnel can be started as a background `ssh -N` process and stopped
 * again, and its live/stopped state is tracked by pid so the CLI, TUI and dashboard can show it.
 *
 * The forward spec + auth reuse ssh.ts (resolveLauncher builds the exact command, including the
 * dependency-free password auto-fill); this module only adds the standalone identity, the server
 * binding, and the background process lifecycle. Node-builtins + ssh.ts + resources.ts (killPid).
 */

import { join } from "node:path";
import { killPid } from "./resources";
import { spawn } from "node:child_process";
import { enigmaHome, readJson } from "./util";
import { existsSync, writeFileSync } from "node:fs";
import {
  getConnection, resolveLauncher, forwardSpec, describeForward, parseForward,
  sshTarget, tunnelNameIssue, type PortForward
} from "./ssh";

/** A named, server-bound port forward that can be run as a background process. */
export interface Tunnel extends PortForward {
  /** Unique name; how the tunnel is referenced everywhere. */
  name: string;
  /** The connection (its alias OR name) this tunnel forwards through; editable to re-point it. */
  server: string;
}

/** A tunnel plus its live runtime state, for the UIs. */
export interface TunnelView extends Tunnel {
  active: boolean;
  /** The `enigma ssh ...` / forward one-liner. */
  label: string;
  spec: string;
  /** The connection's target ("user@host"), or "" when the bound server no longer exists. */
  target: string;
  /** True when the bound server is missing (a dangling binding). */
  missing: boolean;
}

interface TunnelStore { tunnels: Tunnel[]; }
interface RunState { [name: string]: { pid: number; startedAt: number; }; }

function storePath(): string { return join(enigmaHome(), "ssh-tunnels.json"); }
function statePath(): string { return join(enigmaHome(), "ssh-tunnels-state.json"); }

function readStore(): TunnelStore {
  const raw = existsSync(storePath()) ? readJson<TunnelStore>(storePath()) : null;
  return raw && Array.isArray(raw.tunnels) ? raw : { tunnels: [] };
}
function writeStore(store: TunnelStore): void {
  writeFileSync(storePath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}
function readState(): RunState {
  return (existsSync(statePath()) ? readJson<RunState>(statePath()) : null) ?? {};
}
function writeState(state: RunState): void {
  writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Whether a pid is currently alive (signal 0 probe; EPERM still means alive). */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Is the named tunnel currently running? Cleans a stale pid from the state file. */
export function tunnelActive(name: string): boolean {
  const state = readState();
  const rec = state[name];
  if (!rec) return false;
  if (pidAlive(rec.pid)) return true;
  delete state[name];
  writeState(state);
  return false;
}

/** The forward payload of a tunnel (drops the standalone-only fields). */
function toForward(t: Tunnel): PortForward {
  return { type: t.type, bind: t.bind, host: t.host, hostPort: t.hostPort, name: t.name };
}

// --- CRUD -----------------------------------------------------------------------

/** All tunnels with their live status, sorted by name. */
export function listTunnels(): TunnelView[] {
  return readStore().tunnels
    .map((t) => {
      const conn = getConnection(t.server);
      return {
        ...t,
        active: tunnelActive(t.name),
        label: describeForward(toForward(t)),
        spec: forwardSpec(toForward(t)),
        target: conn ? sshTarget(conn) : "",
        missing: !conn,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getTunnel(name: string): Tunnel | null {
  return readStore().tunnels.find((t) => t.name === name) ?? null;
}

/** Create a tunnel from a name, a server (alias or name) and a spec (e.g. "9090:db:5432"). */
export function addTunnel(name: string, server: string, spec: string): { ok: boolean; error?: string; } {
  const issue = tunnelNameIssue(name);
  if (issue) return { ok: false, error: issue };
  const store = readStore();
  if (store.tunnels.some((t) => t.name === name)) return { ok: false, error: `A tunnel named '${name}' already exists.` };
  if (!getConnection(server)) return { ok: false, error: `Unknown server '${server}'. Add it first, or use one of your saved connections.` };
  const pf = parseForward(spec);
  if (!pf) return { ok: false, error: "Bad spec. Examples: 9090:5432  9090:db:5432  R:8080:localhost:80  D:1080" };
  store.tunnels.push({ ...pf, name, server });
  writeStore(store);
  return { ok: true };
}

/** Edit a tunnel: re-point its server, rename, or change the forward spec. */
export function updateTunnel(name: string, patch: { server?: string; spec?: string; newName?: string; }): { ok: boolean; error?: string; } {
  const store = readStore();
  const t = store.tunnels.find((x) => x.name === name);
  if (!t) return { ok: false, error: `Unknown tunnel '${name}'.` };
  if (patch.newName !== undefined && patch.newName !== name) {
    const issue = tunnelNameIssue(patch.newName);
    if (issue) return { ok: false, error: issue };
    if (store.tunnels.some((x) => x.name === patch.newName)) return { ok: false, error: `A tunnel named '${patch.newName}' already exists.` };
  }
  if (patch.server !== undefined && !getConnection(patch.server)) return { ok: false, error: `Unknown server '${patch.server}'.` };
  if (patch.spec !== undefined) {
    const pf = parseForward(patch.spec);
    if (!pf) return { ok: false, error: "Bad spec. Examples: 9090:5432  9090:db:5432  R:8080:localhost:80  D:1080" };
    t.type = pf.type; t.bind = pf.bind; t.host = pf.host; t.hostPort = pf.hostPort;
  }
  if (patch.server !== undefined) t.server = patch.server;
  if (patch.newName !== undefined && patch.newName) {
    // Carry the running-state record over to the new name so an active tunnel stays tracked.
    const state = readState();
    if (state[name]) { state[patch.newName] = state[name]!; delete state[name]; writeState(state); }
    t.name = patch.newName;
  }
  writeStore(store);
  return { ok: true };
}

/** Delete a tunnel (stopping it first if it is running). */
export function removeTunnel(name: string): boolean {
  const store = readStore();
  const before = store.tunnels.length;
  store.tunnels = store.tunnels.filter((t) => t.name !== name);
  if (store.tunnels.length === before) return false;
  if (tunnelActive(name)) stopTunnel(name);
  writeStore(store);
  return true;
}

// --- lifecycle (background ssh -N) ----------------------------------------------

/** Start a tunnel as a detached background `ssh -N`. No-op (ok) when already running. */
export function startTunnel(name: string): { ok: boolean; error?: string; } {
  const t = getTunnel(name);
  if (!t) return { ok: false, error: `Unknown tunnel '${name}'.` };
  if (tunnelActive(name)) return { ok: true };
  const conn = getConnection(t.server);
  if (!conn) return { ok: false, error: `The tunnel's server '${t.server}' no longer exists. Edit the tunnel to bind it to an existing connection.` };
  const launcher = resolveLauncher(conn, { forwards: [toForward(t)], tunnelOnly: true });
  // ExitOnForwardFailure keeps a tunnel from lingering uselessly when its local port is taken;
  // ServerAliveInterval drops it if the link dies, so the status reflects reality.
  const args = ["-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", ...launcher.args];
  try {
    const child = spawn(launcher.command, args, { env: launcher.env, detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => { /* the tunnel simply did not start; status stays inactive */ });
    const pid = child.pid;
    child.unref();
    if (!pid) return { ok: false, error: "Could not start the tunnel process." };
    const state = readState();
    state[name] = { pid, startedAt: Date.now() };
    writeState(state);
    return { ok: true };
  } catch (e) { return { ok: false, error: `Could not start the tunnel: ${(e as Error).message}` }; }
}

/** Stop a running tunnel. */
export function stopTunnel(name: string): { ok: boolean; error?: string; } {
  const state = readState();
  const rec = state[name];
  if (!rec) return { ok: true }; // already stopped
  killPid(rec.pid);
  delete state[name];
  writeState(state);
  return { ok: true };
}

/** Dispatch a named tunnel action (for the CLI/dashboard). */
export function runTunnelAction(op: string, name: string): { ok: boolean; error?: string; } {
  switch (op) {
    case "start": case "up": return startTunnel(name);
    case "stop": case "down": return stopTunnel(name);
    default: return { ok: false, error: `Unknown action: ${op}` };
  }
}
