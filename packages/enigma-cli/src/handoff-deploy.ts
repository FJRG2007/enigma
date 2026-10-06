/**
 * Wiring for handoffs (handoff.ts): delivering a saved handoff to the next session on every host
 * that has a session-start event, and, in Claude Code, relaying a long session on its own.
 *
 * DELIVERY (the `relay` toggle, on by default) - one `enigma __handoff-hook <host>` per host:
 *  - Claude Code: SessionStart in settings.json, matcher `startup|clear`.
 *  - Codex: SessionStart in ~/.codex/hooks.json (same JSON shape and output field as Claude's);
 *    written only where ~/.codex exists, so a machine without Codex gets no Codex config.
 *  - Kimi Code: a `[[hooks]]` SessionStart entry in config.toml, matcher `startup` (Kimi has no
 *    `clear` source; its stdout is added to the context).
 *  - OpenCode: an auto-loaded plugin that, on `session.created`, asks the hook for the handoff and
 *    posts it into the new session without asking for a reply.
 *
 * THE AUTOMATIC RELAY (Claude Code only, `relay-at` tokens, 0 = off): a Claude Code function-hook
 * mod (assets/mods/enigma-relay) loaded through CLAUDE_CODE_PLUGIN_DIRS. When a turn ends past the
 * threshold it asks for a handoff, and when the next turn ends with one saved it runs /clear and
 * submits "continue" - the SessionStart hook above puts the page in the fresh context. Only Claude
 * Code lets a plugin run a slash command and submit a prompt; on the other hosts no hook can clear a
 * session (their docs say so), so they get delivery, and `enigma relay` for unattended work.
 */

import { join } from "node:path";
import { kimiHome } from "./kimi";
import { readJson } from "./util";
import { enigmaHome } from "./util";
import { ASSETS_DIR } from "./assets-dir";
import { applyKimiHook } from "./kimi-hooks";
import { readConfig, setEnigmaToggle } from "./config";
import { applyClaudeHook, claudeGlobalSettings } from "./claude-hooks";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/** Marker of every handoff hook entry; the host argument follows it. */
const MARKER = "__handoff-hook";

/** Seconds a session-start hook may take: a process start on a slow host plus two small reads. */
const HOOK_TIMEOUT_S = 20;

/** Environment variable Claude Code reads extra plugin folders from (the settings `env` block). */
const PLUGIN_DIRS_ENV = "CLAUDE_CODE_PLUGIN_DIRS";

/** Lowest automatic-relay threshold: under it a session would relay before it did any work. */
export const MIN_RELAY_AT = 50_000;
export const MAX_RELAY_AT = 1_000_000;

/** Parses `relay-at`: tokens (a `k` suffix accepted) from 50k to 1000k, or `off`/`0` for no automatic relay. */
export function parseRelayAt(value: string): number {
    const text = value.trim().toLowerCase();
    if (text === "off" || text === "0") return 0;
    const m = /^(\d+)(k?)$/.exec(text);
    const n = m ? Number(m[1]) * (m[2] ? 1000 : 1) : NaN;
    if (!(n >= MIN_RELAY_AT && n <= MAX_RELAY_AT)) throw new Error(`expected a token count from ${MIN_RELAY_AT / 1000}k to ${MAX_RELAY_AT / 1000}k, or "off", got "${value}"`);
    return n;
}

/** True when handoff delivery (and the relay it carries) is on. */
export function isRelayOn(): boolean {
    return readConfig().config.relay;
}

/** Where enigma keeps the generated relay mod: outside the repo, beside its other state. */
export function relayModDir(): string {
    return join(enigmaHome(), ".enigma", "claude-mods", "enigma-relay");
}

/** The handoff pointer the mod reads, as a forward-slashed absolute path. */
function latestPath(): string {
    return join(enigmaHome(), ".enigma", "handoff", "latest.json").split("\\").join("/");
}

/**
 * Write the relay mod with this machine's values in it. Returns true when a file changed. The
 * bundled module carries placeholder values so it validates and tests as is; only the threshold
 * and the pointer path are replaced.
 */
export function writeRelayMod(relayAt: number, dir = relayModDir()): boolean {
    const src = join(ASSETS_DIR, "mods", "enigma-relay");
    const module = readFileSync(join(src, "hooks", "register.ts"), "utf8")
        .replace(/^const RELAY_AT = \d+;$/m, `const RELAY_AT = ${Math.max(1, Math.round(relayAt))};`)
        .replace(/^const LATEST = ".*";$/m, `const LATEST = ${JSON.stringify(latestPath())};`);
    const target = join(dir, "hooks", "register.ts");
    let current = "";
    try { current = readFileSync(target, "utf8"); } catch { /* not written yet */ }
    if (current === module && existsSync(join(dir, ".claude-plugin", "plugin.json"))) return false;
    mkdirSync(join(dir, "hooks"), { recursive: true });
    cpSync(join(src, ".claude-plugin"), join(dir, ".claude-plugin"), { recursive: true });
    cpSync(join(src, "hooks", "hooks.json"), join(dir, "hooks", "hooks.json"));
    writeFileSync(target, module);
    return true;
}

/** Add (on) or remove the mod folder in one settings.json's CLAUDE_CODE_PLUGIN_DIRS, keeping other folders. */
export function applyPluginDir(settingsPath: string, dir: string, on: boolean): boolean {
    const current = readJson<Record<string, unknown>>(settingsPath);
    if (current === null && existsSync(settingsPath)) return false;
    const settings = current ?? {};
    const env = typeof settings.env === "object" && settings.env !== null ? { ...settings.env as Record<string, string> } : {};
    const sep = process.platform === "win32" ? ";" : ":";
    const dirs = String(env[PLUGIN_DIRS_ENV] ?? "").split(sep).map((d) => d.trim()).filter(Boolean);
    const without = dirs.filter((d) => d !== dir);
    const next = on ? [...without, dir] : without;
    if (next.join(sep) === dirs.join(sep)) return false;
    if (next.length) env[PLUGIN_DIRS_ENV] = next.join(sep); else delete env[PLUGIN_DIRS_ENV];
    const out: Record<string, unknown> = { ...settings };
    if (Object.keys(env).length) out.env = env; else delete out.env;
    if (!existsSync(settingsPath) && !on) return false;
    mkdirSync(join(settingsPath, ".."), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(out, null, 2)}\n`);
    return true;
}

/** Claude Code: the SessionStart delivery hook plus, when relay-at is set, the relay mod. */
export function applyClaudeHandoffWiring(settingsPath: string): boolean {
    const { relay, relayAt } = readConfig().config;
    const group = { matcher: "startup|clear", hooks: [{ type: "command", command: `enigma ${MARKER} claude`, timeout: HOOK_TIMEOUT_S }] };
    let changed = applyClaudeHook(settingsPath, "SessionStart", `${MARKER} claude`, group, relay) === "changed";
    const auto = relay && relayAt > 0;
    if (auto && writeRelayMod(relayAt)) changed = true;
    if (applyPluginDir(settingsPath, relayModDir(), auto)) changed = true;
    return changed;
}

/** Codex: SessionStart in hooks.json, only where Codex's home exists. */
export function applyCodexHandoffHook(codexHome: string, on: boolean): boolean {
    if (!existsSync(codexHome)) return false;
    const path = join(codexHome, "hooks.json");
    const group = { matcher: "startup|clear", hooks: [{ type: "command", command: `enigma ${MARKER} codex`, timeout: HOOK_TIMEOUT_S }] };
    // Codex's hooks.json has Claude's settings.json shape for its `hooks` key, so the same merge applies.
    return applyClaudeHook(path, "SessionStart", `${MARKER} codex`, group, on) === "changed";
}

/** Kimi Code: a `[[hooks]]` SessionStart entry in config.toml. */
export function applyKimiHandoffHook(configPath: string, on: boolean): boolean {
    const hook = { event: "SessionStart", matcher: "startup", command: `enigma ${MARKER} kimi`, timeout: HOOK_TIMEOUT_S };
    return applyKimiHook(configPath, MARKER, hook, on) === "changed";
}

/** OpenCode plugin source: hands a new session the pending handoff, without asking for a reply. */
function opencodePluginSource(): string {
    return `// Generated by enigma (relay). Do not edit; toggle with 'enigma config relay off'.
import { spawnSync } from "node:child_process";

export const EnigmaHandoff = async ({ client, directory }) => ({
    event: async ({ event }) => {
        try {
            if (event.type !== "session.created") return;
            const id = event.properties && event.properties.info && event.properties.info.id;
            if (!id) return;
            const out = spawnSync("enigma", ["${MARKER}", "opencode"], {
                input: JSON.stringify({ cwd: directory, source: "startup" }),
                encoding: "utf8", timeout: ${HOOK_TIMEOUT_S * 1000}, shell: process.platform === "win32", windowsHide: true,
            });
            const text = (out.stdout || "").trim();
            if (!text) return;
            await client.session.prompt({ path: { id }, body: { noReply: true, parts: [{ type: "text", text }] } });
        } catch { /* never break a session start over a handoff */ }
    },
});
`;
}

/** OpenCode: write (on) or remove the delivery plugin in a config dir's plugins/. */
export function applyOpencodeHandoffPlugin(opencodeConfigDir: string, on: boolean): boolean {
    const path = join(opencodeConfigDir, "plugins", "enigma-handoff.js");
    if (!on) {
        if (!existsSync(path)) return false;
        rmSync(path, { force: true });
        return true;
    }
    const source = opencodePluginSource();
    let current = "";
    try { current = readFileSync(path, "utf8"); } catch { /* not written yet */ }
    if (current === source) return false;
    mkdirSync(join(opencodeConfigDir, "plugins"), { recursive: true });
    writeFileSync(path, source);
    return true;
}

/** Re-assert the default account's wiring on every host, presence and absence. */
export function applyHandoffWiring(): void {
    const on = isRelayOn();
    applyClaudeHandoffWiring(claudeGlobalSettings());
    applyCodexHandoffHook(join(enigmaHome(), ".codex"), on);
    applyKimiHandoffHook(join(kimiHome(), "config.toml"), on);
    applyOpencodeHandoffPlugin(join(enigmaHome(), ".config", "opencode"), on);
}

/** Mirror the wiring into a managed account's config dir. */
export function mirrorHandoffWiring(toolName: string, accountDir: string): void {
    const on = isRelayOn();
    if (toolName === "claude") applyClaudeHandoffWiring(join(accountDir, "settings.json"));
    else if (toolName === "codex") applyCodexHandoffHook(accountDir, on);
    else if (toolName === "kimi") applyKimiHandoffHook(join(accountDir, "config.toml"), on);
    else if (toolName === "opencode") applyOpencodeHandoffPlugin(join(accountDir, "xdg-config", "opencode"), on);
}

/** Persist the relay toggle and re-assert the wiring. */
export function setRelay(scope: "global" | "local", on: boolean): string {
    const path = setEnigmaToggle("relay", on, scope);
    applyHandoffWiring();
    return path;
}
