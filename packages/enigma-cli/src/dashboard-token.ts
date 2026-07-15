/**
 * Shared-secret token for the dashboard's HTTP surface.
 *
 * The dashboard is an admin surface: it can run coding agents with your credentials,
 * kill processes, rewrite agent config and import/export settings. So any bind beyond
 * loopback requires this token and refuses to start without one - the dashboard is
 * never exposed unauthenticated.
 *
 * The token lives in its own 0600 file rather than in .enigma.json because that file is
 * deliberately committable (a team can check their enigma settings into a repo), and a
 * secret there would land in git. ENIGMA_DASHBOARD_TOKEN overrides the file so a
 * deployment can inject the secret from a manager instead of writing it to disk.
 */

import { join } from "node:path";
import { enigmaHome } from "./util";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** Resolved per call, never at module load, so tests can point ENIGMA_CONFIG_HOME at a temp dir. */
function tokenFile(): string {
    return join(enigmaHome(), ".enigma", "dashboard-token");
}

/** The active token, or null when none is set. The env var wins so a secrets manager can inject it. */
export function readDashboardToken(): string | null {
    const fromEnv = (process.env.ENIGMA_DASHBOARD_TOKEN || "").trim();
    if (fromEnv) return fromEnv;
    try { return readFileSync(tokenFile(), "utf8").trim() || null; } catch { return null; }
}

/**
 * The token to authenticate with, generating and persisting one on first use. `rotate`
 * forces a fresh secret, invalidating every URL handed out earlier. Returns the env token
 * untouched when one is set: that secret is owned by whatever injected it, not by us.
 */
export function ensureDashboardToken(rotate = false): string {
    const fromEnv = (process.env.ENIGMA_DASHBOARD_TOKEN || "").trim();
    if (fromEnv) return fromEnv;
    if (!rotate) {
        const existing = readDashboardToken();
        if (existing) return existing;
    }
    // 32 bytes from a CSPRNG: not guessable, and base64url survives a URL fragment as-is.
    const token = randomBytes(32).toString("base64url");
    const file = tokenFile();
    mkdirSync(join(enigmaHome(), ".enigma"), { recursive: true });
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
    // `mode` above only applies when writeFileSync CREATES the file, so an existing
    // token file keeps its old permissions - chmod covers that. Windows has no POSIX
    // modes and throws nothing useful here, hence best-effort.
    try { chmodSync(file, 0o600); } catch { /* not a POSIX filesystem */ }
    return token;
}

/** Drop the stored token. A non-loopback dashboard then refuses to start until one exists. */
export function clearDashboardToken(): void {
    try { unlinkSync(tokenFile()); } catch { /* already gone */ }
}

/**
 * Constant-time token compare. Both sides are hashed first so the comparison is always
 * over 32 bytes: a plain length check would short-circuit and leak the token's length,
 * and timingSafeEqual throws on mismatched lengths.
 */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
    if (!presented) return false;
    const a = createHash("sha256").update(expected).digest();
    const b = createHash("sha256").update(presented).digest();
    return timingSafeEqual(a, b);
}

/** The token carried by an `Authorization: Bearer <token>` header, if any. */
export function bearerOf(header: string | undefined): string | undefined {
    const match = /^Bearer[ \t]+(\S+)$/i.exec((header || "").trim());
    return match ? match[1] : undefined;
}
