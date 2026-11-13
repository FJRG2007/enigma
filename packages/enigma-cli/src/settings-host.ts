/**
 * The host-facing half of `enigma config`: describe every setting as JSON (`config --json`), and
 * apply many settings in one process (`config set k=v ...`, `config apply --file <json>`).
 *
 * Both read the one registry (settings-registry.ts) plus the value keys settings.ts owns, so a
 * host builds its settings form from the same list the CLI and the TUI use.
 */

import { enigmaHome } from "./util";
import { CliError, EXIT_FAILED } from "./cli-json";
import { VALUE_CONFIG_KEYS, VALUE_KEY_RULES, runConfigCli } from "./settings";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { CONFIG_DEFAULTS, configFilePath, readConfig, type EnigmaConfigKey } from "./config";
import { ALL_SETTINGS, CATEGORIES, parseBool, type Scope, type Setting } from "./settings-registry";

/** Bumped when a field of the documents below changes meaning or goes away (fields are only added). */
export const CONFIG_SCHEMA_VERSION = 1;

export type SettingKind = "boolean" | "choice" | "value" | "list";

export interface SettingDescription {
    key: string;
    category: string;
    label: string;
    description: string;
    kind: SettingKind;
    choices: readonly string[] | null;
    /** "global": only the user-wide config; "any": also settable per project with -l. */
    scope: "global" | "any";
    /**
     * Where the value lives: enigma's .enigma.json, or another tool's config (an agent's settings,
     * the commit guard's file, gh). An external setting's default is that tool's own: null here.
     */
    storage: "enigma" | "external";
    secret: boolean;
    default: unknown;
    current: unknown;
    /** For a secret: whether one is stored. Never the value itself. */
    set?: boolean;
}

/** Hints for the value keys outside the registry (they have no label/hint of their own there). */
const VALUE_KEY_HINTS: Record<string, string> = {
    "statusline-refresh": "status bar timer in seconds (0 = refresh only on conversation events)",
    "token-price": "USD per 1M input tokens for the savings estimate (0 = per-source defaults)",
    "token-speed": "model prefill speed in tokens/s for the time-saved estimate (0 = default)",
    "dashboard-port": "preferred dashboard port (0 = auto)",
    "dashboard-bind": "interface the dashboard listens on (anything but loopback needs a token)",
    "dashboard-bind-address": "interface address for dashboard-bind custom",
    "plan-session-limit": "token cap of the 5h session window (0 = unset)",
    "plan-weekly-limit": "weekly token cap (0 = unset)",
    "plan-weekly-sonnet-limit": "weekly Sonnet token cap (0 = unset)",
    "plan-weekly-opus-limit": "weekly Opus token cap (0 = unset)",
    "plan-weekly-reset": "weekly window reset, \"<weekday> HH:MM\"",
};

/** The .enigma.json field behind a CLI key, by the kebab-to-camel convention every key follows. */
function fieldOf(key: string): EnigmaConfigKey | null {
    const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as EnigmaConfigKey;
    return camel in CONFIG_DEFAULTS ? camel : null;
}

function kindOf(s: Setting): SettingKind {
    return s.kind ?? (s.choices ? "choice" : "boolean");
}

/**
 * A default in the form `current` reports it: a value setting as the string its reader returns, a
 * choice as its name, a toggle as a boolean.
 */
function defaultOf(s: Setting): unknown {
    const field = fieldOf(s.key);
    if (!field || s.secret) return null;
    const def = CONFIG_DEFAULTS[field];
    return kindOf(s) === "value" ? String(def) : def;
}

function currentOf(s: Setting, scope: Scope): unknown {
    switch (kindOf(s)) {
        case "list": return s.listValues ? s.listValues(scope) : [];
        case "value": return s.secret ? null : (s.readValue ? s.readValue(scope) : null);
        case "choice": return s.readChoice ? s.readChoice(scope) : s.read(scope);
        default: return s.read(scope);
    }
}

/**
 * True when there is a home to read settings from. In a container with no HOME (or one pointing
 * at nothing) every setting is reported at its default instead of failing.
 */
export function hasHome(): boolean {
    try { return existsSync(enigmaHome()); } catch { return false; }
}

/**
 * Every setting with its default and current value. `defaultsOnly` (or no home) reports
 * current = default and reads nothing - no config file, no agent config, no subprocess.
 */
export function describeSettings(defaultsOnly: boolean): SettingDescription[] {
    const live = !defaultsOnly && hasHome();
    const out: SettingDescription[] = [];
    for (const category of CATEGORIES) {
        for (const s of category.settings) {
            const scope: Scope = "global";
            const def = defaultOf(s);
            const row: SettingDescription = {
                key: s.key, category: category.title, label: s.label, description: s.hint,
                kind: kindOf(s), choices: s.choices ?? null,
                scope: s.globalOnly ? "global" : "any",
                storage: fieldOf(s.key) ? "enigma" : "external",
                secret: Boolean(s.secret),
                default: def,
                current: live ? currentOf(s, scope) : def,
            };
            if (s.secret) row.set = live ? Boolean(s.readValue?.(scope)) : false;
            out.push(row);
        }
    }
    for (const key of VALUE_CONFIG_KEYS) {
        const field = fieldOf(key);
        const def = field ? String(CONFIG_DEFAULTS[field]) : null;
        const current: unknown = live && field ? String(readConfig().config[field]) : def;
        out.push({
            key, category: "Values", label: key, description: VALUE_KEY_HINTS[key] ?? "",
            kind: "value", choices: null, scope: "any", storage: "enigma", secret: false,
            default: def, current,
        });
    }
    return out;
}

/** One requested change, as the CLI spells it. */
export interface SettingChange { key: string; value: string; }

/**
 * Turn `k=v` arguments into changes. Splits on the FIRST `=`, so a value may itself contain one
 * (a URL with a query string).
 */
export function parsePairs(args: readonly string[]): SettingChange[] {
    if (!args.length) throw new CliError("usage", "Usage: enigma config set <key>=<value> [<key>=<value> ...] [-g|-l]");
    return args.map((arg) => {
        const at = arg.indexOf("=");
        if (at <= 0) throw new CliError("invalid_pair", `'${arg}' is not <key>=<value>`);
        return { key: arg.slice(0, at).trim(), value: arg.slice(at + 1) };
    });
}

/** Largest settings file `config apply` reads. */
const APPLY_MAX_BYTES = 1024 * 1024;

/**
 * Read a `config apply` file: a JSON object of key -> value, where a value is a string, a number
 * or a boolean (true/false are written as on/off).
 */
export function readApplyFile(path: string): SettingChange[] {
    let raw: string;
    try {
        if (statSync(path).size > APPLY_MAX_BYTES) throw new CliError("file_too_large", `${path} is larger than ${APPLY_MAX_BYTES} bytes`);
        raw = readFileSync(path, "utf8");
    } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError("file_unreadable", `cannot read ${path}: ${(err as Error).message}`);
    }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new CliError("invalid_json", `${path} is not valid JSON`); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new CliError("invalid_file", `${path} must hold a JSON object of "<key>": <value>`);
    const entries = Object.entries(data as Record<string, unknown>);
    if (!entries.length) throw new CliError("invalid_file", `${path} sets nothing`);
    return entries.map(([key, value]) => {
        if (typeof value === "boolean") return { key, value: value ? "on" : "off" };
        if (typeof value === "number" && Number.isFinite(value)) return { key, value: String(value) };
        if (typeof value === "string") return { key, value };
        throw new CliError("invalid_value", `'${key}': a value must be a string, a number or true/false`);
    });
}

/**
 * Validate one change without writing anything. Returns the reason it would be refused, or null.
 * Mirrors exactly what the single-key command accepts.
 */
export function checkChange(change: SettingChange): string | null {
    const { key, value } = change;
    const rule = VALUE_KEY_RULES[key];
    if (rule) return rule(value) ? null : `invalid value '${value}' for '${key}'`;
    const s = ALL_SETTINGS.find((x) => x.key === key);
    if (!s) return `unknown config key '${key}'`;
    switch (kindOf(s)) {
        case "list":
            return `'${key}' is a list; edit it with: enigma config ${key} add|remove <entry>`;
        case "value":
            try { s.checkValue?.(value); return null; } catch (err) { return `'${key}': ${(err as Error).message}`; }
        case "choice": {
            const v = value.toLowerCase();
            return s.choices!.includes(v) || parseBool(value) !== null ? null : `'${key}' takes one of: ${s.choices!.join(", ")} (on/off also work)`;
        }
        default:
            return parseBool(value) !== null ? null : `'${key}' takes on or off`;
    }
}

/** Snapshot of the config files a batch may write, to restore if a write fails part way. */
function snapshot(paths: string[]): Map<string, string | null> {
    return new Map(paths.map((p) => [p, existsSync(p) ? readFileSync(p, "utf8") : null]));
}

function restore(saved: Map<string, string | null>): void {
    for (const [path, content] of saved) {
        try {
            if (content === null) rmSync(path, { force: true });
            else writeFileSync(path, content);
        } catch { /* best effort; the error that triggered the restore is what gets reported */ }
    }
}

export interface BatchResult { applied: SettingChange[]; scope: Scope; }

/**
 * Apply every change in one process. The whole batch is validated first and NOTHING is written
 * when any change is refused. A write that fails part way (a locked file) restores both
 * .enigma.json files to their state before the batch; what an earlier write changed in an agent's
 * own config is re-derived from .enigma.json by the next sync, so it converges back.
 *
 * `quiet` swallows the per-key lines the single-key command prints (JSON mode).
 */
export async function applyBatch(changes: SettingChange[], scope: Scope | null, quiet: boolean): Promise<BatchResult> {
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const c of changes) {
        if (seen.has(c.key)) problems.push(`'${c.key}' is set more than once`);
        seen.add(c.key);
        const why = checkChange(c);
        if (why) problems.push(why);
    }
    if (problems.length) throw new CliError("invalid_batch", `nothing was written: ${problems.join("; ")}`);

    const saved = snapshot([configFilePath("global"), configFilePath("local")]);
    const applied: SettingChange[] = [];
    const log = console.log;
    const err = console.error;
    const errors: string[] = [];
    if (quiet) console.log = () => {};
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); if (!quiet) err(...a); };
    try {
        for (const c of changes) {
            const code = await runConfigCli([c.key, c.value], scope, false);
            if (code !== 0) {
                restore(saved);
                throw new CliError("write_failed", `'${c.key}' could not be written (${errors.at(-1) ?? `exit ${code}`}); the batch was rolled back`, EXIT_FAILED);
            }
            applied.push(c);
        }
    } finally {
        console.log = log;
        console.error = err;
    }
    return { applied, scope: scope ?? "global" };
}
