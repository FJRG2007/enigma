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
 * The design is tool-agnostic via the TOOLS registry: Claude Code (via
 * CLAUDE_CONFIG_DIR), OpenAI Codex (via CODEX_HOME) and OpenCode (via the
 * XDG_DATA_HOME/XDG_CONFIG_HOME pair) are wired up; adding another agent is a
 * single registry entry, not a rewrite. Each tool's existing config dir is
 * surfaced as a synthetic, non-removable "default" account so the user's current
 * login is never lost; new accounts live under ~/.enigma/<tool>/<uuid>/, where the
 * directory is an opaque UUID rather than the account name - so renaming an account
 * (or profile) is a metadata-only change and never has to move files on disk. The
 * registry persists each account's `dir`, so accounts created before this change
 * keep their legacy name-based directory and keep working unchanged.
 *
 * PROFILES group one account per tool under a single name (e.g. profile "work" =
 * claude:work + codex:acme), stored alongside the accounts in the registry. When
 * a profile is active, launching a tool without an explicit account uses the
 * profile's mapping for that tool, falling back to the tool's own active account.
 *
 * This module is the pure data + spawn layer (Node builtins only); the CLI
 * wrapper in cli.ts does the prompting and printing.
 */

import { homedir } from "node:os";
import { readConfig } from "./config";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { startMeasuringProxy } from "./proxy";
import { join, resolve, sep } from "node:path";
import { readGlobalGuard } from "./guard-config";
import { isDir, readJson, resolveBin } from "./util";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { decryptSecret, encryptSecret } from "./secret-box";

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
    /**
     * Where enigma's deployment lives INSIDE a managed account's config dir, as
     * the tool resolves paths with its config-dir env var injected. `skills` is
     * omitted for tools that read skills from a shared, account-independent
     * location (Codex reads ~/.agents/skills regardless of CODEX_HOME).
     */
    accountTarget: (dir: string) => AccountTarget;
    /**
     * Maps a per-account provider override to the env this tool reads to talk to a
     * different (Anthropic-compatible) backend - e.g. pointing Claude Code at MiniMax.
     * Absent means the tool has no provider-override support, so the UIs hide it.
     */
    providerEnv?: (p: ResolvedProvider) => Record<string, string>;
    loginArgs?: string[];
    loginHint: string;
    /**
     * Best-effort read of the logged-in identity from an account's config dir
     * (e.g. the account email), so it can be shown in listings. Returns undefined
     * fields when the account has not been authenticated yet.
     */
    accountInfo?: (dir: string) => { email?: string; displayName?: string };
}

/** Skills/memory destinations inside a managed account's config dir. */
export interface AccountTarget {
    skills?: string;
    memory: string;
    /** Custom-command dir inside the account config dir, when the tool supports it. */
    commands?: string;
}

const OPENCODE_DEFAULT_DIR = join(homedir(), ".local", "share", "opencode");

/** Registry of supported tools. Add an entry here to support a new agent. */
const TOOLS: Record<string, ToolSpec> = {
    claude: {
        name: "claude",
        label: "Claude Code",
        bin: "claude",
        binEnv: "ENIGMA_CLAUDE_BIN",
        defaultDir: join(homedir(), ".claude"),
        envFor: (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
        // CLAUDE_CONFIG_DIR relocates ~/.claude entirely: skills, the CLAUDE.md
        // user memory and settings.json are all read from the account dir.
        accountTarget: (dir) => ({ skills: join(dir, "skills"), memory: dir, commands: join(dir, "commands") }),
        // Claude Code reads its backend from ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, and the
        // active model from ANTHROPIC_MODEL plus the per-tier defaults (sonnet/opus/haiku) - so a
        // single model id covers a one-model provider like MiniMax. Extra env (e.g. MiniMax's 1M
        // CLAUDE_CODE_AUTO_COMPACT_WINDOW) is merged last.
        providerEnv: ({ baseUrl, token, model, env }) => {
            const out: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl };
            if (token) out.ANTHROPIC_AUTH_TOKEN = token;
            if (model) {
                out.ANTHROPIC_MODEL = model;
                out.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
                out.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
                out.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
            }
            return { ...out, ...(env || {}) };
        },
        loginHint: "Launching Claude Code - run /login inside it to authenticate this account.",
        // Claude Code records the signed-in account under oauthAccount in
        // <config-dir>/.claude.json (no tokens there - those live elsewhere).
        accountInfo: (dir) => {
            const config = readJson<{ oauthAccount?: { emailAddress?: string; displayName?: string } }>(join(dir, ".claude.json"));
            return { email: config?.oauthAccount?.emailAddress, displayName: config?.oauthAccount?.displayName };
        },
    },
    codex: {
        name: "codex",
        label: "OpenAI Codex",
        bin: "codex",
        binEnv: "ENIGMA_CODEX_BIN",
        defaultDir: join(homedir(), ".codex"),
        envFor: (dir) => ({ CODEX_HOME: dir }),
        // CODEX_HOME relocates AGENTS.md (and config.toml), but Codex discovers
        // skills from the shared ~/.agents/skills location - no per-account copy.
        // Custom prompts are per-CODEX_HOME, so they DO live in the account dir.
        accountTarget: (dir) => ({ memory: dir, commands: join(dir, "prompts") }),
        loginArgs: ["login"],
        loginHint: "Launching `codex login` to authenticate this account.",
        // Codex stores its OAuth tokens in <CODEX_HOME>/auth.json; the id_token is
        // a JWT whose payload carries the account email. Decode (no verification
        // needed - it is the user's own local file) and surface ONLY the email;
        // tokens never leave this function.
        accountInfo: (dir) => {
            const auth = readJson<{ tokens?: { id_token?: string } }>(join(dir, "auth.json"));
            const jwt = auth?.tokens?.id_token;
            if (!jwt) return {};
            try {
                const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
                return { email: typeof payload.email === "string" ? payload.email : undefined };
            } catch {
                return {};
            }
        },
    },
    opencode: {
        name: "opencode",
        label: "OpenCode",
        bin: "opencode",
        binEnv: "ENIGMA_OPENCODE_BIN",
        defaultDir: OPENCODE_DEFAULT_DIR,
        // opencode has no single config-dir variable; it resolves its data dir
        // (auth.json) from XDG_DATA_HOME and its config from XDG_CONFIG_HOME. For
        // the built-in default account we inject NOTHING so the user's real
        // environment stays untouched; managed accounts get a private XDG pair
        // under the account dir (this also redirects any XDG-aware children
        // opencode spawns - acceptable for full isolation).
        envFor: (dir): Record<string, string> => dir === OPENCODE_DEFAULT_DIR
            ? {}
            : { XDG_DATA_HOME: join(dir, "xdg-data"), XDG_CONFIG_HOME: join(dir, "xdg-config") },
        // The injected XDG_CONFIG_HOME makes opencode read its config dir (skills,
        // AGENTS.md, opencode.json) from <dir>/xdg-config/opencode.
        accountTarget: (dir) => ({
            skills: join(dir, "xdg-config", "opencode", "skills"),
            memory: join(dir, "xdg-config", "opencode"),
            commands: join(dir, "xdg-config", "opencode", "command"),
        }),
        loginArgs: ["auth", "login"],
        loginHint: "Launching `opencode auth login` to authenticate this account.",
        // opencode's auth.json maps provider ids to credentials; there is no email
        // to show, so surface the connected providers as the display identity.
        accountInfo: (dir) => {
            const auth = dir === OPENCODE_DEFAULT_DIR
                ? readJson<Record<string, unknown>>(join(dir, "auth.json"))
                : readJson<Record<string, unknown>>(join(dir, "xdg-data", "opencode", "auth.json"));
            const providers = auth ? Object.keys(auth) : [];
            return providers.length ? { displayName: providers.join(", ") } : {};
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

/**
 * A per-account provider override: point the tool at a different Anthropic-compatible
 * backend (e.g. MiniMax) instead of the vendor default. The auth token is stored
 * ENCRYPTED at rest (tokenEnc, secret-box.ts); the rest is non-secret config.
 */
export interface StoredProvider {
    /** ANTHROPIC_BASE_URL (the compatible endpoint). Required when an override is set. */
    baseUrl: string;
    /** Model id; fills ANTHROPIC_MODEL + the per-tier defaults when present. */
    model?: string;
    /** Extra raw env to inject (e.g. CLAUDE_CODE_AUTO_COMPACT_WINDOW for MiniMax's 1M window). */
    env?: Record<string, string>;
    /** Preset id this was created from ("minimax", "minimax-cn", or "custom"), for display. */
    preset?: string;
    /** Encrypted auth token (ANTHROPIC_AUTH_TOKEN). */
    tokenEnc?: string;
}

/** A provider override with its token decrypted, as handed to ToolSpec.providerEnv. */
export interface ResolvedProvider { baseUrl: string; token: string; model?: string; env?: Record<string, string>; }

/** The non-secret provider fields surfaced to listings/UIs (the token is never exposed). */
export interface ProviderView { baseUrl: string; model?: string; preset?: string; env?: Record<string, string>; hasToken: boolean; }

/** Fields a UI/CLI sends to set a provider. An omitted `token` keeps the stored one; "" clears it. */
export interface ProviderInput { baseUrl: string; model?: string; env?: Record<string, string>; preset?: string; token?: string; }

/** A ready-made provider configuration the UIs can offer (fills baseUrl/model/env for the user). */
export interface ProviderPreset {
    id: string;
    label: string;
    /** Which tool this preset targets (only that tool's accounts should offer it). */
    tool: string;
    baseUrl: string;
    model?: string;
    env?: Record<string, string>;
    /** Where to get the API key, shown as a hint in the UIs. */
    tokenUrl?: string;
}

/**
 * Built-in provider presets. MiniMax exposes an Anthropic-compatible endpoint for Claude Code
 * (https://platform.minimax.io/docs/token-plan/claude-code): one model id (MiniMax-M3[1m]) fills
 * every tier, and the 1M context window needs CLAUDE_CODE_AUTO_COMPACT_WINDOW.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
    {
        id: "minimax", label: "MiniMax (International)", tool: "claude",
        baseUrl: "https://api.minimax.io/anthropic", model: "MiniMax-M3[1m]",
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" },
        tokenUrl: "https://platform.minimax.io/user-center/payment/token-plan",
    },
    {
        id: "minimax-cn", label: "MiniMax (China)", tool: "claude",
        baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3[1m]",
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" },
        tokenUrl: "https://platform.minimaxi.com/user-center/payment/token-plan",
    },
];

/** Presets available for a tool (empty when the tool has no provider-override support). */
export function presetsForTool(toolName: string): ProviderPreset[] {
    return getTool(toolName).providerEnv ? PROVIDER_PRESETS.filter((p) => p.tool === toolName) : [];
}

export interface Account {
    name: string;
    dir: string;
    createdAt: string;
    lastUsed?: string;
    /** Optional provider override (e.g. MiniMax). Absent = the tool's default backend. */
    provider?: StoredProvider;
}

/** An account plus display metadata: active flag, owning tool, and signed-in identity. */
export interface AccountView extends Omit<Account, "provider"> {
    active: boolean;
    tool: string;
    toolLabel: string;
    email?: string;
    /** Fallback identity when the tool has no email (e.g. opencode's provider list). */
    displayName?: string;
    /** Provider override (token never included), or undefined for the default backend. */
    provider?: ProviderView;
    /** Whether this tool supports a provider override at all (drives UI visibility). */
    supportsProvider: boolean;
}

/** Per-tool slice of the registry: its accounts and which one is active. */
interface ToolBucket {
    active: string | null;
    accounts: Account[];
}

/** Profiles: one account name per tool under a single profile name. */
interface ProfilesBucket {
    active: string | null;
    items: Record<string, Record<string, string>>;
}

interface Registry {
    tools: Record<string, ToolBucket>;
    profiles: ProfilesBucket;
}

/** A profile with display metadata for listings and the hub. */
export interface ProfileView {
    name: string;
    active: boolean;
    /** tool name -> account name mappings this profile pins. */
    accounts: Record<string, string>;
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
/** Normalize a raw object into a ProfilesBucket, tolerating partial/absent data. */
function normalizeProfiles(raw: unknown): ProfilesBucket {
    const obj = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
    const items: Record<string, Record<string, string>> = {};
    if (obj.items && typeof obj.items === "object") {
        for (const [name, mapping] of Object.entries(obj.items as Record<string, unknown>)) {
            if (!mapping || typeof mapping !== "object") continue;
            const clean: Record<string, string> = {};
            for (const [tool, account] of Object.entries(mapping as Record<string, unknown>)) {
                if (typeof account === "string") clean[tool] = account;
            }
            items[name] = clean;
        }
    }
    return { active: typeof obj.active === "string" ? obj.active : null, items };
}

function readRegistry(): Registry {
    const raw = readJson<Record<string, unknown>>(REGISTRY_PATH);
    if (!raw || typeof raw !== "object") return { tools: {}, profiles: normalizeProfiles(null) };

    if (raw.tools && typeof raw.tools === "object") {
        const tools: Record<string, ToolBucket> = {};
        for (const [name, bucket] of Object.entries(raw.tools as Record<string, unknown>)) {
            tools[name] = normalizeBucket(bucket);
        }
        return { tools, profiles: normalizeProfiles(raw.profiles) };
    }
    // Legacy shape: a flat {active, accounts} was always Claude Code.
    if (Array.isArray(raw.accounts)) return { tools: { [DEFAULT_TOOL]: normalizeBucket(raw) }, profiles: normalizeProfiles(null) };
    return { tools: {}, profiles: normalizeProfiles(null) };
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
    const supportsProvider = Boolean(tool.providerEnv);
    return all.map((a) => {
        const info = tool.accountInfo?.(a.dir) ?? {};
        return {
            ...a,
            active: a.name === active,
            tool: tool.name,
            toolLabel: tool.label,
            email: info.email,
            displayName: info.displayName,
            // The sanitized view (no token) overrides the raw `provider` from the spread above.
            provider: toProviderView(a.provider),
            supportsProvider,
        };
    });
}

/** Map a stored provider to its non-secret view (or undefined when there is no override). */
function toProviderView(p: StoredProvider | undefined): ProviderView | undefined {
    if (!p || !p.baseUrl) return undefined;
    return { baseUrl: p.baseUrl, model: p.model, preset: p.preset, env: p.env, hasToken: Boolean(p.tokenEnc) };
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
 *
 * The directory is a fresh UUID, decoupled from the (mutable) account name, so a
 * later rename never has to move files. The name stays the user-facing unique key
 * within the tool's bucket.
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
    const dir = join(accountsBase(tool), randomUUID());
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
    // Drop any profile mapping that pinned the removed account, so profiles never
    // point at a config dir that no longer exists.
    for (const mapping of Object.values(reg.profiles.items)) {
        if (mapping[toolName] === name) delete mapping[toolName];
    }
    writeRegistry(reg);
}

/**
 * Rename a managed account for a tool: a metadata-only change. The config directory
 * is an opaque, stable path (a UUID for accounts created since directories were
 * decoupled from names; a legacy name-based path for older ones), so renaming only
 * updates the registry, the active pointer and any profile mapping that pinned the
 * old name - it never moves files, so it cannot fail or collide on disk. Refuses the
 * built-in "default" and name collisions.
 */
export function renameAccount(toolName: string, oldName: string, newName: string): Account {
    const tool = getTool(toolName);
    if (oldName === DEFAULT_NAME) throw new Error(`The '${DEFAULT_NAME}' account (${tool.label}'s existing config) cannot be renamed.`);
    validateAccountName(newName);
    const reg = readRegistry();
    const bucket = bucketOf(reg, toolName);
    const account = bucket.accounts.find((a) => a.name === oldName);
    if (!account) throw new Error(`No such ${toolName} account: '${oldName}'.`);
    if (newName === oldName) return account;
    if (bucket.accounts.some((a) => a.name === newName)) throw new Error(`A ${toolName} account named '${newName}' already exists.`);

    account.name = newName;
    if (bucket.active === oldName) bucket.active = newName;
    reg.tools[toolName] = bucket;
    // Re-point any profile mapping that pinned the old name, so profiles keep
    // resolving to the same config dir after the rename.
    for (const mapping of Object.values(reg.profiles.items)) {
        if (mapping[toolName] === oldName) mapping[toolName] = newName;
    }
    writeRegistry(reg);
    return account;
}

// --- provider overrides ----------------------------------------------------------

/** A managed account's provider override (non-secret view), or null when none/unsupported. */
export function getAccountProvider(toolName: string, name: string): ProviderView | null {
    const tool = getTool(toolName);
    if (!tool.providerEnv || name === DEFAULT_NAME) return null;
    const account = bucketOf(readRegistry(), toolName).accounts.find((a) => a.name === name);
    return account ? (toProviderView(account.provider) ?? null) : null;
}

/** Build a ProviderInput from a built-in preset id + an optional token, or null if unknown. */
export function providerFromPreset(presetId: string, token?: string): ProviderInput | null {
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) return null;
    return { baseUrl: preset.baseUrl, model: preset.model, env: preset.env, preset: preset.id, token };
}

/**
 * Set (or clear, with null) a managed account's provider override. The token is encrypted at
 * rest; an omitted token on update keeps the stored one, an empty string clears it. Rejects the
 * synthetic "default" account (it stays on the vendor default) and tools without provider support.
 */
export function setAccountProvider(toolName: string, name: string, input: ProviderInput | null): void {
    const tool = getTool(toolName);
    if (!tool.providerEnv) throw new Error(`${tool.label} does not support a provider override.`);
    if (name === DEFAULT_NAME) throw new Error(`The '${DEFAULT_NAME}' account stays on ${tool.label}'s default backend; create a named account for a custom provider.`);
    const reg = readRegistry();
    const bucket = bucketOf(reg, toolName);
    const account = bucket.accounts.find((a) => a.name === name);
    if (!account) throw new Error(`No such ${toolName} account: '${name}'.`);
    if (input === null) {
        delete account.provider;
    } else {
        const baseUrl = (input.baseUrl || "").trim();
        if (!/^https?:\/\//i.test(baseUrl)) throw new Error("A provider needs a base URL starting with http:// or https://.");
        const prev = account.provider;
        // undefined token keeps the stored one; "" clears it; a value (re)encrypts.
        const tokenEnc = input.token === undefined ? prev?.tokenEnc : (input.token ? encryptSecret(input.token) : undefined);
        const provider: StoredProvider = { baseUrl };
        const model = (input.model || "").trim();
        if (model) provider.model = model;
        if (input.env && Object.keys(input.env).length) provider.env = { ...input.env };
        if (input.preset) provider.preset = input.preset;
        if (tokenEnc) provider.tokenEnc = tokenEnc;
        account.provider = provider;
    }
    reg.tools[toolName] = bucket;
    writeRegistry(reg);
}

/** The env to inject so a launch uses the account's provider override, or null when none applies. */
export function accountProviderEnv(toolName: string, name: string): Record<string, string> | null {
    const tool = getTool(toolName);
    if (!tool.providerEnv || name === DEFAULT_NAME) return null;
    const account = bucketOf(readRegistry(), toolName).accounts.find((a) => a.name === name);
    const p = account?.provider;
    if (!p || !p.baseUrl) return null;
    return tool.providerEnv({ baseUrl: p.baseUrl, token: decryptSecret(p.tokenEnc || ""), model: p.model, env: p.env });
}

// --- profiles --------------------------------------------------------------------

/** Every profile with its mappings and an `active` flag. */
export function listProfiles(): ProfileView[] {
    const { profiles } = readRegistry();
    return Object.entries(profiles.items).map(([name, accounts]) => ({
        name, accounts: { ...accounts }, active: name === profiles.active,
    }));
}

/** The active profile, or null when none is set (tools fall back to their own active account). */
export function getActiveProfile(): ProfileView | null {
    return listProfiles().find((p) => p.active) ?? null;
}

/** Create an empty profile (idempotent). Profile names follow the account-name rules. */
export function addProfile(name: string): ProfileView {
    validateAccountName(name);
    const reg = readRegistry();
    reg.profiles.items[name] ??= {};
    writeRegistry(reg);
    return { name, accounts: { ...reg.profiles.items[name]! }, active: reg.profiles.active === name };
}

/**
 * Rename a profile, keeping its mappings and following the active pointer.
 * Profile names follow the account-name rules; collisions are refused.
 */
export function renameProfile(oldName: string, newName: string): void {
    validateAccountName(newName);
    const reg = readRegistry();
    const mapping = reg.profiles.items[oldName];
    if (!mapping) throw new Error(`No such profile: '${oldName}'.`);
    if (newName === oldName) return;
    if (newName in reg.profiles.items) throw new Error(`A profile named '${newName}' already exists.`);
    delete reg.profiles.items[oldName];
    reg.profiles.items[newName] = mapping;
    if (reg.profiles.active === oldName) reg.profiles.active = newName;
    writeRegistry(reg);
}

/** Delete a profile, clearing the active pointer if it referenced it. */
export function removeProfile(name: string): void {
    const reg = readRegistry();
    if (!(name in reg.profiles.items)) throw new Error(`No such profile: '${name}'.`);
    delete reg.profiles.items[name];
    if (reg.profiles.active === name) reg.profiles.active = null;
    writeRegistry(reg);
}

/**
 * Pin `account` as the profile's account for `toolName`. The tool must be
 * supported and the account must already exist (including "default", which pins
 * the tool's built-in config dir explicitly).
 */
export function setProfileAccount(profile: string, toolName: string, account: string): void {
    getTool(toolName);
    if (!accountExists(toolName, account)) {
        throw new Error(`No such ${toolName} account: '${account}'. Create it first: enigma account add ${account} --tool ${toolName}.`);
    }
    const reg = readRegistry();
    const mapping = reg.profiles.items[profile];
    if (!mapping) throw new Error(`No such profile: '${profile}'. Create it first: enigma profile add ${profile}.`);
    mapping[toolName] = account;
    writeRegistry(reg);
}

/** Remove a profile's mapping for a tool (it falls back to the tool's active account). */
export function unsetProfileAccount(profile: string, toolName: string): void {
    getTool(toolName);
    const reg = readRegistry();
    const mapping = reg.profiles.items[profile];
    if (!mapping) throw new Error(`No such profile: '${profile}'.`);
    delete mapping[toolName];
    writeRegistry(reg);
}

/** Activate a profile by name, or deactivate with null. */
export function setActiveProfile(name: string | null): void {
    const reg = readRegistry();
    if (name !== null && !(name in reg.profiles.items)) throw new Error(`No such profile: '${name}'.`);
    reg.profiles.active = name;
    writeRegistry(reg);
}

/**
 * Account used when launching `toolName` without an explicit account: the active
 * profile's mapping for that tool when one exists (and the account still does),
 * else the tool's own active account.
 */
export function resolveLaunchAccount(toolName: string): string {
    const profile = getActiveProfile();
    const pinned = profile?.accounts[toolName];
    if (pinned && accountExists(toolName, pinned)) return pinned;
    return getActive(toolName);
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
    // Explicit account wins; otherwise the active profile's mapping, then the
    // tool's own active account (see resolveLaunchAccount).
    const account = name ?? resolveLaunchAccount(toolName);
    const dir = resolveConfigDir(toolName, account);

    const cfg = readConfig().config;
    // Resolution order: explicit env override > the path persisted by `enigma fix-path`
    // (toolPaths) > a plain PATH lookup > a bare command name. The toolPaths entry is what
    // makes `enigma <tool>` work when the tool is installed but not on the shell PATH.
    const binary = process.env[tool.binEnv] || cfg.toolPaths?.[toolName] || resolveBin(tool.bin) || tool.bin;
    const env = { ...process.env, ...tool.envFor(dir) };

    // Per-account provider override (e.g. point Claude Code at MiniMax): inject its env BEFORE the
    // measuring-proxy block so a custom ANTHROPIC_BASE_URL disables the proxy (which must only ever
    // front Anthropic). This is an explicit per-account choice, so it wins over the inherited shell.
    const providerEnv = accountProviderEnv(toolName, account);
    if (providerEnv) Object.assign(env, providerEnv);

    touchLastUsed(toolName, account);

    // Experimental loopback proxy (opt-in, default off, Claude Code only): front Claude Code
    // with a proxy for THIS launch by pointing ANTHROPIC_BASE_URL at it, and close it when
    // Claude exits. It runs when EITHER the measuring proxy OR the prompt secret guard is on
    // (the guard needs the proxy to inspect outgoing messages). Best-effort and non-breaking:
    // if it cannot start we launch directly, and a user-set ANTHROPIC_BASE_URL is never
    // overridden. When the guard is on, the proxy scans/redacts secrets in chat prompts.
    let proxy: Awaited<ReturnType<typeof startMeasuringProxy>> | null = null;
    if (toolName === "claude" && (cfg.proxy || cfg.promptSecretGuard) && !env.ANTHROPIC_BASE_URL) {
        try {
            proxy = await startMeasuringProxy(cfg.promptSecretGuard
                ? { scanPrompts: true, mode: cfg.promptSecretMode, extraPatterns: readGlobalGuard().secretPatterns }
                : {});
            env.ANTHROPIC_BASE_URL = proxy.url;
        } catch { proxy = null; }
    }
    try {
        return await spawnInherit(binary, passthrough, env);
    } finally {
        if (proxy) proxy.close();
    }
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
