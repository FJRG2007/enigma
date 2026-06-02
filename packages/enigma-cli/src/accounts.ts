/**
 * Native multi-account management for Claude Code. Each account is just a
 * separate config directory; pointing Claude Code at it via the CLAUDE_CONFIG_DIR
 * environment variable gives that account its own credentials and session, so a
 * user can keep e.g. a company login and a personal login side by side without
 * ever logging out.
 *
 * The OS-agnostic switch is the launcher itself: instead of generating shell
 * aliases (which differ per shell and OS), enigma spawns `claude` as a child
 * process with CLAUDE_CONFIG_DIR injected - one code path that behaves the same
 * on macOS, Linux and Windows.
 *
 * The existing ~/.claude is surfaced as a synthetic, non-removable "default"
 * account so the user's current login is never lost; new accounts live under
 * ~/.enigma/claude/<name>/. This module is the pure data + spawn layer (Node
 * builtins only); the CLI wrapper in cli.ts does the prompting and printing.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isDir, readJson, resolveBin } from "./util";

/** Reserved name for the built-in ~/.claude account; never stored or removable. */
export const DEFAULT_NAME = "default";
/** Config dir Claude Code uses out of the box (and for the "default" account). */
const DEFAULT_DIR = join(homedir(), ".claude");
/** Base dir holding every managed account's config directory. */
export const ACCOUNTS_BASE = join(homedir(), ".enigma", "claude");
/** Registry file mapping account names to their config directories. */
const REGISTRY_PATH = join(homedir(), ".enigma", "accounts.json");

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface Account {
    name: string;
    dir: string;
    createdAt: string;
    lastUsed?: string;
}

/** An account plus whether it is the currently active one. */
export interface AccountView extends Account {
    active: boolean;
}

interface Registry {
    active: string | null;
    accounts: Account[];
}

/**
 * Validate a user-supplied account name. Throws on anything that is not a short,
 * filesystem-safe slug, and rejects the reserved "default" so it cannot shadow
 * the built-in ~/.claude account. Boundary validation keeps untrusted input from
 * reaching the filesystem as a path segment.
 */
export function validateAccountName(name: string): void {
    if (!NAME_PATTERN.test(name)) {
        throw new Error(`Invalid account name '${name}'. Use letters, digits, '.', '_' or '-' (max 64 chars).`);
    }
    if (name === DEFAULT_NAME) throw new Error(`'${DEFAULT_NAME}' is reserved for your existing ~/.claude account.`);
}

/** Read the registry, returning an empty one if absent or unreadable. */
function readRegistry(): Registry {
    const raw = readJson<Partial<Registry>>(REGISTRY_PATH);
    const accounts = Array.isArray(raw?.accounts) ? raw!.accounts! : [];
    return { active: typeof raw?.active === "string" ? raw!.active! : null, accounts };
}

/** Persist the registry, creating ~/.enigma if needed. */
function writeRegistry(reg: Registry): void {
    const dir = join(REGISTRY_PATH, "..");
    if (!isDir(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
}

/** The synthetic entry describing the built-in ~/.claude account. */
function defaultAccount(): Account {
    return { name: DEFAULT_NAME, dir: DEFAULT_DIR, createdAt: "" };
}

/**
 * Every account (the synthetic "default" first, then registered ones) with an
 * `active` flag. The active account is the registry pointer, or "default" when
 * unset or pointing at an account that no longer exists.
 */
export function listAccounts(): AccountView[] {
    const reg = readRegistry();
    const all = [defaultAccount(), ...reg.accounts];
    const active = resolveActiveName(reg, all);
    return all.map((a) => ({ ...a, active: a.name === active }));
}

/** Name of the active account, falling back to "default" when the pointer is stale. */
export function getActive(): string {
    const reg = readRegistry();
    return resolveActiveName(reg, [defaultAccount(), ...reg.accounts]);
}

function resolveActiveName(reg: Registry, all: Account[]): string {
    if (reg.active && all.some((a) => a.name === reg.active)) return reg.active;
    return DEFAULT_NAME;
}

/** Look up an account by name (including the synthetic "default"), or null. */
function findAccount(name: string): Account | null {
    if (name === DEFAULT_NAME) return defaultAccount();
    return readRegistry().accounts.find((a) => a.name === name) ?? null;
}

/** True when an account with this name exists. */
export function accountExists(name: string): boolean {
    return findAccount(name) !== null;
}

/**
 * Create (or return, if it already exists) a managed account. Validates the name,
 * creates its config directory under ACCOUNTS_BASE, and records it. Idempotent so
 * re-running `account add` is safe.
 */
export function addAccount(name: string): Account {
    validateAccountName(name);
    const reg = readRegistry();
    const existing = reg.accounts.find((a) => a.name === name);
    if (existing) {
        if (!isDir(existing.dir)) mkdirSync(existing.dir, { recursive: true });
        return existing;
    }
    const dir = join(ACCOUNTS_BASE, name);
    mkdirSync(dir, { recursive: true });
    const account: Account = { name, dir, createdAt: nowIso() };
    reg.accounts.push(account);
    writeRegistry(reg);
    return account;
}

/**
 * Make `name` the active account. Validates the account exists; storing the
 * built-in "default" clears the pointer rather than persisting the reserved name.
 */
export function setActive(name: string): void {
    if (!accountExists(name)) throw new Error(`No such account: '${name}'.`);
    const reg = readRegistry();
    reg.active = name === DEFAULT_NAME ? null : name;
    writeRegistry(reg);
}

/**
 * Remove a managed account: drops it from the registry and deletes its config
 * directory. Refuses the built-in "default", and only deletes a directory that
 * lives inside ACCOUNTS_BASE so a tampered registry can never point removal at an
 * arbitrary path. Clears the active pointer if it referenced this account.
 */
export function removeAccount(name: string): void {
    if (name === DEFAULT_NAME) throw new Error(`The '${DEFAULT_NAME}' account (your ~/.claude) cannot be removed.`);
    const reg = readRegistry();
    const account = reg.accounts.find((a) => a.name === name);
    if (!account) throw new Error(`No such account: '${name}'.`);

    if (isWithinBase(account.dir) && isDir(account.dir)) rmSync(account.dir, { recursive: true, force: true });
    reg.accounts = reg.accounts.filter((a) => a.name !== name);
    if (reg.active === name) reg.active = null;
    writeRegistry(reg);
}

/** Config directory for an account, ensuring the directory exists. Throws if unknown. */
export function resolveConfigDir(name: string): string {
    const account = findAccount(name);
    if (!account) throw new Error(`No such account: '${name}'.`);
    if (!isDir(account.dir)) mkdirSync(account.dir, { recursive: true });
    return account.dir;
}

/**
 * Launch Claude Code for an account by spawning the `claude` binary with
 * CLAUDE_CONFIG_DIR pointed at that account's config directory. `name` of null
 * uses the active account; `passthrough` are extra args forwarded verbatim to
 * Claude. Resolves with Claude's exit code (127 if the binary cannot be found).
 *
 * The env-injection + child spawn is what makes account switching OS-agnostic:
 * the same call works identically on macOS, Linux and Windows.
 */
export async function launchClaude(name: string | null, passthrough: string[] = []): Promise<number> {
    const account = name ?? getActive();
    const dir = resolveConfigDir(account);

    const binary = process.env.ENIGMA_CLAUDE_BIN || resolveBin("claude") || "claude";
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };

    // Stamp last-used for managed accounts (the synthetic "default" is not stored).
    touchLastUsed(account);

    return spawnInherit(binary, passthrough, env);
}

/** Update an account's lastUsed timestamp; no-op for the synthetic "default". */
function touchLastUsed(name: string): void {
    if (name === DEFAULT_NAME) return;
    const reg = readRegistry();
    const account = reg.accounts.find((a) => a.name === name);
    if (!account) return;
    account.lastUsed = nowIso();
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
            process.stderr.write(`Failed to launch Claude Code ('${command}'): ${err.message}\n`);
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

/** True when `dir` resolves to a path inside ACCOUNTS_BASE (never outside it). */
function isWithinBase(dir: string): boolean {
    const base = resolve(ACCOUNTS_BASE);
    const target = resolve(dir);
    return target === base || target.startsWith(base + sep);
}

/** Current timestamp as an ISO string, isolated so the rest stays side-effect free. */
function nowIso(): string {
    return new Date().toISOString();
}
