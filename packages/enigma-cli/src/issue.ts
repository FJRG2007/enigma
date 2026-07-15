/**
 * `enigma issue` - build a prefilled GitHub issue URL so reporters never have to
 * look up environment details by hand. Everything deterministically knowable
 * (OS + version, terminal, detected agents, enigma version, install method) is
 * mapped onto the issue-form field ids in .github/ISSUE_TEMPLATE/*.yml: GitHub
 * prefills form inputs and dropdowns from query params matching those ids, and
 * dropdown values must match an option string exactly. Detection is best-effort;
 * a field we cannot determine is simply left for the reporter to fill in.
 */

import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { discoverAgents } from "./agents";

const REPO_ISSUES_URL = "https://github.com/FJRG2007/enigma/issues/new";

export type IssueKind = "bug" | "feature";

const TEMPLATES: Record<IssueKind, string> = {
    bug: "bug_report.yml",
    feature: "feature_request.yml",
};

/** Map process.platform onto the template's "Operating system" dropdown options. */
function detectOsName(): string {
    switch (process.platform) {
        case "win32": return "Windows";
        case "darwin": return "macOS";
        case "linux": return "Linux";
        default: return "Other";
    }
}

/**
 * Human OS version for the free-text field, e.g. "Windows 11 Pro 10.0.26200",
 * "macOS 15.2", "Ubuntu 24.04.1 LTS". Falls back to the kernel identification.
 */
function detectOsVersion(): string {
    try {
        if (process.platform === "win32") return `${os.version()} ${os.release()}`.trim();
        if (process.platform === "darwin") {
            const out = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 3000 });
            const product = out.status === 0 ? out.stdout.trim() : "";
            return product ? `macOS ${product}` : `Darwin ${os.release()}`;
        }
        if (process.platform === "linux") {
            const release = readFileSync("/etc/os-release", "utf8");
            const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release)?.[1];
            if (pretty) return pretty;
        }
    } catch { /* fall through to the generic kernel string */ }
    return `${os.type()} ${os.release()}`;
}

/** Map env hints onto the template's "Terminal" dropdown, or null when unsure. */
function detectTerminal(): string | null {
    const program = process.env.TERM_PROGRAM;
    if (program === "WarpTerminal") return "Warp";
    if (program === "vscode") return "VS Code integrated terminal";
    if (program === "iTerm.app") return "iTerm2";
    if (process.env.WT_SESSION) return "Windows Terminal";
    const shell = basename(process.env.SHELL ?? "");
    if (shell === "zsh") return "Zsh";
    if (shell === "bash") return "Bash";
    if (shell === "fish") return "Fish";
    return null;
}

/** Map how this process is running onto the "Install method" dropdown. */
function detectInstallMethod(): string {
    const exe = basename(process.execPath).toLowerCase();
    // Only the packaged distribution runs as the compiled enigma binary; dev runs
    // under node/tsx or Bun-on-source.
    if (!exe.startsWith("enigma-bin")) return "From source (this repo)";
    if (process.execPath.includes("_npx")) return "npx enigma-cli";
    return "npm install -g enigma-cli";
}

/** Detected agents as "Coding agent" dropdown options (labels match exactly). */
function detectTools(): string[] {
    try {
        return discoverAgents().filter((a) => a.installed).map((a) => a.label);
    } catch {
        return [];
    }
}

/** Build the prefilled new-issue URL for the given template. */
export function buildIssueUrl(kind: IssueKind, version: string): string {
    const params = new URLSearchParams({ template: TEMPLATES[kind] });
    const tools = detectTools();
    // Multi-select dropdowns prefill from a comma-separated option list.
    if (tools.length) params.set("tool", tools.join(","));
    if (kind === "bug") {
        params.set("os", detectOsName());
        params.set("os-version", detectOsVersion());
        const terminal = detectTerminal();
        if (terminal) params.set("terminal", terminal);
        params.set("enigma-version", version);
        params.set("install-method", detectInstallMethod());
    }
    return `${REPO_ISSUES_URL}?${params.toString()}`;
}

/**
 * Whether this host has no reachable GUI, so launching a browser is pointless.
 * Windows and macOS always have one; Linux/BSD need a display server, which a
 * server accessed over SSH does not have. Callers print the URL instead.
 */
export function isHeadless(): boolean {
    if (process.platform === "win32" || process.platform === "darwin") return false;
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

/**
 * Open a URL in the default browser, detached and best-effort; returns false when
 * no browser could be launched so the caller can print the URL instead. The URL is
 * built by us from constants + URL-encoded params (never untrusted input). Windows
 * uses rundll32's protocol handler instead of `cmd /c start` so the `&` separators
 * in the query string can never be parsed as command separators.
 *
 * The `error` listener is load-bearing, not decorative: a missing opener (a bare
 * server has no `xdg-open`) surfaces as an ASYNCHRONOUS `error` event on the child,
 * which an EventEmitter with no listener rethrows as an uncaught exception - the
 * try/catch cannot see it, and it would take the whole CLI down.
 */
export function openUrl(url: string): boolean {
    if (isHeadless()) return false;
    try {
        const [bin, args] = process.platform === "win32"
            ? ["rundll32", ["url.dll,FileProtocolHandler", url]] as const
            : process.platform === "darwin"
                ? ["open", [url]] as const
                : ["xdg-open", [url]] as const;
        const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => { /* no opener installed: the caller prints the URL */ });
        child.unref();
        return true;
    } catch {
        return false;
    }
}
