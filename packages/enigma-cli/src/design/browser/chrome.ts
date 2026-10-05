/**
 * Find and launch a locally installed Chromium-family browser (Chrome, Edge, Chromium,
 * Brave) headless with the DevTools protocol on a random loopback port.
 *
 * Nothing is downloaded: the browser already on the machine does the rendering. Each
 * launch gets a throwaway profile directory, so the user's own profile, cookies and
 * extensions are never touched, and the directory is removed on close. Discovery
 * follows the paths Lighthouse's chrome-launcher checks; the endpoint is read from the
 * `DevTools listening on ws://...` line Chrome prints (the DevToolsActivePort file in
 * the profile is the fallback), which is how Puppeteer attaches too.
 */

import { join } from "node:path";
import { resolveBin } from "@/util";
import { homedir, tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";

const LAUNCH_TIMEOUT_MS = 30_000;

/** Candidate executables for this OS, most preferred first. */
function candidates(): string[] {
    if (process.platform === "win32") {
        const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter((r): r is string => !!r);
        const rel = [
            ["Google", "Chrome", "Application", "chrome.exe"],
            ["Chromium", "Application", "chrome.exe"],
            ["Microsoft", "Edge", "Application", "msedge.exe"],
            ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
        ];
        return rel.flatMap((parts) => roots.map((root) => join(root, ...parts)));
    }
    if (process.platform === "darwin") {
        const apps = [
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Chromium.app/Contents/MacOS/Chromium",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Brave Browser.app/Contents/MacOS/Brave Browser",
        ];
        return apps.flatMap((app) => [join("/Applications", app), join(homedir(), "Applications", app)]);
    }
    const bins = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"];
    return [...bins.map((b) => resolveBin(b)).filter((p): p is string => !!p), "/snap/bin/chromium"];
}

/**
 * The browser executable to drive: `--browser`, then `ENIGMA_BROWSER` / `CHROME_PATH`,
 * then the first installed candidate. Null when none is found.
 */
export function findBrowser(explicit?: string | null): string | null {
    for (const path of [explicit, process.env.ENIGMA_BROWSER, process.env.CHROME_PATH]) {
        if (path) return existsSync(path) ? path : null;
    }
    return candidates().find((p) => existsSync(p)) ?? null;
}

export interface LaunchedBrowser {
    /** The browser-level DevTools WebSocket endpoint. */
    wsEndpoint: string;
    process: ChildProcess;
    /** Stop the process, wait for it to exit, and delete the throwaway profile. Safe to call twice. */
    dispose: () => Promise<void>;
}

const EXIT_WAIT_MS = 5_000;

function removeProfile(dir: string): void {
    // Chrome releases profile files a moment after it exits on Windows; retry briefly.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left for the OS temp cleaner */ }
}

/** Live browsers, so a run that dies mid-extraction still kills them and clears their profiles. */
const live = new Map<ChildProcess, string>();
let exitHookInstalled = false;

function installExitHook(): void {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once("exit", () => {
        for (const [child, profile] of live) {
            if (child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
            removeProfile(profile);
        }
    });
}

function exited(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, EXIT_WAIT_MS);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
}

export async function launchBrowser(executable: string): Promise<LaunchedBrowser> {
    const profile = mkdtempSync(join(tmpdir(), "enigma-design-"));
    const args = [
        "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
        "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
        "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
        "--hide-scrollbars", "--mute-audio", "--window-size=1440,900",
    ];
    // Chrome refuses to start its sandbox as root (containers, CI); that is the only case it is lifted.
    if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
    args.push("about:blank");

    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    installExitHook();
    live.set(child, profile);
    let disposed: Promise<void> | null = null;
    const dispose = (): Promise<void> => {
        disposed ??= (async () => {
            const done = exited(child);
            if (child.exitCode === null) { try { child.kill(); } catch { /* already gone */ } }
            await done;
            live.delete(child);
            removeProfile(profile);
        })();
        return disposed;
    };

    try {
        const wsEndpoint = await new Promise<string>((resolve, reject) => {
            let stderr = "";
            const timer = setTimeout(() => {
                const fromFile = readActivePort(profile);
                if (fromFile) resolve(fromFile);
                else reject(new Error(`browser did not expose DevTools within ${LAUNCH_TIMEOUT_MS / 1000}s${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`));
            }, LAUNCH_TIMEOUT_MS);
            child.stderr!.setEncoding("utf8");
            child.stderr!.on("data", (chunk: string) => {
                stderr += chunk;
                const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
                if (m) { clearTimeout(timer); resolve(m[1]!); }
            });
            child.once("error", (err) => { clearTimeout(timer); reject(err); });
            child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`browser exited during startup (code ${code})${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`)); });
        });
        // Keep draining stderr so a chatty browser never blocks on a full pipe.
        child.stderr!.resume();
        return { wsEndpoint, process: child, dispose };
    } catch (err) {
        await dispose();
        throw err;
    }
}

function readActivePort(profile: string): string | null {
    try {
        const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
        return port && path ? `ws://127.0.0.1:${port.trim()}${path.trim()}` : null;
    } catch { return null; }
}
