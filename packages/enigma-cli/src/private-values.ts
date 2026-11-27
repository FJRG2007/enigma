/**
 * Private values: the domains, IP addresses and email addresses the user hands the agent in chat
 * ("my site at <domain> is down", a pasted error with the deployment's URL, `nslookup` output with
 * the server's and the LAN's addresses), which must not reach a commit, a PR or a tracked file of
 * ANOTHER repository without the user's say-so.
 *
 * WHY LEARNED AND NOT LISTED. The private-term list (private-terms.ts) only protects what the user
 * typed into it, and nobody lists every domain and IP they will ever paste. Reported: an agent
 * fixing a deployment opened a PR that named the domain and explained the server, the user's own
 * and the internal IPs; another committed a fix to a different project with the user's data in
 * it. The values are already in the conversation, so the Stop hook learns them from there
 * (`learnFromTurn`, verify.ts) and the commit guard, the edit-time guardrail and the commit/PR
 * message hook refuse them, never echoing the value.
 *
 * WHY "OTHER" REPOSITORIES. A domain the repository already carries is that project's own public
 * address: fixing its API client must not be blocked. So when a value is learned, the repository
 * the session works in is checked once (`git grep`), and a value already present there is recorded
 * as public in it. Everywhere else it is private until the user forgets it
 * (`enigma private-values forget <value>`), which is the consent path.
 *
 * Shared by bundles copied into .githooks (guard.ts, guardrails.ts), so this module is a
 * Node-builtins-only leaf with no side effects at import time.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type PrivateValueKind = "host" | "ip" | "email";

export interface PrivateValue {
    value: string;
    kind: PrivateValueKind;
    /** When it was last seen in a conversation (ms). */
    at: number;
    /** Repository roots that already carried the value when it was learned: public there. */
    publicIn: string[];
}

/** Kept this long after the value was last seen, then forgotten. */
const TTL_MS = 120 * 24 * 60 * 60 * 1000;
/** The newest values kept; past it the oldest go first. */
const MAX_VALUES = 400;

/** The store: user-wide, outside every repository, never committed. ENIGMA_CONFIG_HOME wins for tests. */
export function privateValuesPath(): string {
    return join(process.env.ENIGMA_CONFIG_HOME || homedir(), ".enigma", "private-values.json");
}

/** Top-level domains a pasted host ends in. A closed list, so `index.js`, `user.name` or `prisma.plans` never read as hosts. */
const TLDS = new Set([
    "com", "net", "org", "io", "dev", "app", "co", "ai", "me", "info", "biz", "xyz", "tech", "cloud", "sh", "so", "gg", "tv",
    "site", "online", "store", "shop", "page", "link", "live", "space", "website", "digital", "agency", "studio", "network",
    "es", "eu", "us", "uk", "de", "fr", "it", "pt", "nl", "be", "ch", "at", "se", "no", "dk", "fi", "pl", "cz", "ie", "ru",
    "mx", "ar", "br", "cl", "pe", "uy", "ve", "ec", "bo", "py", "cr", "ca", "au", "nz", "in", "jp", "cn", "kr", "tw", "sg",
    "hk", "za", "cat", "gal", "eus", "lat", "pro", "work", "run", "host", "systems", "solutions", "services", "email", "one",
]);

/**
 * Hosts that are public infrastructure rather than anyone's deployment: a link to them names
 * nothing private. Matched as the host or any subdomain of it. Hosting platforms that give each
 * customer a subdomain (vercel.app, netlify.app, pages.dev, herokuapp.com, onrender.com) are
 * deliberately NOT here: `my-shop.vercel.app` is exactly the value this module protects.
 */
const PUBLIC_HOSTS = [
    "github.com", "githubusercontent.com", "github.io", "gitlab.com", "bitbucket.org", "npmjs.com", "npmjs.org", "yarnpkg.com",
    "pypi.org", "crates.io", "rubygems.org", "nuget.org", "golang.org", "go.dev", "nodejs.org", "deno.land", "bun.sh", "jsr.io",
    "google.com", "googleapis.com", "gstatic.com", "youtube.com", "microsoft.com", "windows.com", "live.com", "office.com",
    "apple.com", "icloud.com", "amazon.com", "amazonaws.com", "cloudflare.com", "vercel.com", "netlify.com", "heroku.com",
    "anthropic.com", "claude.ai", "claude.com", "openai.com", "mozilla.org", "w3.org", "whatwg.org", "ietf.org", "wikipedia.org",
    "stackoverflow.com", "stackexchange.com", "reddit.com", "x.com", "twitter.com", "linkedin.com", "facebook.com",
    "instagram.com", "discord.com", "discord.gg", "slack.com", "medium.com", "dev.to", "react.dev", "reactjs.org", "nextjs.org",
    "vuejs.org", "svelte.dev", "angular.dev", "astro.build", "tailwindcss.com", "typescriptlang.org", "prisma.io", "docker.com",
    "jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "fonts.googleapis.com", "shields.io", "example.com", "example.org",
    "example.net", "localhost.com", "gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "proton.me", "protonmail.com",
];

/** Addresses that identify no one: loopback, unspecified, broadcast, documentation ranges, public resolvers. */
function isUnremarkableIp(ip: string): boolean {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number, number];
    if (a === 127 || a === 0 || a === 255 || a >= 224) return true;
    if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return true;
    return ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "208.67.222.222", "208.67.220.220"].includes(ip);
}

function isPublicHost(host: string): boolean {
    return PUBLIC_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d]|\.\d)/g;
const HOST = /(?<![\w@.$-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})(?![\w-]|\.[a-z0-9])/gi;
/** The words a version number follows in logs and environment dumps. */
const VERSION_BEFORE = /(?<![a-z])(?:version|ver|current|target|latest|java|node|python|sdk|build|release|v)\s*[:=]?\s*$/i;
const EMAIL = /(?<![\w.+-])[a-z0-9._%+-]{1,64}@((?:[a-z0-9-]+\.)+[a-z]{2,24})(?![\w-])/gi;

/** The domains, IPs and emails `text` names, normalized (lowercase, `www.` dropped), filtered of the public ones. */
export function extractValues(text: string, kinds: PrivateValueKind[] = ["host", "ip", "email"]): { value: string; kind: PrivateValueKind; }[] {
    const out = new Map<string, PrivateValueKind>();
    if (kinds.includes("email")) {
        for (const m of text.matchAll(EMAIL)) {
            const value = m[0].toLowerCase();
            const domain = m[1]!.toLowerCase();
            if (!TLDS.has(domain.split(".").pop()!) || /(^|\.)example\.(com|org|net)$|\.(test|invalid|local)$/.test(domain)) continue;
            if (/noreply|no-reply/.test(value)) continue;
            out.set(value, "email");
        }
    }
    if (kinds.includes("ip")) {
        for (const m of text.matchAll(IPV4)) {
            // A four-part version reads exactly like an address (`Current: 1.10.0.1`, `java=21.0.13.1`):
            // measured on real pasted logs, every such false positive sat right after a version word.
            if (isUnremarkableIp(m[0]) || VERSION_BEFORE.test(text.slice(Math.max(0, m.index! - 24), m.index))) continue;
            out.set(m[0], "ip");
        }
    }
    if (kinds.includes("host")) {
        // An email's domain is taken with the email, not on its own: a mail provider is not a deployment.
        const withoutEmails = text.replace(EMAIL, " ");
        for (const m of withoutEmails.matchAll(HOST)) {
            const host = m[0].toLowerCase().replace(/^www\./, "");
            if (!TLDS.has(m[1]!.toLowerCase()) || isPublicHost(host)) continue;
            // `Checker$1.run`, `step2.app`: a name whose registrable label is only digits is code, not a site.
            const labels = host.split(".");
            if (/^\d+$/.test(labels[labels.length - 2] ?? "")) continue;
            out.set(host, "host");
        }
    }
    return [...out].map(([value, kind]) => ({ value, kind }));
}

/** The stored values still inside their TTL. Unreadable or malformed means none. */
export function readPrivateValues(now = Date.now()): PrivateValue[] {
    try {
        const raw = JSON.parse(readFileSync(privateValuesPath(), "utf8")) as { values?: unknown; };
        if (!Array.isArray(raw.values)) return [];
        return raw.values.filter((v): v is PrivateValue => !!v && typeof v === "object"
            && typeof (v as PrivateValue).value === "string" && (v as PrivateValue).value.length >= 4
            && ["host", "ip", "email"].includes((v as PrivateValue).kind) && typeof (v as PrivateValue).at === "number"
            && Array.isArray((v as PrivateValue).publicIn) && now - (v as PrivateValue).at < TTL_MS);
    } catch { return []; }
}

/** Writes atomically (temp file + rename), so a concurrent reader never sees half a file. */
function writePrivateValues(values: PrivateValue[]): void {
    const path = privateValuesPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ values }, null, 2)}\n`);
    renameSync(tmp, path);
}

/** A repository root, normalized so two spellings of one path compare equal. */
export function normalizeRoot(root: string): string {
    return resolve(root).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Records `found` as seen now. `presentIn` is the repository the session works in and the subset
 * of `found` it already carries, which become public there. Returns how many values were new.
 */
export function rememberValues(found: { value: string; kind: PrivateValueKind; }[], presentIn?: { root: string; values: Set<string>; }, now = Date.now()): number {
    if (!found.length) return 0;
    const current = readPrivateValues(now);
    const byValue = new Map(current.map((v) => [v.value, v]));
    let added = 0;
    const root = presentIn ? normalizeRoot(presentIn.root) : "";
    for (const f of found) {
        const known = byValue.get(f.value);
        const entry = known ?? { value: f.value, kind: f.kind, at: now, publicIn: [] };
        if (!known) { added++; byValue.set(f.value, entry); }
        entry.at = now;
        if (root && presentIn!.values.has(f.value) && !entry.publicIn.includes(root)) entry.publicIn.push(root);
    }
    const values = [...byValue.values()].sort((a, b) => b.at - a.at).slice(0, MAX_VALUES);
    writePrivateValues(values);
    return added;
}

/** Forgets one value (the user's consent to publish it), or every value with `"*"`. Returns how many were removed. */
export function forgetValues(value: string): number {
    const current = readPrivateValues();
    const keep = value === "*" ? [] : current.filter((v) => v.value !== value.trim().toLowerCase());
    if (keep.length !== current.length) writePrivateValues(keep);
    return current.length - keep.length;
}

/** The repository root holding `path` (a file or a directory), found by walking up to a `.git` entry; null outside one. */
export function repoRootOf(path: string): string | null {
    let dir = resolve(path);
    for (let i = 0; i < 64; i++) {
        if (existsSync(join(dir, ".git"))) return dir;
        const up = dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
    return null;
}

/**
 * One matcher over the values private in `repoRoot` (all of them when it is null), or null when
 * there are none. A host also matches as a subdomain's suffix; an IP never inside a longer
 * address or version string. URLs are NOT blanked, unlike private terms: a URL is where a domain is.
 */
export function privateValueMatcher(values: PrivateValue[], repoRoot: string | null): RegExp | null {
    const root = repoRoot ? normalizeRoot(repoRoot) : "";
    const parts = values
        .filter((v) => !root || !v.publicIn.includes(root))
        .map((v) => {
            const lit = v.value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
            if (v.kind === "ip") return `(?<![\\d.])${lit}(?![\\d]|\\.\\d)`;
            if (v.kind === "host") return `(?<![\\w-])${lit}(?![\\w-]|\\.[a-z0-9])`;
            return `(?<![\\w.+-])${lit}(?![\\w-])`;
        });
    return parts.length ? new RegExp(parts.join("|"), "i") : null;
}

/** The marker that records the user's consent on one line. */
const ALLOW_PRIVATE_VALUE = /enigma:allow-private-value/;

/** 1-based lines of `text` carrying a private value, skipping lines marked with the consent marker. */
export function privateValueLines(text: string, re: RegExp): number[] {
    const out: number[] = [];
    text.split("\n").forEach((line, i) => { if (re.test(line) && !ALLOW_PRIVATE_VALUE.test(line)) out.push(i + 1); });
    return out;
}

/** Whether one line carries a private value (the commit guard's per-added-line form). */
export function hasPrivateValue(line: string, re: RegExp): boolean {
    return re.test(line) && !ALLOW_PRIVATE_VALUE.test(line);
}

/**
 * The names of the user's PRIVATE repositories, and which local repositories are public.
 *
 * A private repository's name is the one private value that is not in any conversation: agents
 * write it into docs and comments of a public repository as a measurement source or a cross
 * reference. Inside the user's own private repositories those names are legitimate (a backend's
 * docs naming its frontend), so a name is refused only in a repository KNOWN to be public; an
 * unknown visibility blocks nothing. Both lists are refreshed by `enigma private-values sync`,
 * scheduled detached from the Stop hook (private-values-learn.ts), never on a hook's own time.
 */
export interface PrivateRepos {
    names: string[];
    syncedAt: number;
    /** When a detached sync was last started, to start at most one an hour. */
    attemptAt?: number;
    /** Normalized repository root -> whether it is public, and when that was read. */
    visibility: Record<string, { public: boolean; at: number; }>;
}

export function privateReposPath(): string {
    return join(process.env.ENIGMA_CONFIG_HOME || homedir(), ".enigma", "private-repos.json");
}

export function readPrivateRepos(): PrivateRepos {
    try {
        const raw = JSON.parse(readFileSync(privateReposPath(), "utf8")) as Partial<PrivateRepos>;
        return {
            names: Array.isArray(raw.names) ? raw.names.filter((n): n is string => typeof n === "string") : [],
            syncedAt: typeof raw.syncedAt === "number" ? raw.syncedAt : 0,
            attemptAt: typeof raw.attemptAt === "number" ? raw.attemptAt : 0,
            visibility: raw.visibility && typeof raw.visibility === "object" ? raw.visibility : {},
        };
    } catch { return { names: [], syncedAt: 0, visibility: {} }; }
}

export function writePrivateRepos(repos: PrivateRepos): void {
    const path = privateReposPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(repos, null, 2)}\n`);
    renameSync(tmp, path);
}

/** Generic repository names that are ordinary words in any codebase: refusing them would block real code. */
const GENERIC_NAMES = new Set([
    "backend", "frontend", "planner", "experiments", "website", "landing", "scripts", "dotfiles", "playground", "template",
    "templates", "examples", "archive", "assets", "testing", "sandbox", "monorepo", "workspace", "internal", "private",
    "project", "projects", "mobile", "desktop", "server", "client", "worker", "gateway", "dashboard", "analytics", "payments",
    "billing", "storage", "scraper", "crawler", "library", "toolkit", "utilities", "infrastructure", "terraform", "database",
]);

/**
 * Whether a private repository's name is distinctive enough to refuse: a hyphen, underscore or
 * digit makes it an identifier (`acme-saas`), and a single word needs seven letters and must not
 * be a generic one. A short single word (`atlas`, `shield`, `docs`) would match ordinary code.
 */
export function distinctiveRepoName(name: string): boolean {
    const n = name.trim().toLowerCase();
    if (n.length < 5 || GENERIC_NAMES.has(n)) return false;
    return /[-_\d]/.test(n) || n.length >= 7;
}

/** Whether the repository at `root` is known to be public; null when it was never read. */
export function repoIsPublic(root: string | null, repos: PrivateRepos = readPrivateRepos()): boolean | null {
    if (!root) return null;
    const entry = repos.visibility[normalizeRoot(root)];
    return entry ? entry.public : null;
}

/** One matcher over the private repository names, only for a repository known to be public. */
export function privateNameMatcher(root: string | null, repos: PrivateRepos = readPrivateRepos()): RegExp | null {
    if (repoIsPublic(root, repos) !== true) return null;
    const names = repos.names.filter(distinctiveRepoName).map((n) => n.replace(/[.*+?^${}()|[\]\/]/g, "\$&"));
    // A name used as a package specifier (`from "acme-sdk"`, `require("acme-sdk")`, a manifest key)
    // is a PUBLISHED package of that name, public by definition: measured, the only two hits in a
    // public repo's whole tree were exactly that - an npm import and a Python library in a regex.
    const quote = "[\"'\\x60]";
    return names.length ? new RegExp(`(?<![\\w-])(?<!(?:from|import|require\\(|import\\()\\s*${quote})(?:${names.join("|")})(?![\\w-])(?!${quote}\\s*:)`, "i") : null;
}

/** The one matcher the guards use in `root`: learned values private there, plus private repo names when it is public. */
export function privateMatcherFor(root: string | null): RegExp | null {
    const parts = [privateValueMatcher(readPrivateValues(), root), privateNameMatcher(root)].filter((r): r is RegExp => r !== null);
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0]! : new RegExp(parts.map((r) => `(?:${r.source})`).join("|"), "i");
}
