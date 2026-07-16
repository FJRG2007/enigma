/**
 * On-demand delivery of the dashboard UI bundle (@enigmax/dashboard). The browser page
 * and its ~196 KB charting library are NOT shipped in the base enigma-cli package: a user
 * who never opens the dashboard never downloads them. They are installed into a managed
 * dir (~/.enigma/dashboard) the first time the dashboard is enabled or opened, and enigma
 * keeps the package current on `enigma update` - so the UI is enigma's dependency to
 * maintain, not the user's.
 *
 * Mirrors the @enigmax/linter delivery pattern in lint.ts: a managed install dir, a
 * synchronous best-effort installer, a detached background installer (hidden
 * `__dashboard-install` command), and a runtime resolver that self-heals - if the package
 * is absent the server falls back to a minimal built-in page until the install lands.
 *
 * Node-builtins + nothing else (no agent-module imports) so it stays cheap to load and
 * free of import cycles (dashboard.ts imports this; this imports nothing of enigma's).
 */

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Managed dir where @enigmax/dashboard is installed on demand. */
export const DASHBOARD_INSTALL_DIR = process.env.ENIGMA_DASHBOARD_DIR || join(homedir(), ".enigma", "dashboard");

/** The package's installed asset dir (its package.json lives one level up). */
function managedAssetsDir(): string {
    return join(DASHBOARD_INSTALL_DIR, "node_modules", "@enigmax", "dashboard", "assets");
}

/** Whether the managed @enigmax/dashboard install is present. */
export function isDashboardPkgInstalled(): boolean {
    return existsSync(join(DASHBOARD_INSTALL_DIR, "node_modules", "@enigmax", "dashboard", "package.json"));
}

/** Marker recording the enigma-cli version that last fetched the UI bundle. */
function versionMarkerPath(): string {
    return join(DASHBOARD_INSTALL_DIR, ".cli-version");
}

/** This launcher's enigma-cli version (set by the launcher); empty when unknown (dev). */
function cliVersion(): string {
    return process.env.ENIGMA_VERSION || "";
}

/** Record the current enigma-cli version next to the install, so staleness is detectable. */
function markFetched(): void {
    try { writeFileSync(versionMarkerPath(), cliVersion()); } catch { /* best-effort */ }
}

/**
 * Whether the installed UI bundle is current for THIS enigma-cli version. The UI and the
 * server share an evolving /api contract and ship together, so the bundle must be refreshed
 * whenever enigma-cli changes - not merely when it is absent. Installing if missing alone
 * left users on an old cached UI after a CLI update (the bug behind "the dashboard looks the
 * same after updating"). An unknown CLI version (a source/dev run) never forces a refetch.
 */
export function isDashboardPkgCurrent(): boolean {
    if (!isDashboardPkgInstalled()) return false;
    const cli = cliVersion();
    if (!cli) return true;
    try { return readFileSync(versionMarkerPath(), "utf8").trim() === cli; } catch { return false; }
}

/**
 * Resolve the dashboard UI asset dir (the folder holding index.html and lib/), or null if
 * it cannot be found. Order: explicit override (tests/dev) -> managed on-demand install ->
 * the workspace package when running from source in the monorepo. The compiled binary's
 * virtual __dirname makes the dev path miss, so it uses the managed install or the override.
 */
export function dashboardAssetsDir(): string | null {
    if (process.env.ENIGMA_DASHBOARD_ASSETS) return process.env.ENIGMA_DASHBOARD_ASSETS;
    const managed = managedAssetsDir();
    if (existsSync(join(managed, "index.html"))) return managed;
    const dev = join(__dirname, "..", "..", "dashboard", "assets");
    if (existsSync(join(dev, "index.html"))) return dev;
    return null;
}

/** Ensure the managed host dir exists with a private manifest so npm installs there. */
function ensureHostDir(): void {
    mkdirSync(DASHBOARD_INSTALL_DIR, { recursive: true });
    const manifest = join(DASHBOARD_INSTALL_DIR, "package.json");
    if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: "enigma-dashboard-host", private: true }, null, 2) + "\n");
}

/** Run `npm install @enigmax/dashboard@<spec>` in the managed dir. Best-effort, never throws. */
function npmInstall(spec: string): void {
    try {
        ensureHostDir();
        // shell:true so Windows resolves npm.cmd; windowsHide so the cmd.exe it spawns never
        // flashes a console window; output suppressed to keep the install quiet. --prefer-online
        // revalidates the registry so a stale npm cache never pins an old @latest.
        spawnSync("npm", ["install", `@enigmax/dashboard@${spec}`, "--no-audit", "--no-fund", "--silent", "--prefer-online"], {
            cwd: DASHBOARD_INSTALL_DIR, shell: true, stdio: "ignore", timeout: 120000, windowsHide: true,
        });
        if (isDashboardPkgInstalled()) markFetched();
    } catch { /* best-effort: a missing npm or no network just leaves the UI un-fetched */ }
}

/**
 * Ensure the UI bundle is present AND current for this enigma-cli version, installing or
 * refreshing it as needed. Returns true when the package is present afterwards. This is the
 * entry the dashboard open path uses, so a CLI update always pulls the matching UI.
 */
export function ensureDashboardCurrent(): boolean {
    if (isDashboardPkgCurrent()) return true;
    npmInstall("latest");
    return isDashboardPkgInstalled();
}

/** Force-refresh the UI bundle to the latest published version (used by `enigma update`). */
/** The version of the installed UI bundle, or null when it is not installed/readable. */
export function installedDashboardVersion(): string | null {
    try {
        const pkg = JSON.parse(readFileSync(join(DASHBOARD_INSTALL_DIR, "node_modules", "@enigmax", "dashboard", "package.json"), "utf8"));
        return typeof pkg.version === "string" ? pkg.version : null;
    } catch { return null; }
}

/** Force-fetch the latest UI bundle; returns true only if the installed version changed. */
export function refreshDashboardPkg(): boolean {
    const before = installedDashboardVersion();
    npmInstall("latest");
    return installedDashboardVersion() !== before;
}

/**
 * Kick off the install/refresh in a detached background process (hidden
 * `__dashboard-install`), so enabling the dashboard never blocks. No-op when already current.
 */
export function spawnDashboardPkgInstall(): void {
    if (isDashboardPkgCurrent()) return;
    try {
        // Same runtime dispatch as the lint-install/update-check children: a compiled
        // binary takes the hidden command directly; node/bun on source need argv[1] first.
        const exe = basename(process.execPath).toLowerCase();
        const dev = exe === "node" || exe === "node.exe" || exe === "bun" || exe === "bun.exe";
        const args = dev ? [process.argv[1]!, "__dashboard-install"] : ["__dashboard-install"];
        const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
        // A spawn failure surfaces as an async `error` event; with no listener the child
        // rethrows it as an uncaught exception, which this try/catch cannot intercept.
        child.on("error", () => { /* the UI falls back to the bundled placeholder page */ });
        child.unref();
    } catch { /* best-effort */ }
}
