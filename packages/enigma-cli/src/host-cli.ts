/**
 * The machine-facing commands a platform calls when it embeds enigma (a hosted coding agent, a
 * chat backend): every one prints one JSON document under `--json`, never prompts, and exits
 * non-zero with `{ "error": { "code", "message" } }` on bad input.
 *
 *   enigma skills list --json [agent]
 *   enigma skills enable|disable <name...> [agent] [--json]
 *   enigma config --json [--defaults]
 *   enigma config set <key>=<value>... [-g|-l] [--json]
 *   enigma config apply --file <settings.json> [-g|-l] [--json]
 *   enigma memory render --target generic [--compact] [--skills | -s a,b] [-p <file>] [--json]
 *   enigma serve --http --data-dir <dir> --token-file <file> [--host] [--port] [--workspace-root]
 */

import * as acct from "./accounts";
import { readConfig } from "./config";
import * as skillsMod from "./skills";
import { writeFileSync } from "node:fs";
import type { Scope } from "./settings-registry";
import { CliError, EXIT_FAILED, fail, failWith, printJson } from "./cli-json";
import { CONFIG_SCHEMA_VERSION, applyBatch, describeSettings, hasHome, parsePairs, readApplyFile } from "./settings-host";

/** Bumped when a field of a document below changes meaning or disappears; fields are only added. */
export const HOST_SCHEMA_VERSION = 1;

/** The options the host commands read (a subset of the CLI's parsed options). */
export interface HostOptions {
    json: boolean;
    scope: Scope | null;
    skills: string[];
    allSkills: boolean;
    compact: boolean;
    defaults: boolean;
    dest: string | null;
    file: string | null;
    target: string | null;
    http: boolean;
    dataDir: string | null;
    tokenFile: string | null;
    host: string | null;
    port: number | null;
    workspaceRoot: string | null;
    maxBody: number | null;
    agents: string[];
}

/**
 * `enigma skills list --json [agent]`: the catalogue straight from the package, with each skill's
 * state. Works with no install and no home (then nothing is disabled).
 */
export function skillsListJson(agent: string | undefined, version: string): number {
    if (agent && !acct.isToolName(agent)) return fail("unknown_agent", `Unknown agent '${agent}'. Use one of: ${acct.TOOL_NAMES.join(", ")}.`, true);
    try {
        const skills = skillsMod.listSkillsStatus().map((s) => {
            const entry = skillsMod.inspectSkills().find((e) => e.name === s.name);
            return {
                name: s.name,
                description: s.description,
                version: s.version,
                provider: entry?.meta.provider ?? null,
                // Every skill can be turned off today; the field exists so a future
                // always-on skill can say so without changing the shape.
                disableable: true,
                disabled: s.discarded || (agent ? s.agentsOff.includes(agent) : false),
                ...(agent ? {} : { disabledFor: s.agentsOff }),
            };
        });
        printJson({ schemaVersion: HOST_SCHEMA_VERSION, enigmaVersion: version, agent: agent ?? null, skills });
        return 0;
    } catch (err) {
        return failWith(err, true);
    }
}

/**
 * `enigma skills enable|disable <name...> [agent]`: several skills in one call. Every name is
 * checked before anything changes; deployments are synced once at the end.
 */
export function skillsToggleMany(sub: "enable" | "disable", args: string[], opts: HostOptions): number {
    const names = args.flatMap((a) => a.split(",")).map((n) => n.trim()).filter(Boolean);
    let agent: string | undefined = opts.agents.length === 1 ? opts.agents[0] : undefined;
    if (opts.agents.length > 1) return fail("usage", "Pass one agent at a time.", opts.json);
    if (!agent && names.length > 1 && acct.isToolName(names[names.length - 1]!)) agent = names.pop();
    if (!names.length) return fail("usage", `Usage: enigma skills ${sub} <name...> [agent]`, opts.json);
    if (agent && !acct.isToolName(agent)) return fail("unknown_agent", `Unknown agent '${agent}'. Use one of: ${acct.TOOL_NAMES.join(", ")}.`, opts.json);

    const status = skillsMod.listSkillsStatus();
    const unknown = names.filter((n) => !status.some((s) => s.name === n));
    if (unknown.length) return fail("unknown_skill", `Unknown skill(s): ${unknown.join(", ")}. Nothing was changed. See: enigma skills list.`, opts.json);
    const off = sub === "disable";
    const blocked = agent ? names.filter((n) => status.find((s) => s.name === n)!.discarded) : [];
    if (blocked.length) return fail("globally_disabled", `Globally disabled, enable them first: ${blocked.join(", ")}. Nothing was changed.`, opts.json);

    const isOff = (n: string): boolean => {
        const s = status.find((x) => x.name === n)!;
        return agent ? s.agentsOff.includes(agent) : s.discarded;
    };
    const changed = [...new Set(names)].filter((n) => isOff(n) !== off);
    const unchanged = [...new Set(names)].filter((n) => isOff(n) === off);
    try {
        const notices = changed.length ? skillsMod.setSkillsState(changed, off, agent) : [];
        if (opts.json) {
            printJson({ schemaVersion: HOST_SCHEMA_VERSION, action: sub, agent: agent ?? null, changed, unchanged, synced: notices });
        } else {
            for (const n of notices) console.log(`Synced ${n}.`);
            if (changed.length) console.log(`${off ? "Disabled" : "Enabled"}${agent ? ` for ${agent}` : ""}: ${changed.join(", ")}.`);
            if (unchanged.length) console.log(`Already ${off ? "off" : "on"}: ${unchanged.join(", ")}.`);
        }
        return 0;
    } catch (err) {
        return failWith(err, opts.json);
    }
}

/**
 * What `current` was read from: "defaults" when nothing was read (--defaults, no home) or no
 * .enigma.json exists, "effective" when a config file contributed.
 */
function configSource(defaultsOnly: boolean): "defaults" | "effective" {
    if (defaultsOnly || !hasHome()) return "defaults";
    return readConfig().sources.length ? "effective" : "defaults";
}

/**
 * `enigma config --json | set | apply`. Returns null when the arguments are not one of these, so
 * the classic `enigma config` handles them unchanged.
 */
export async function runConfigHost(positionals: string[], opts: HostOptions, version: string): Promise<number | null> {
    const [sub, ...rest] = positionals;
    try {
        if (!sub && opts.json) {
            const settings = describeSettings(opts.defaults);
            printJson({ schemaVersion: HOST_SCHEMA_VERSION, enigmaVersion: version, configSchemaVersion: CONFIG_SCHEMA_VERSION, source: configSource(opts.defaults), settings });
            return 0;
        }
        if (sub === "set" || sub === "apply") {
            if (sub === "apply" && rest.length) throw new CliError("usage", "Usage: enigma config apply --file <settings.json> [-g|-l]");
            if (sub === "apply" && !opts.file) throw new CliError("usage", "Usage: enigma config apply --file <settings.json> [-g|-l]");
            const changes = sub === "set" ? parsePairs(rest) : readApplyFile(opts.file!);
            const result = await applyBatch(changes, opts.scope, opts.json);
            if (opts.json) printJson({ schemaVersion: HOST_SCHEMA_VERSION, applied: result.applied, scope: result.scope });
            else console.log(`Applied ${result.applied.length} setting(s) (${result.scope}).`);
            return 0;
        }
    } catch (err) {
        return failWith(err, opts.json);
    }
    return null;
}

/** `enigma memory render`: the contract as plain text for a non-agent host. */
export async function runMemoryCli(positionals: string[], opts: HostOptions, version: string): Promise<number> {
    const [sub] = positionals;
    if (sub !== "render") return fail("usage", "Usage: enigma memory render --target generic [--compact] [--skills | -s <a,b>] [-p <file>] [--json]", opts.json);
    const { RENDER_TARGETS, renderHostMemory } = await import("./memory-render");
    const target = opts.target ?? "generic";
    if (!(RENDER_TARGETS as readonly string[]).includes(target)) return fail("invalid_target", `Unknown target '${target}'. Use: ${RENDER_TARGETS.join(", ")}.`, opts.json);
    try {
        const skills = opts.allSkills ? "all" as const : opts.skills.length ? opts.skills : "none" as const;
        let result;
        try { result = renderHostMemory({ target: target as "generic", compact: opts.compact, skills }); }
        catch (err) { throw new CliError("unknown_skill", (err as Error).message); }
        if (opts.dest) writeFileSync(opts.dest, result.text);
        if (opts.json) {
            printJson({ schemaVersion: HOST_SCHEMA_VERSION, enigmaVersion: version, target, compact: opts.compact, skills: result.skills, bytes: Buffer.byteLength(result.text), sha256: result.sha256, ...(opts.dest ? { path: opts.dest } : { text: result.text }) });
        } else if (!opts.dest) {
            process.stdout.write(result.text);
        }
        return 0;
    } catch (err) {
        return failWith(err, opts.json);
    }
}

/** `enigma serve --http`: run the headless JSON API until the process is stopped. */
export async function runServeCli(opts: HostOptions, version: string): Promise<number> {
    const usage = "Usage: enigma serve --http --data-dir <dir> --token-file <file> [--host 127.0.0.1] [--port 24290] [--workspace-root <dir>] [--max-body <bytes>]";
    if (!opts.http) return fail("usage", `${usage}\n(--http is the only transport today.)`, opts.json);
    if (!opts.dataDir) return fail("usage", `--data-dir is required.\n${usage}`, opts.json);
    if (!opts.tokenFile) return fail("usage", `--token-file is required (a file holding the bearer token, at least 32 characters).\n${usage}`, opts.json);
    const { SERVE_DEFAULTS, readTokenFile, startServeServer } = await import("./serve/server");
    try { readTokenFile(opts.tokenFile); }
    catch (err) { return fail("invalid_token_file", (err as Error).message, opts.json); }
    const port = opts.port ?? SERVE_DEFAULTS.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) return fail("invalid_port", "--port must be 0-65535.", opts.json);
    const maxBody = opts.maxBody ?? SERVE_DEFAULTS.maxBody;
    if (!Number.isInteger(maxBody) || maxBody < 1024 || maxBody > 64 * 1024 * 1024) return fail("invalid_max_body", "--max-body must be 1024-67108864 bytes.", opts.json);
    try {
        const server = await startServeServer({
            dataDir: opts.dataDir, tokenFile: opts.tokenFile, host: opts.host ?? SERVE_DEFAULTS.host, port,
            workspaceRoot: opts.workspaceRoot, maxBody, maxText: SERVE_DEFAULTS.maxText, version,
            log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
        });
        const addr = server.address();
        const bound = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : String(addr);
        if (opts.json) printJson({ status: "listening", address: bound, version });
        else console.log(`enigma serve listening on http://${bound} (data: ${opts.dataDir})`);
        await new Promise<void>((resolve) => {
            const stop = (): void => { server.close(() => resolve()); };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
        });
        return 0;
    } catch (err) {
        return fail("listen_failed", `Could not start the server: ${(err as Error).message}`, opts.json, EXIT_FAILED);
    }
}
