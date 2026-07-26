/**
 * Bridge exposing the SSH connection manager to the dashboard SSH subpage. The store, encryption
 * and argv building live in ssh.ts; this is the thin shaping + action layer the loopback server
 * calls. dashboard.ts imports it DYNAMICALLY (only when the SSH subpage is used), so there is no
 * static import cycle.
 *
 * The browser cannot spawn an interactive ssh session, so "connect" and "tunnel" return the
 * `enigma ssh ...` command for the UI to show/copy - the same pattern as launching a pack. All
 * management (add/edit/remove connections and forwards) works fully from the dashboard; a password
 * typed here travels only over the origin-guarded loopback and is stored encrypted at rest.
 */

import {
  listTunnels, addTunnel, updateTunnel, removeTunnel, startTunnel, stopTunnel,
  type TunnelView,
} from "./ssh-tunnels";
import {
  listConnections, getConnection, addConnection, updateConnection, removeConnection,
  addForward, removeForward, parseForward, describeForward, sshTarget,
  RESERVED_CONNECTION_KEYS,
  type SshConnectionView, type SshInput,
} from "./ssh";

/** A connection shaped for the UI: the redacted view plus human forward descriptions. */
export interface SshRow extends SshConnectionView {
  target: string;
  forwardLabels: string[];
}

function rowOf(c: SshConnectionView): SshRow {
  return {
    ...c,
    target: sshTarget(c as never),
    forwardLabels: (c.forwards ?? []).map(describeForward),
  };
}

/** All saved connections for the SSH subpage. */
export function listSshForDashboard(): SshRow[] {
  return listConnections().map(rowOf);
}

export interface SshActionResult {
  ok: boolean;
  error?: string;
  note?: string;
  /** Set by connect/tunnel: the command the user runs in a terminal (browser cannot spawn). */
  command?: string;
  /** The refreshed connection list after a mutating action. */
  connections?: SshRow[];
  /** The refreshed standalone-tunnel list (with live status) after a mutating action. */
  tunnels?: TunnelView[];
  /** Reserved names, resent with every refresh so the form's live check stays in sync. */
  reserved?: SshReserved;
}

/** The editable fields the dashboard sends for add/edit. */
interface SshPayload extends SshInput {
  alias?: string;
  /** The connection's alternate name key (distinct from a forward's `name` below). */
  serverName?: string;
  /** Forward spec for forward-add. */
  spec?: string;
  /** Optional name for the forward being added (so it can be run by name). */
  name?: string;
  /** Forward index for forward-remove. */
  index?: number;
  /** Extra tunnel specs for the connect/tunnel command builders. */
  specs?: string[];
  /** Raw options as one string ("K=V,K2=V2") or an array. */
  optionsRaw?: string;
  /** Standalone-tunnel fields (tunnel-* actions). */
  tunnelName?: string;
  tunnelServer?: string;
  tunnelSpec?: string;
  tunnelNewName?: string;
}

/**
 * The names the CLI already claims, so the form can reject them as the user types. Only the
 * connection keys are sent: a standalone tunnel's name is never a dispatch token, and the
 * forward names that are one have no field in this UI.
 */
export interface SshReserved { connection: readonly string[]; }

/** Both lists the SSH subpage renders: connections and standalone tunnels (with live status). */
export function listSshData(): { connections: SshRow[]; tunnels: TunnelView[]; reserved: SshReserved } {
  return {
    connections: listSshForDashboard(),
    tunnels: listTunnels(),
    reserved: { connection: RESERVED_CONNECTION_KEYS },
  };
}

/** Turn the loose payload into a validated SshInput (options split, forwards ignored here). */
function toInput(p: SshPayload): SshInput {
  const input: SshInput = {};
  if (p.serverName !== undefined) input.name = String(p.serverName).trim();
  if (p.host !== undefined) input.host = String(p.host).trim();
  if (p.user !== undefined) input.user = String(p.user).trim();
  if (p.port !== undefined) input.port = Number(p.port) || undefined;
  if (p.identityFile !== undefined) input.identityFile = String(p.identityFile).trim();
  if (p.proxyJump !== undefined) input.proxyJump = String(p.proxyJump).trim();
  if (p.forwardAgent !== undefined) input.forwardAgent = Boolean(p.forwardAgent);
  if (p.password !== undefined) input.password = String(p.password); // "" clears
  if (p.optionsRaw !== undefined) input.options = String(p.optionsRaw).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return input;
}

/**
 * Dispatch an SSH-subpage action. Mutating actions return the refreshed list. Never throws.
 *  - add / edit           : create or update a connection (password stored encrypted).
 *  - remove               : delete a connection.
 *  - forward-add / -remove: manage a connection's saved port forwards.
 *  - connect / tunnel     : return the `enigma ssh ...` command (the browser cannot spawn).
 */
export async function applySshAction(action: string, payload: SshPayload): Promise<SshActionResult> {
  const alias = typeof payload.alias === "string" ? payload.alias : "";
  const tName = typeof payload.tunnelName === "string" ? payload.tunnelName : "";
  const data = (): { connections: SshRow[]; tunnels: TunnelView[] } => listSshData();
  switch (action) {
    case "add": {
      const res = addConnection(alias, toInput(payload));
      return res.ok ? { ok: true, note: `Saved '${alias}'.`, ...data() } : { ok: false, error: res.error };
    }
    case "edit": {
      const res = updateConnection(alias, toInput(payload));
      return res.ok ? { ok: true, note: `Updated '${alias}'.`, ...data() } : { ok: false, error: res.error };
    }
    case "remove":
      if (!removeConnection(alias)) return { ok: false, error: `Unknown connection '${alias}'.` };
      return { ok: true, note: `Removed '${alias}'.`, ...data() };
    case "forward-add": {
      const pf = payload.spec ? parseForward(payload.spec) : null;
      if (!pf) return { ok: false, error: "Bad forward spec. Examples: 8080  9090:8080  9090:db:5432  R:8080:localhost:80  D:1080" };
      const nm = typeof payload.name === "string" ? payload.name.trim() : "";
      if (nm) pf.name = nm;
      const res = addForward(alias, pf);
      return res.ok ? { ok: true, note: `Added forward: ${describeForward(pf)}`, ...data() } : { ok: false, error: res.error };
    }
    case "forward-remove": {
      const res = removeForward(alias, Number(payload.index));
      return res.ok ? { ok: true, note: "Forward removed.", ...data() } : { ok: false, error: res.error };
    }
    // --- standalone tunnels ---
    case "tunnel-add": {
      const res = addTunnel(tName, payload.tunnelServer ?? "", payload.tunnelSpec ?? "");
      return res.ok ? { ok: true, note: `Added tunnel '${tName}'.`, ...data() } : { ok: false, error: res.error };
    }
    case "tunnel-edit": {
      const res = updateTunnel(tName, { server: payload.tunnelServer, spec: payload.tunnelSpec, newName: payload.tunnelNewName });
      return res.ok ? { ok: true, note: `Updated tunnel '${tName}'.`, ...data() } : { ok: false, error: res.error };
    }
    case "tunnel-remove":
      if (!removeTunnel(tName)) return { ok: false, error: `Unknown tunnel '${tName}'.` };
      return { ok: true, note: `Removed tunnel '${tName}'.`, ...data() };
    case "tunnel-start": {
      const res = startTunnel(tName);
      return res.ok ? { ok: true, note: `Tunnel '${tName}' started.`, ...data() } : { ok: false, error: res.error };
    }
    case "tunnel-stop": {
      const res = stopTunnel(tName);
      return res.ok ? { ok: true, note: `Tunnel '${tName}' stopped.`, ...data() } : { ok: false, error: res.error };
    }
    case "connect":
    case "tunnel": {
      if (!getConnection(alias)) return { ok: false, error: `Unknown connection '${alias}'.` };
      const cmd = action === "tunnel" ? `enigma ssh tunnel ${alias}` : `enigma ssh ${alias}`;
      return { ok: true, command: cmd, note: `Run "${cmd}" in a terminal.` };
    }
    default:
      return { ok: false, error: `unknown action: ${action}` };
  }
}
