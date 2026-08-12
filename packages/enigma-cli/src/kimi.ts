/**
 * Kimi Code specific configuration: the workspace-trust pre-answer.
 *
 * Kimi Code asks "Trust this folder?" the first time it starts in a directory, and refuses
 * to load that project's MCP servers (or to start at all, if you decline) until you answer.
 * The answer is a document in its own data root, NOT a config key:
 *
 *   $KIMI_CODE_HOME/workspace-trust/<workDirKey>   ->   {"root":"<dir>","trustedAt":<ms>}
 *
 * The service treats the presence of that document as trust, so writing it is the whole
 * pre-answer. Unlike Claude Code, trust is NOT inherited from parent directories: the key is
 * a hash of the exact working directory, so there is no root entry that covers everything.
 * The equivalent coverage comes from where this is called instead - the sync path runs on
 * every `enigma <tool>` launch, install and update, so the directory being opened is trusted
 * just before the agent starts.
 *
 * `encodeWorkDirKey` has to match Kimi's own computation exactly or the document is one it
 * never reads. It is a port of `packages/agent-core-v2/src/workspace/workdir-slug.ts` as
 * shipped in kimi 0.35.0, and the test pins it against a key Kimi itself wrote.
 *
 * This is a deliberate security trade-off, which is why it is a toggle: the prompt exists to
 * make you look at code you did not write before an agent runs in it.
 */

import { readConfig } from "./config";
import { createHash } from "node:crypto";
import { isDir, enigmaHome } from "./util";
import { win32, join, resolve, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

/** Kimi's trust document directory inside a data root. */
const TRUST_SCOPE = "workspace-trust";
/** Longest slug segment of a workdir key, and how much of the digest follows it. */
const MAX_SLUG_LENGTH = 40;
const HASH_LENGTH = 12;

/** Kimi's default data root (KIMI_CODE_HOME relocates it; managed accounts pass their own). */
export function kimiHome(): string {
    return join(enigmaHome(), ".kimi-code");
}

/** The `<slug>` half of a workdir key: lowercased, non-alphanumerics folded to `-`, trimmed. */
function slugifyWorkDirName(name: string): string {
    const slug = name.toLowerCase()
        .replaceAll(/[^a-z0-9._-]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, MAX_SLUG_LENGTH)
        .replaceAll(/^-+|-+$/g, "");
    return slug === "" || slug === "." || slug === ".." ? "workspace" : slug;
}

/**
 * The opaque id Kimi files a working directory under: `wd_<slug>_<sha256[0..12]>` over the
 * directory with forward slashes and no trailing separator. Windows paths are resolved with
 * the win32 rules Kimi uses, so drive-relative input still lands on the same key.
 */
export function encodeWorkDirKey(dir: string): string {
    const absolute = /^[A-Za-z]:[\\/]/.test(dir) ? win32.resolve(dir) : resolve(dir);
    const normalized = absolute.replaceAll("\\", "/").replace(/\/+$/, "");
    const name = normalized.split("/").pop() || normalized;
    return `wd_${slugifyWorkDirName(name)}_${createHash("sha256").update(normalized).digest("hex").slice(0, HASH_LENGTH)}`;
}

/** The trust document for `dir` inside a Kimi data root. */
export function kimiTrustPath(home: string, dir: string): string {
    return join(home, TRUST_SCOPE, encodeWorkDirKey(dir));
}

/** Whether `dir` is already trusted in a Kimi data root (by enigma or by the user). */
export function isKimiWorkspaceTrusted(home: string, dir: string): boolean {
    return existsSync(kimiTrustPath(home, dir));
}

/**
 * Pre-answer the trust prompt for `dir` in a Kimi data root. Returns true when the document
 * was created - so a caller that runs on every launch stays a no-op once it exists. Written
 * byte-for-byte in Kimi's own shape (compact JSON, no trailing newline, the unnormalized path
 * as `root`), so the document is indistinguishable from one Kimi wrote itself.
 */
export function trustKimiWorkspace(home: string, dir: string): boolean {
    const path = kimiTrustPath(home, dir);
    if (existsSync(path)) return false;
    // Never create a data root for a tool that has never run: an empty ~/.kimi-code would
    // make every "is Kimi installed" check say yes.
    if (!isDir(home)) return false;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ root: resolve(dir), trustedAt: Date.now() }));
    return true;
}

/**
 * Apply the trust pre-answer for the current working directory (default account). Turning the
 * setting OFF removes nothing: every Kimi trust document is per-directory and identical to one
 * the user wrote by accepting the prompt, so clearing them would re-ask for every folder they
 * had already trusted - the same reasoning as Claude's per-workspace entries. Off means enigma
 * stops pre-answering from here on.
 */
export function setKimiTrust(on: boolean): boolean {
    return on ? trustKimiWorkspace(kimiHome(), process.cwd()) : false;
}

/**
 * Propagate the pre-answer into a managed account's data root, which has its own trust
 * documents - without this, `enigma kimi <account>` would meet the prompt the default account
 * no longer shows.
 */
export function mirrorKimiTrust(accountDir: string): boolean {
    if (!readConfig().config.kimiTrust) return false;
    return trustKimiWorkspace(accountDir, process.cwd());
}
