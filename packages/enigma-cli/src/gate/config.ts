/**
 * Gate configuration: the global config (`~/.enigma/gate/config.yaml`) and the
 * per-repo config (`.enigma-gate.yaml` in a repo root), their merge, and the
 * security-critical trust boundary that decides which fields a contributor's
 * pushed branch is allowed to control.
 *
 * Faithful port of the Go `internal/config` package. Durations are represented
 * in milliseconds (consistent with `Date.now()`); the Go `time.Duration`
 * sentinel for "monitor forever" maps to CI_TIMEOUT_UNLIMITED (-1).
 */

import { dirname, join } from "node:path";
import { parseYaml, asRecord } from "./yaml";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
    allSteps,
    type StepName,
    AGENT_PI,
    AGENT_AUTO,
    AGENT_CODEX,
    AGENT_CLAUDE,
    AGENT_ROVODEV,
    AGENT_OPENCODE
} from "./types";

/** Per-repo gate config file name (read from a repo worktree or a git ref). */
export const REPO_CONFIG_FILE = ".enigma-gate.yaml";

/** The CI monitor's idle timeout when ci_timeout is unset: 7 days, in ms. */
export const DEFAULT_CI_TIMEOUT = 7 * 24 * 60 * 60 * 1000;
/** Sentinel: monitor until the PR is merged/closed/aborted - never self-terminate. */
export const CI_TIMEOUT_UNLIMITED = -1;

/**
 * How the driving agent answers an approval gate, an enigma extension over the
 * upstream pipeline (which only ever knew "wait for a response"). It decides who
 * settles a finding, never what the pipeline itself is allowed to do:
 *
 * - `ask` - every gate comes back to the user, whatever it found.
 * - `assisted` - the agent settles what the review marked mechanical and comes
 *   back only for an `ask-user` finding whose answer is not already "yes, fix
 *   it": one that contradicts the request, undoes a deliberate decision, or
 *   takes a very large change. It authorizes the rest itself.
 * - `auto` - the agent settles every gate, including `ask-user` findings.
 */
export type FixPolicy = "ask" | "assisted" | "auto";

/** Accepted `fix_policy` values, in the order the dashboard offers them. */
export const FIX_POLICIES: FixPolicy[] = ["auto", "assisted", "ask"];

/** Asking only about what a machine cannot decide is the sane middle ground. */
export const DEFAULT_FIX_POLICY: FixPolicy = "assisted";

/** Narrows an arbitrary string to a FixPolicy, or null when it is not one. */
export function asFixPolicy(value: string): FixPolicy | null {
    return (FIX_POLICIES as string[]).includes(value) ? value as FixPolicy : null;
}

/** Optional per-repo command overrides. */
export interface Commands {
    lint: string;
    test: string;
    format: string;
}

/** Resolved per-step auto-fix attempt limits (0 = disabled, manual approval). */
export interface AutoFix {
    lint: number;
    test: number;
    review: number;
    document: number;
    ci: number;
    rebase: number;
}

/**
 * On-disk auto-fix config. Nullable fields distinguish "not set" (null) from
 * "set to 0" (explicitly disabled).
 */
export interface AutoFixRaw {
    lint?: number | null;
    test?: number | null;
    review?: number | null;
    document?: number | null;
    ci?: number | null;
    babysit?: number | null;
    rebase?: number | null;
}

/** Resolved test-evidence config. */
export interface Evidence {
    storeInRepo: boolean;
    dir: string;
}

export interface EvidenceRaw {
    storeInRepo?: boolean | null;
    dir?: string | null;
}

export interface Test {
    evidence: Evidence;
}

export interface TestRaw {
    evidence: EvidenceRaw;
}

/** Resolved user-intent extraction config. */
export interface Intent {
    enabled: boolean;
    threshold: number;
    slackDays: number;
    disabledReaders: Record<string, boolean>;
}

export interface IntentRaw {
    enabled?: boolean | null;
    threshold?: number | null;
    slackDays?: number | null;
    disabledReaders?: string[];
}

/** Global config (`~/.enigma/gate/config.yaml`). */
export interface GlobalConfig {
    agent: string;
    acpxPath: string;
    acpRegistryOverrides?: Record<string, string>;
    agentPathOverride?: Record<string, string>;
    agentArgsOverride?: Record<string, string[]>;
    agentStepArgsOverride?: Record<string, Record<string, string[]>>;
    ciTimeout: number;
    logLevel: string;
    /** Who settles an approval gate. Global only - it is a user preference, not a repo's. */
    fixPolicy: FixPolicy;
    autoFix: AutoFixRaw;
    intent: IntentRaw;
    test: TestRaw;
}

/** Per-repo config (`.enigma-gate.yaml`). */
export interface RepoConfig {
    agent: string;
    commands: Commands;
    ignorePatterns: string[];
    /**
     * Opts in to honoring the code-executing selection fields (commands and
     * agent) from a contributor's pushed branch instead of the trusted
     * default-branch copy. Read ONLY from the trusted default-branch copy, so a
     * contributor cannot self-enable. Default false.
     */
    allowRepoCommands: boolean;
    autoFix: AutoFixRaw;
    intent: IntentRaw;
    test: TestRaw;
}

/** Merged result of global + per-repo configuration. */
export interface Config {
    agent: string;
    acpxPath: string;
    acpRegistryOverrides?: Record<string, string>;
    agentPathOverride?: Record<string, string>;
    agentArgsOverride?: Record<string, string[]>;
    agentStepArgsOverride?: Record<string, Record<string, string[]>>;
    ciTimeout: number;
    logLevel: string;
    fixPolicy: FixPolicy;
    commands: Commands;
    ignorePatterns: string[];
    autoFix: AutoFix;
    intent: Intent;
    test: Test;
}

function emptyCommands(): Commands {
    return { lint: "", test: "", format: "" };
}

function emptyAutoFixRaw(): AutoFixRaw {
    return {};
}

function emptyRepoConfig(): RepoConfig {
    return {
        agent: "",
        commands: emptyCommands(),
        ignorePatterns: [],
        allowRepoCommands: false,
        autoFix: emptyAutoFixRaw(),
        intent: {},
        test: { evidence: {} }
    };
}

/** Default global config template written when no global config file exists. */
export const DEFAULT_CONFIG_YAML = `# enigma gate global configuration

# Agent to use for code generation
# Options: auto, claude, codex, rovodev, opencode, pi, acp:<target>
# "auto" detects the first available native agent on your system
# Use acp:<target> to run an optional user-installed acpx target, for example acp:gemini
agent: auto

# Optional path to the user-installed acpx binary for acp:<target> agents
# acpx_path: acpx

# Optional ACP target command overrides for acp:<target> agents
# acp_registry_overrides:
#   local-gemini: node /opt/mock-acp-agent.mjs

# Maximum time the CI monitor babysits an open PR with no base-branch movement
# before giving up. The monitor watches CI and auto-rebases when the base branch
# advances; each base advance re-arms this timer, so an actively-updated green PR
# keeps its monitor. Set to "unlimited", "none", "off", "never", or any
# non-positive duration to monitor until the PR is merged, closed, or the run is
# aborted with: enigma gate axi abort --run <id>
ci_timeout: "168h"

# Log level for daemon output
# Options: debug, info, warn, error
log_level: info

# Who settles a review finding when the pipeline parks for approval.
#   auto     - the agent fixes everything and never checks back
#   assisted - the agent fixes what the review marked mechanical, and asks you
#              only when the answer is not already "yes, fix it": the finding
#              contradicts what you asked for, undoes a deliberate decision,
#              or takes a very large change
#   ask      - every gate comes back to you
# Passing --yes to "enigma gate axi run" forces auto for that run.
fix_policy: assisted

# Override native agent binary paths (optional)
# agent_path_override:
#   claude: /usr/local/bin/claude
#   codex: /opt/codex

# Extra native agent CLI flags (optional, global only)
# agent_args_override:
#   codex:
#     - -m
#     - gpt-5.4

# Per-step flags, layered over agent_args_override (optional, global only).
# review is where the judgment is; test, document and lint are mechanical, and
# running them on a smaller model is the single biggest cut to a run's wall
# clock and cost that does not weaken the review. A step listed here uses ONLY
# its own flags; a step absent from the map keeps the agent-wide ones.
# agent_step_args_override:
#   claude:
#     test: ["--model", "claude-sonnet-5"]
#     document: ["--model", "claude-sonnet-5"]
#     lint: ["--model", "claude-sonnet-5"]
#
# Maximum follow-up auto-fix attempts per step (0 = disabled after the initial pass)
# Document fixes are attempted during the initial document pass.
auto_fix:
  rebase: 3
  lint: 3
  test: 3
  review: 0
  document: 3
  ci: 3

# User-intent extraction. When you push a branch, enigma gate can read recent
# transcripts from your local agent (Claude Code, Codex, OpenCode, Rovo Dev, Pi),
# pick the session that produced the change, summarize the user intent, and
# feed it to review, test, document, lint, and PR agents so they understand
# what you were trying to do - not just the diff.
intent:
  enabled: true
  threshold: 0.2
  slack_days: 3
  # disabled_readers: [codex]

# Test-step evidence artifacts (screenshots, recordings, logs the test step
# gathers to demonstrate the change works). By default they are kept in a
# temporary directory and referenced by local path. Opt in to store_in_repo to
# commit them into the repo under a readable, branch-named directory so they are
# pushed and render directly on the PR.
# test:
#   evidence:
#     store_in_repo: true
#     dir: .enigma-gate/evidence
`;

/** Default binary name per native agent. */
const DEFAULT_BINARY: Record<string, string> = {
    [AGENT_CLAUDE]: "claude",
    [AGENT_CODEX]: "codex",
    [AGENT_ROVODEV]: "acli",
    [AGENT_OPENCODE]: "opencode",
    [AGENT_PI]: "pi"
};

/** Priority order for auto-detecting agents. */
const AGENT_PROBE_ORDER: string[] = [AGENT_CLAUDE, AGENT_CODEX, AGENT_OPENCODE, AGENT_ROVODEV, AGENT_PI];

/** Every native agent name, in probe order. Exported for the env override and doctor. */
export const NATIVE_AGENTS: readonly string[] = AGENT_PROBE_ORDER;

/** The default binary name for a native agent, or the name itself when unknown. */
export function defaultAgentBinary(name: string): string {
    return DEFAULT_BINARY[name] ?? name;
}

/** Environment variable carrying a binary path override for one native agent. */
export function agentPathEnvVar(name: string): string {
    return `ENIGMA_AGENT_${name.toUpperCase()}`;
}

/**
 * Per-agent binary path overrides read from the environment
 * (`ENIGMA_AGENT_CLAUDE=/opt/harness/bin/claude`). This is how a sandboxed run
 * points the gate at an agent installed outside PATH - a container that installs
 * its agent into a private directory and launches it by absolute path would
 * otherwise be told "no supported agent found in PATH" on a machine that is
 * running one. Empty values are ignored; unknown agent names are not read.
 *
 * The daemon executes the pipeline, so it must inherit these: set them before
 * the daemon starts, or restart it (`enigma gate daemon restart`) after.
 */
export function agentPathOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of NATIVE_AGENTS) {
        const value = (env[agentPathEnvVar(name)] ?? "").trim();
        if (value !== "") out[name] = value;
    }
    return out;
}

/** Reports whether the agent name is a well-formed `acp:<target>` selector. */
export function isACPAgent(name: string): boolean {
    if (!name.startsWith("acp:")) return false;
    const target = name.slice("acp:".length);
    return target !== "" && !/[ \t\r\n]/.test(target);
}

/**
 * Probes whether `acli rovodev --help` is supported. Mirrors the Go probe: a
 * clean exit means supported; an "unknown command"-style failure means the
 * binary exists but lacks rovodev; a missing binary means not supported.
 */
export function probeRovoDevSupport(bin: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        execFile(bin, ["rovodev", "--help"], { timeout: 2000, windowsHide: true }, (err, stdout, stderr) => {
            if (!err) {
                resolve(true);
                return;
            }
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
                resolve(false);
                return;
            }
            if ((err as { killed?: boolean; }).killed) {
                reject(new Error(`probe rovodev support via "${bin}" timed out`));
                return;
            }
            const text = `${stdout}${stderr}`.toLowerCase();
            if (
                text.includes("unknown command") ||
                text.includes("unknown subcommand") ||
                text.includes("unrecognized command") ||
                text.includes("no help topic for")
            ) {
                resolve(false);
                return;
            }
            reject(new Error(`probe rovodev support via "${bin}": ${err.message}`));
        });
    });
}

/**
 * Resolves the `auto` agent to a concrete one by probing which binaries are on
 * PATH, in priority order. A no-op when `agent` is already concrete. `lookPath`
 * resolves a binary name to an absolute path or throws an ENOENT-like error.
 */
export async function resolveAgent(
    cfg: Config,
    lookPath: (bin: string) => Promise<string>
): Promise<void> {
    if (cfg.agent !== AGENT_AUTO) return;
    const probed: string[] = [];
    // A configured path is an explicit instruction, so a broken one is NAMED rather than
    // swallowed: silently falling through is how a typo in an override reads as "no agent
    // installed" on a machine running one. It is only fatal when nothing else resolves,
    // though - a stale ENIGMA_AGENT_CLAUDE in a shell profile must not break a run that
    // codex or opencode would have served.
    const broken: string[] = [];
    for (const name of AGENT_PROBE_ORDER) {
        let bin = DEFAULT_BINARY[name] ?? name;
        const override = cfg.agentPathOverride?.[name];
        if (override) bin = override;
        probed.push(bin);
        let resolvedBin: string;
        try {
            resolvedBin = await lookPath(bin);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                if (override) {
                    broken.push(
                        `the ${name} agent path override points at "${override}", which is not an executable file (set by ${agentPathEnvVar(name)} or agent_path_override.${name} in ~/.enigma/gate/config.yaml)`
                    );
                }
                continue;
            }
            throw new Error(`resolve ${name} agent from "${bin}": ${(err as Error).message}`);
        }
        if (name === AGENT_ROVODEV && !(await probeRovoDevSupport(resolvedBin))) continue;
        cfg.agent = name;
        return;
    }
    if (broken.length) {
        throw new Error(`no supported agent found (looked for: ${probed.join(", ")}); ${broken.join("; ")}`);
    }
    throw new Error(
        `no supported agent found in PATH (looked for: ${probed.join(", ")}); install one or set 'agent' in ~/.enigma/gate/config.yaml`
    );
}

/** Binary path for the configured agent (acpx for acp: agents, else native). */
export function agentPath(cfg: Config): string {
    if (isACPAgent(cfg.agent)) return cfg.acpxPath || "acpx";
    const override = cfg.agentPathOverride?.[cfg.agent];
    if (override) return override;
    return DEFAULT_BINARY[cfg.agent] ?? cfg.agent;
}

/**
 * Extra CLI args for the configured native agent, or empty when unset. With a
 * step, a per-step override for that step wins over the agent-wide one; steps
 * without an entry fall back to it, so an unconfigured gate behaves exactly as
 * before.
 */
export function agentArgs(cfg: Config, step?: StepName): string[] {
    if (step !== undefined) {
        const perStep = cfg.agentStepArgsOverride?.[cfg.agent]?.[step];
        if (perStep !== undefined) return perStep;
    }
    return cfg.agentArgsOverride?.[cfg.agent] ?? [];
}

/**
 * Projects a config onto one step by folding that step's arg override into
 * `agentArgsOverride`. Every agent adapter derives its extra args from that map,
 * so a per-step model reaches all five backends without touching any of them.
 * Returns the original config when the step resolves to the agent-wide args.
 */
export function configForStep(cfg: Config, step: StepName): Config {
    const stepArgs = agentArgs(cfg, step);
    const runArgs = agentArgs(cfg);
    // Compare by value: with no override configured each call builds a fresh
    // empty array, so an identity check would clone on every step.
    if (stepArgs.length === runArgs.length && stepArgs.every((a, i) => a === runArgs[i])) return cfg;
    return { ...cfg, agentArgsOverride: { ...cfg.agentArgsOverride, [cfg.agent]: stepArgs } };
}

const AGENT_ARGS_OVERRIDE_AGENTS = new Set([AGENT_CLAUDE, AGENT_CODEX, AGENT_ROVODEV, AGENT_OPENCODE, AGENT_PI]);

/** Flags enigma gate manages internally that users cannot override. */
const RESERVED_AGENT_ARGS: Record<string, Set<string>> = {
    [AGENT_CLAUDE]: new Set(["-p", "--print", "--verbose", "--output-format", "--json-schema"]),
    [AGENT_CODEX]: new Set(["exec", "--json", "--color"]),
    [AGENT_ROVODEV]: new Set(["rovodev", "serve", "--disable-session-token"]),
    [AGENT_OPENCODE]: new Set(["serve", "--hostname", "--port", "--print-logs"]),
    [AGENT_PI]: new Set(["--mode", "--no-session"])
};

/** Validates agent_args_override: known agent keys, no empty/reserved flags. */
export function validateAgentArgsOverride(override: Record<string, string[]>): void {
    for (const [name, args] of Object.entries(override)) {
        if (!AGENT_ARGS_OVERRIDE_AGENTS.has(name)) {
            throw new Error(
                `invalid agent name in agent_args_override: "${name}" (valid: claude, codex, rovodev, opencode, pi)`
            );
        }
        const reserved = RESERVED_AGENT_ARGS[name] ?? new Set<string>();
        args.forEach((arg, i) => {
            if (arg.trim() === "") {
                throw new Error(`invalid agent_args_override.${name}[${i}]: empty arg`);
            }
            const idx = arg.indexOf("=");
            const base = idx > 0 ? arg.slice(0, idx) : arg;
            if (reserved.has(base)) {
                throw new Error(
                    `invalid agent_args_override.${name}[${i}]: "${arg}" is managed by enigma gate and cannot be overridden`
                );
            }
        });
    }
}

const AGENT_STEP_ARGS_OVERRIDE_STEPS = new Set<string>(allSteps());

/**
 * Validates agent_step_args_override: known agent keys, known step keys, and the
 * same reserved-flag rules each per-step list must satisfy.
 */
export function validateAgentStepArgsOverride(override: Record<string, Record<string, string[]>>): void {
    for (const [name, steps] of Object.entries(override)) {
        if (!AGENT_ARGS_OVERRIDE_AGENTS.has(name)) {
            throw new Error(
                `invalid agent name in agent_step_args_override: "${name}" (valid: claude, codex, rovodev, opencode, pi)`
            );
        }
        for (const [step, args] of Object.entries(steps)) {
            if (!AGENT_STEP_ARGS_OVERRIDE_STEPS.has(step)) {
                throw new Error(
                    `invalid step in agent_step_args_override.${name}: "${step}" (valid: intent, rebase, review, test, document, lint, push, pr, ci)`
                );
            }
            validateAgentArgsOverride({ [name]: args });
        }
    }
}

/** Writes the default config file at path if it does not exist (best-effort). */
export function ensureDefaultGlobalConfig(path: string): void {
    if (existsSync(path)) return;
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, DEFAULT_CONFIG_YAML);
    } catch {
        // Best-effort: a config-write failure must not block the gate.
    }
}

const GLOBAL_KNOWN_KEYS = new Set([
    "agent",
    "acpx_path",
    "acp_registry_overrides",
    "agent_path_override",
    "agent_args_override",
    "agent_step_args_override",
    "ci_timeout",
    "babysit_timeout",
    "log_level",
    "fix_policy",
    "auto_fix",
    "intent",
    "test"
]);

function toStringMap(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = String(v);
    return out;
}

function toStringArrayMap(value: unknown): Record<string, string[]> | undefined {
    if (!value || typeof value !== "object") return undefined;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = Array.isArray(v) ? v.map(String) : [];
    }
    return out;
}

function toStringArrayMapMap(value: unknown): Record<string, Record<string, string[]>> | undefined {
    if (!value || typeof value !== "object") return undefined;
    const out: Record<string, Record<string, string[]>> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = toStringArrayMap(v) ?? {};
    }
    return out;
}

function parseAutoFixRaw(value: unknown): AutoFixRaw {
    const r = asRecord(value);
    const num = (v: unknown): number | null | undefined => (v === undefined ? undefined : v === null ? null : Number(v));
    return {
        lint: num(r.lint),
        test: num(r.test),
        review: num(r.review),
        document: num(r.document),
        ci: num(r.ci),
        babysit: num(r.babysit),
        rebase: num(r.rebase)
    };
}

function parseIntentRaw(value: unknown): IntentRaw {
    const r = asRecord(value);
    return {
        enabled: r.enabled === undefined ? undefined : Boolean(r.enabled),
        threshold: r.threshold === undefined ? undefined : Number(r.threshold),
        slackDays: r.slack_days === undefined ? undefined : Number(r.slack_days),
        disabledReaders: Array.isArray(r.disabled_readers) ? r.disabled_readers.map(String) : undefined
    };
}

function parseTestRaw(value: unknown): TestRaw {
    const ev = asRecord(asRecord(value).evidence);
    return {
        evidence: {
            storeInRepo: ev.store_in_repo === undefined ? undefined : Boolean(ev.store_in_repo),
            dir: ev.dir === undefined ? undefined : String(ev.dir)
        }
    };
}

/** Reads global config from path. Returns defaults if the file does not exist. */
export function loadGlobal(path: string): GlobalConfig {
    const cfg: GlobalConfig = {
        agent: AGENT_AUTO,
        acpxPath: "",
        ciTimeout: DEFAULT_CI_TIMEOUT,
        logLevel: "info",
        fixPolicy: DEFAULT_FIX_POLICY,
        autoFix: {},
        intent: {},
        test: { evidence: {} }
    };
    // Applied whether or not a config file exists: an ENIGMA_AGENT_<NAME> path is the
    // only way a sandboxed run can point the gate at an agent that is not on PATH, and
    // such a run usually has no config file at all. It wins over the file (below).
    const envOverrides = agentPathOverridesFromEnv();
    if (Object.keys(envOverrides).length > 0) cfg.agentPathOverride = envOverrides;
    let data: string;
    try {
        data = readFileSync(path, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return cfg;
        throw new Error(`read global config: ${(err as Error).message}`);
    }

    const raw = asRecord(parseYaml(data));
    for (const key of Object.keys(raw)) {
        if (!GLOBAL_KNOWN_KEYS.has(key)) throw new Error(`parse global config: unknown field "${key}"`);
    }

    if (typeof raw.agent === "string" && raw.agent !== "") cfg.agent = raw.agent;
    if (typeof raw.acpx_path === "string" && raw.acpx_path !== "") cfg.acpxPath = raw.acpx_path;
    const acpOverrides = toStringMap(raw.acp_registry_overrides);
    if (acpOverrides) cfg.acpRegistryOverrides = acpOverrides;
    const pathOverride = toStringMap(raw.agent_path_override);
    if (pathOverride) cfg.agentPathOverride = { ...pathOverride, ...envOverrides };
    const argsOverride = toStringArrayMap(raw.agent_args_override);
    if (argsOverride) {
        validateAgentArgsOverride(argsOverride);
        cfg.agentArgsOverride = argsOverride;
    }
    const stepArgsOverride = toStringArrayMapMap(raw.agent_step_args_override);
    if (stepArgsOverride) {
        validateAgentStepArgsOverride(stepArgsOverride);
        cfg.agentStepArgsOverride = stepArgsOverride;
    }
    let timeoutValue = typeof raw.ci_timeout === "string" ? raw.ci_timeout : "";
    if (timeoutValue === "" && typeof raw.babysit_timeout === "string") timeoutValue = raw.babysit_timeout;
    if (timeoutValue !== "") cfg.ciTimeout = parseCITimeout(timeoutValue);
    if (typeof raw.log_level === "string" && raw.log_level !== "") cfg.logLevel = raw.log_level;
    // Range-checked here rather than left to the daemon: this one governs whether the
    // user is asked at all, so a typo must fail at load instead of silently reading as
    // "never ask". Every writer goes through this loader, so the check holds everywhere.
    if (raw.fix_policy !== undefined && raw.fix_policy !== null) {
        const policy = asFixPolicy(String(raw.fix_policy));
        if (policy === null) throw new Error(`parse global config: fix_policy must be one of ${FIX_POLICIES.join(", ")}`);
        cfg.fixPolicy = policy;
    }
    cfg.autoFix = parseAutoFixRaw(raw.auto_fix);
    if (cfg.autoFix.ci === undefined || cfg.autoFix.ci === null) cfg.autoFix.ci = cfg.autoFix.babysit;
    cfg.intent = parseIntentRaw(raw.intent);
    cfg.test = parseTestRaw(raw.test);
    return cfg;
}

const GO_DURATION_UNITS: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    "µs": 1e-3,
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000
};

/** Parses a Go-style duration string (e.g. "168h", "30m", "1h30m") into ms. */
function parseGoDuration(value: string): number {
    const re = /([0-9]*\.?[0-9]+)(ns|us|µs|ms|s|m|h)/g;
    let total = 0;
    let matched = false;
    let consumed = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
        matched = true;
        consumed += m[0].length;
        total += parseFloat(m[1]) * GO_DURATION_UNITS[m[2]];
    }
    const sign = value.trim().startsWith("-") ? -1 : 1;
    if (!matched || consumed < value.replace(/^[+-]/, "").trim().length) {
        throw new Error(`parse ci_timeout "${value}": invalid duration`);
    }
    return sign * total;
}

/**
 * Interprets ci_timeout. "unlimited"/"none"/"off"/"never" or any non-positive
 * duration resolves to CI_TIMEOUT_UNLIMITED; otherwise it parses as a duration.
 */
export function parseCITimeout(value: string): number {
    switch (value.trim().toLowerCase()) {
        case "unlimited":
        case "none":
        case "off":
        case "never":
            return CI_TIMEOUT_UNLIMITED;
    }
    const d = parseGoDuration(value);
    if (d <= 0) return CI_TIMEOUT_UNLIMITED;
    return d;
}

/** Reads per-repo config from dir/.enigma-gate.yaml (zero-value if absent). */
export function loadRepo(dir: string): RepoConfig {
    const path = join(dir, REPO_CONFIG_FILE);
    let data: string;
    try {
        data = readFileSync(path, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyRepoConfig();
        throw new Error(`read repo config: ${(err as Error).message}`);
    }
    return parseRepoConfig(data);
}

/**
 * Parses per-repo config from raw YAML bytes. The trusted-config entry point:
 * callers reading .enigma-gate.yaml from a specific git ref use this.
 */
export function loadRepoFromBytes(data: string): RepoConfig {
    return parseRepoConfig(data);
}

function parseRepoConfig(data: string): RepoConfig {
    const raw = asRecord(parseYaml(data));
    const commandsRaw = asRecord(raw.commands);
    const cfg: RepoConfig = {
        agent: typeof raw.agent === "string" ? raw.agent : "",
        commands: {
            lint: typeof commandsRaw.lint === "string" ? commandsRaw.lint : "",
            test: typeof commandsRaw.test === "string" ? commandsRaw.test : "",
            format: typeof commandsRaw.format === "string" ? commandsRaw.format : ""
        },
        ignorePatterns: Array.isArray(raw.ignore_patterns) ? raw.ignore_patterns.map(String) : [],
        allowRepoCommands: Boolean(raw.allow_repo_commands),
        autoFix: parseAutoFixRaw(raw.auto_fix),
        intent: parseIntentRaw(raw.intent),
        test: parseTestRaw(raw.test)
    };
    if (cfg.autoFix.ci === undefined || cfg.autoFix.ci === null) cfg.autoFix.ci = cfg.autoFix.babysit;
    return cfg;
}

/**
 * Returns the repo config that should drive the pipeline given a pushed-branch
 * copy and the trusted default-branch copy. SECURITY: the code-executing
 * fields (commands, run verbatim via the shell on the daemon host; agent,
 * which selects which process launches with the maintainer's credentials) are
 * taken only from the trusted copy unless `allowRepoCommands` (itself read from
 * the trusted copy) opts in to the pushed copy wholesale. With no trusted copy
 * and no opt-in, both are forced empty rather than falling back to the pushed
 * branch - this blocks the supply-chain vector for repos that ship
 * .enigma-gate.yaml only on feature branches. Non-executing fields are always
 * taken from the pushed copy.
 */
export function effectiveRepoConfig(
    pushed: RepoConfig | null,
    trusted: RepoConfig | null,
    allowRepoCommands: boolean
): RepoConfig {
    const base = pushed ?? emptyRepoConfig();
    const effective: RepoConfig = { ...base, commands: { ...base.commands } };
    if (allowRepoCommands) return effective;
    if (trusted) {
        effective.commands = { ...trusted.commands };
        effective.agent = trusted.agent;
    } else {
        effective.commands = emptyCommands();
        effective.agent = "";
    }
    return effective;
}

/** Normalizes a log level string. Defaults to "info" for unknown values. */
export function parseLogLevel(level: string): "debug" | "info" | "warn" | "error" {
    switch (level) {
        case "debug":
        case "info":
        case "warn":
        case "error":
            return level;
        default:
            return "info";
    }
}

function intentDefaults(): Intent {
    return { enabled: true, threshold: 0.2, slackDays: 3, disabledReaders: {} };
}

function applyIntentOverrides(dst: Intent, src: IntentRaw): void {
    if (src.enabled !== undefined && src.enabled !== null) dst.enabled = src.enabled;
    if (src.threshold !== undefined && src.threshold !== null) dst.threshold = src.threshold;
    if (src.slackDays !== undefined && src.slackDays !== null) dst.slackDays = src.slackDays;
    if (src.disabledReaders && src.disabledReaders.length > 0) {
        for (const name of src.disabledReaders) dst.disabledReaders[name.trim().toLowerCase()] = true;
    }
}

function testDefaults(): Test {
    return { evidence: { storeInRepo: false, dir: ".enigma-gate/evidence" } };
}

function applyTestOverrides(dst: Test, src: TestRaw): void {
    if (src.evidence.storeInRepo !== undefined && src.evidence.storeInRepo !== null) {
        dst.evidence.storeInRepo = src.evidence.storeInRepo;
    }
    if (src.evidence.dir !== undefined && src.evidence.dir !== null && src.evidence.dir.trim() !== "") {
        dst.evidence.dir = src.evidence.dir.trim();
    }
}

function autoFixDefaults(): AutoFix {
    return { lint: 3, test: 3, review: 0, document: 3, ci: 3, rebase: 3 };
}

function applyAutoFixOverrides(dst: AutoFix, src: AutoFixRaw): void {
    if (src.lint !== undefined && src.lint !== null) dst.lint = src.lint;
    if (src.test !== undefined && src.test !== null) dst.test = src.test;
    if (src.review !== undefined && src.review !== null) dst.review = src.review;
    if (src.document !== undefined && src.document !== null) dst.document = src.document;
    if (src.ci !== undefined && src.ci !== null) dst.ci = src.ci;
    if (src.rebase !== undefined && src.rebase !== null) dst.rebase = src.rebase;
}

/** Max auto-fix attempts for a step; steps without auto-fix support return 0. */
export function autoFixLimit(cfg: Config, step: StepName): number {
    switch (step) {
        case "lint":
            return cfg.autoFix.lint;
        case "test":
            return cfg.autoFix.test;
        case "review":
            return cfg.autoFix.review;
        case "document":
            return cfg.autoFix.document;
        case "ci":
            return cfg.autoFix.ci;
        case "rebase":
            return cfg.autoFix.rebase;
        default:
            return 0;
    }
}

/**
 * Combines global and per-repo config. Per-repo agent overrides global when
 * non-empty; commands and ignore patterns come from repo config only.
 */
export function merge(global: GlobalConfig, repo: RepoConfig): Config {
    const af = autoFixDefaults();
    applyAutoFixOverrides(af, global.autoFix);
    applyAutoFixOverrides(af, repo.autoFix);

    const intent = intentDefaults();
    applyIntentOverrides(intent, global.intent);
    applyIntentOverrides(intent, repo.intent);

    const test = testDefaults();
    applyTestOverrides(test, global.test);
    applyTestOverrides(test, repo.test);

    const cfg: Config = {
        agent: global.agent,
        acpxPath: global.acpxPath,
        acpRegistryOverrides: global.acpRegistryOverrides,
        agentPathOverride: global.agentPathOverride,
        agentArgsOverride: global.agentArgsOverride,
        agentStepArgsOverride: global.agentStepArgsOverride,
        ciTimeout: global.ciTimeout,
        logLevel: global.logLevel,
        fixPolicy: global.fixPolicy,
        commands: repo.commands,
        ignorePatterns: repo.ignorePatterns,
        autoFix: af,
        intent,
        test
    };
    if (repo.agent !== "") cfg.agent = repo.agent;
    return cfg;
}
