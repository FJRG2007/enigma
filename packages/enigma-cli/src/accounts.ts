/**
 * Native multi-account management for coding agents. Each account is just a
 * separate config directory; pointing the tool at it (via a tool-specific
 * environment variable) gives that account its own credentials and session, so a
 * user can keep e.g. a company login and a personal login side by side without
 * ever logging out.
 *
 * The OS-agnostic switch is the launcher itself: instead of generating shell
 * aliases (which differ per shell and OS), enigma spawns the tool as a child
 * process with the config-dir env var injected - one code path that behaves the
 * same on macOS, Linux and Windows.
 *
 * The design is tool-agnostic via the TOOLS registry: only Claude Code is wired
 * up today, but adding another agent (Codex via CODEX_HOME, opencode via
 * XDG_DATA_HOME/XDG_CONFIG_HOME) is a single registry entry, not a rewrite. Each
 * tool's existing config dir is surfaced as a synthetic, non-removable "default"
 * account so the user's current login is never lost; new accounts live under
 * ~/.enigma/<tool>/<name>/. This module is the pure data + spawn layer (Node
 * builtins only); the CLI wrapper in cli.ts does the prompting and printing.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isDir, readJson, resolveBin } from "./util";

/**
 * A coding agent enigma can manage accounts for. `envFor` maps an account's
 * config directory to the environment overrides that point the tool at it
 * (a Record so a tool needing several vars - e.g. opencode's XDG_* pair - fits
 * without changing this shape). `loginArgs` are passed to the binary for a
 * dedicated login flow; Claude has none, so connecting just launches it and the
 * user runs /login.
 */
export interface ToolSpec {
    name: string;
    label: string;
    bin: string;
    binEnv: string;
    defaultDir: string;
    envFor: (dir: string) => Record<string, string>;
    loginArgs?: string[];
    loginHint: string;
    /**
     * Best-effort read of the logged-in identity from an account's config dir
     * (e.g. the account email), so it can be shown in listings. Returns undefined
     * fields when the account has not been authenticated yet.
     */
    accountInfo?: (dir: string) => { email?: string; displayName?: string };
}

/** Registry of supported tools. Add an entry here to support a new agent. */
const TOOLS: Record<string, ToolSpec> = {
    claude: {
        name: "claude",
        label: "Claude Code",
        bin: "claude",
        binEnv: "ENIGMA_CLAUDE_BIN",
        defaultDir: join(homedir(), ".claude"),
        envFor: (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
        loginHint: "Launching Claude Code - run /login inside it to authenticate this account.",
        // Claude Code records the signed-in account under oauthAccount in
        // <config-dir>/.claude.json (no tokens there - those live elsewhere).
        accountInfo: (dir) => {
            const config = readJson<{ oauthAccount?: { emailAddress?: string; displayName?: string } }>(join(dir, ".claude.json"));
            return { email: config?.oauthAccount?.emailAddress, displayName: config?.oauthAccount?.displayName };
        },
    },
};

/** The tool assumed when a command omits one (keeps the common case terse). */
export const DEFAULT_TOOL = "claude";
export const TOOL_NAMES = Object.keys(TOOLS);

/** True when `name` is a supported tool. */
export function isToolName(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(TOOLS, name);
}

/** Resolve a tool spec by name, throwing on an unknown tool. */
export function getTool(name: string): ToolSpec {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`Unknown tool '${name}'. Known tools: ${TOOL_NAMES.join(", ")}.`);
    return tool;
}

/** Reserved name for a tool's built-in (existing) config-dir account. */
export const DEFAULT_NAME = "default";
const ENIGMA_DIR = join(homedir(), ".enigma");
/** Registry file mapping each tool's accounts to their config directories. */
const REGISTRY_PATH = join(ENIGMA_DIR, "accounts.json");

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface Account {
    name: string;
    dir: string;
    createdAt: string;
    lastUsed?: string;
}

/** An account plus display metadata: active flag, owning tool, and signed-in email. */
export interface AccountView extends Account {
    active: boolean;
    tool: string;
    toolLabel: string;
    email?: string;
}

/** Per-tool slice of the registry: its accounts and which one is active. */
interface ToolBucket {
    active: string | null;
    accounts: Account[];
}

interface Registry {
    tools: Record<string, ToolBucket>;
}

/**
 * Validate a user-supplied account name. Throws on anything that is not a short,
 * filesystem-safe slug, and rejects the reserved "default" so it cannot shadow a
 * tool's built-in account. Boundary validation keeps untrusted input from
 * reaching the filesystem as a path segment.
 */
export function validateAccountName(name: string): void {
    if (!NAME_PATTERN.test(name)) {
        throw new Error(`Invalid account name '${name}'. Use letters, digits, '.', '_' or '-' (max 64 chars).`);
    }
    if (name === DEFAULT_NAME) throw new Error(`'${DEFAULT_NAME}' is reserved for the tool's existing config-dir account.`);
}

/** Normalize a raw object into a ToolBucket, tolerating partial/legacy data. */
function normalizeBucket(raw: unknown): ToolBucket {
    const obj = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
    return {
        active: typeof obj.active === "string" ? obj.active : null,
        accounts: Array.isArray(obj.accounts) ? obj.accounts as Account[] : [],
    };
}

/**
 * Read the registry, migrating the legacy claude-only shape ({active, accounts})
 * into the tool-namespaced shape ({tools: {claude: ...}}). Returns an empty
 * registry when absent or unreadable.
 */
function readRegistry(): Registry {
    const raw = readJson<Record<string, unknown>>(REGISTRY_PATH);
    if (!raw || typeof raw !== "object") return { tools: {} };

    if (raw.tools && typeof raw.tools === "object") {
        const tools: Record<string, ToolBucket> = {};
        for (const [name, bucket] of Object.entries(raw.tools as Record<string, unknown>)) {
            tools[name] = normalizeBucket(bucket);
        }
        return { tools };
    }
    // Legacy shape: a flat {active, accounts} was always Claude Code.
    if (Array.isArray(raw.accounts)) return { tools: { [DEFAULT_TOOL]: normalizeBucket(raw) } };
    return { tools: {} };
}

/** Persist the registry, creating ~/.enigma if needed. */
function writeRegistry(reg: Registry): void {
    if (!isDir(ENIGMA_DIR)) mkdirSync(ENIGMA_DIR, { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
}

/** The accounts bucket for a tool (an empty one if it has none yet). */
function bucketOf(reg: Registry, tool: string): ToolBucket {
    return reg.tools[tool] ?? { active: null, accounts: [] };
}

/** Base directory holding a tool's managed account config directories. */
function accountsBase(tool: ToolSpec): string {
    return join(ENIGMA_DIR, tool.name);
}

/** The synthetic entry describing a tool's built-in (existing) config dir. */
function defaultAccount(tool: ToolSpec): Account {
    return { name: DEFAULT_NAME, dir: tool.defaultDir, createdAt: "" };
}

/**
 * Every account for a tool (the synthetic "default" first, then registered ones)
 * with an `active` flag. The active account is the bucket pointer, or "default"
 * when unset or pointing at an account that no longer exists.
 */
export function listAccounts(toolName: string = DEFAULT_TOOL): AccountView[] {
    const tool = getTool(toolName);
    const bucket = bucketOf(readRegistry(), toolName);
    const all = [defaultAccount(tool), ...bucket.accounts];
    const active = resolveActiveName(bucket, all);
    return all.map((a) => ({
        ...a,
        active: a.name === active,
        tool: tool.name,
        toolLabel: tool.label,
        email: tool.accountInfo?.(a.dir).email,
    }));
}

/** Name of a tool's active account, falling back to "default" when the pointer is stale. */
export function getActive(toolName: string = DEFAULT_TOOL): string {
    const tool = getTool(toolName);
    const bucket = bucketOf(readRegistry(), toolName);
    return resolveActiveName(bucket, [defaultAccount(tool), ...bucket.accounts]);
}

function resolveActiveName(bucket: ToolBucket, all: Account[]): string {
    if (bucket.active && all.some((a) => a.name === bucket.active)) return bucket.active;
    return DEFAULT_NAME;
}

/** Look up an account by name for a tool (including the synthetic "default"), or null. */
function findAccount(toolName: string, name: string): Account | null {
    const tool = getTool(toolName);
    if (name === DEFAULT_NAME) return defaultAccount(tool);
    return bucketOf(readRegistry(), toolName).accounts.find((a) => a.name === name) ?? null;
}

/** True when an account with this name exists for the tool. */
export function accountExists(toolName: string, name: string): boolean {
    return findAccount(toolName, name) !== null;
}

/**
 * Create (or return, if it already exists) a managed account for a tool.
 * Validates the name, creates its config directory under the tool's base, and
 * records it. Idempotent so re-running `account add` is safe.
 */
export function addAccount(toolName: string, name: string): Account {
    const tool = getTool(toolName);
    validateAccountName(name);
    const reg = readRegistry();
    const bucket = bucketOf(reg, toolName);
    const existing = bucket.accounts.find((a) => a.name === name);
    if (existing) {
        if (!isDir(existing.dir)) mkdirSync(existing.dir, { recursive: true });
        return existing;
    }
    const dir = join(accountsBase(tool), name);
    mkdirSync(dir, { recursive: true });
    const account: Account = { name, dir, createdAt: nowIso() };
    bucket.accounts.push(account);
    reg.tools[toolName] = bucket;
    writeRegistry(reg);
    return account;
}

/**
 * Make `name` the active account for a tool. Validates the account exists;
 * setting the built-in "default" clears the pointer rather than persisting the
 * reserved name.
 */
export function setActive(toolName: string, name: string): void {
    if (!accountExists(toolName, name)) throw new Error(`No such ${toolName} account: '${name}'.`);
    const reg = readRegistry();
    const bucket = bucketOf(reg, toolName);
    bucket.active = name === DEFAULT_NAME ? null : name;
    reg.tools[toolName] = bucket;
    writeRegistry(reg);
}

/**
 * Remove a managed account for a tool: drops it from the registry and deletes its
 * config directory. Refuses the built-in "default", and only deletes a directory
 * that lives inside the tool's base so a tampered registry can never point
 * removal at an arbitrary path. Clears the active pointer if it referenced this
 * account.
 */
export function removeAccount(toolName: string, name: string): void {
    const tool = getTool(toolName);
    if (name === DEFAULT_NAME) throw new Error(`The '${DEFAULT_NAME}' account (${tool.label}'s existing config) cannot be removed.`);
    const reg = readRegistry();
    const bucket = bucketOf(reg, toolName);
    const account = bucket.accounts.find((a) => a.name === name);
    if (!account) throw new Error(`No such ${toolName} account: '${name}'.`);

    if (isWithinBase(account.dir, accountsBase(tool)) && isDir(account.dir)) {
        rmSync(account.dir, { recursive: true, force: true });
    }
    bucket.accounts = bucket.accounts.filter((a) => a.name !== name);
    if (bucket.active === name) bucket.active = null;
    reg.tools[toolName] = bucket;
    writeRegistry(reg);
}

/** Config directory for a tool's account, ensuring the directory exists. Throws if unknown. */
export function resolveConfigDir(toolName: string, name: string): string {
    const account = findAccount(toolName, name);
    if (!account) throw new Error(`No such ${toolName} account: '${name}'.`);
    if (!isDir(account.dir)) mkdirSync(account.dir, { recursive: true });
    return account.dir;
}

/**
 * Launch a tool for an account by spawning its binary with the tool's config-dir
 * env var pointed at that account's directory. `name` of null uses the active
 * account; `passthrough` are extra args forwarded verbatim. Resolves with the
 * tool's exit code (127 if the binary cannot be found).
 *
 * The env-injection + child spawn is what makes account switching OS-agnostic:
 * the same call works identically on macOS, Linux and Windows.
 */
export async function launchTool(toolName: string, name: string | null, passthrough: string[] = []): Promise<number> {
    const tool = getTool(toolName);
    const account = name ?? getActive(toolName);
    const dir = resolveConfigDir(toolName, account);

    const binary = process.env[tool.binEnv] || resolveBin(tool.bin) || tool.bin;
    const env = { ...process.env, ...tool.envFor(dir) };

    touchLastUsed(toolName, account);
    return spawnInherit(binary, passthrough, env);
}

/**
 * Connect (authenticate) an account by delegating to the tool's own login flow:
 * the tool's dedicated login subcommand if it has one (`tool.loginArgs`), or a
 * normal launch otherwise (Claude Code has no login subcommand - the user runs
 * /login). Prints the tool's login hint first. Resolves with the exit code.
 */
export async function loginTool(toolName: string, name: string): Promise<number> {
    const tool = getTool(toolName);
    if (tool.loginHint) process.stdout.write(`${tool.loginHint}\n`);
    return launchTool(toolName, name, tool.loginArgs ?? []);
}

/** Update an account's lastUsed timestamp; no-op for the synthetic "default". */
function touchLastUsed(toolName: string, name: string): void {
    if (name === DEFAULT_NAME) return;
    const reg = readRegistry();
    const bucket = bucketOf(reg, toolName);
    const account = bucket.accounts.find((a) => a.name === name);
    if (!account) return;
    account.lastUsed = nowIso();
    reg.tools[toolName] = bucket;
    writeRegistry(reg);
}

/**
 * Spawn a command inheriting the parent's stdio and forwarding termination
 * signals, resolving with its exit code. On Windows a non-.exe target (a `.cmd`
 * shim like Claude's, or a bare name) must run through the shell; arguments are
 * quoted to avoid a shell-injection surface.
 */
function spawnInherit(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
    const useShell = process.platform === "win32" && !command.toLowerCase().endsWith(".exe");
    const child = useShell
        ? spawn([command, ...args].map(quoteWinArg).join(" "), { stdio: "inherit", env, shell: true })
        : spawn(command, args, { stdio: "inherit", env });

    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const forward = (sig: NodeJS.Signals): void => { try { child.kill(sig); } catch { /* already gone */ } };
    for (const sig of signals) process.on(sig, forward);

    return new Promise<number>((res) => {
        child.on("error", (err) => {
            for (const sig of signals) process.off(sig, forward);
            process.stderr.write(`Failed to launch '${command}': ${err.message}\n`);
            res(127);
        });
        child.on("exit", (code) => {
            for (const sig of signals) process.off(sig, forward);
            res(code ?? 0);
        });
    });
}

/** Quote an argument for cmd.exe: wrap in double quotes only when it needs it. */
function quoteWinArg(arg: string): string {
    if (arg === "") return "\"\"";
    if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, "\"\"")}"`;
}

/** True when `dir` resolves to a path inside `base` (never outside it). */
function isWithinBase(dir: string, base: string): boolean {
    const root = resolve(base);
    const target = resolve(dir);
    return target === root || target.startsWith(root + sep);
}

/** Current timestamp as an ISO string, isolated so the rest stays side-effect free. */
function nowIso(): string {
    return new Date().toISOString();
}
