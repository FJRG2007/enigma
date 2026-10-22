/**
 * The browser jail closes a visible browser that anything in an agent's session starts, and at
 * the end every browser the session left behind. The decision is pure and tested everywhere; the
 * Windows job object is exercised for real, with a copy of cmd.exe named chrome.exe standing in
 * for a browser so the test never puts a window on the screen.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { applyAgentBrowserEnv, commandImage, descendantsOf, isVisibleBrowser, opensOnlyLogin, parsePsTree, startBrowserJail } from "@/browser-jail";

const HOME = mkdtempSync(join(tmpdir(), "enigma-browser-jail-"));
let priorHome: string | undefined;

beforeAll(() => {
    priorHome = process.env.ENIGMA_CONFIG_HOME;
    process.env.ENIGMA_CONFIG_HOME = HOME;
});

afterAll(() => {
    if (priorHome === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = priorHome;
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

test("a browser main process without a headless flag is visible; helpers, headless runs and sign-in pages are not", () => {
    expect(isVisibleBrowser(CHROME, `"${CHROME}" --single-argument http://localhost:3000`)).toBe(true);
    expect(isVisibleBrowser(CHROME, `"${CHROME}" --user-data-dir=C:\\tmp\\p about:blank`)).toBe(true);
    expect(isVisibleBrowser("/usr/bin/firefox", "/usr/bin/firefox http://localhost:8080")).toBe(true);
    expect(isVisibleBrowser("msedge.exe", "msedge.exe")).toBe(true);
    expect(isVisibleBrowser(CHROME, `"${CHROME}" --headless=new --dump-dom about:blank`)).toBe(false);
    expect(isVisibleBrowser("firefox", "firefox -headless -screenshot")).toBe(false);
    expect(isVisibleBrowser(CHROME, `"${CHROME}" --type=renderer --lang=en`)).toBe(false);
    expect(isVisibleBrowser("firefox.exe", "firefox.exe -contentproc -childID 1")).toBe(false);
    expect(isVisibleBrowser(CHROME, `"${CHROME}" --single-argument https://claude.com/cai/oauth/authorize?code=true`)).toBe(false);
    expect(isVisibleBrowser("node.exe", "node.exe server.js --open")).toBe(false);
    expect(isVisibleBrowser("msedgewebview2.exe", "msedgewebview2.exe --embedded-browser-webview=1")).toBe(false);
    // On Linux and macOS `playwright` is the test runner, not a browser; on Windows Playwright.exe is WebKit.
    expect(isVisibleBrowser("/repo/node_modules/.bin/playwright", "/repo/node_modules/.bin/playwright test")).toBe(false);
    expect(isVisibleBrowser("C:\\pw\\webkit-2100\\Playwright.exe", "C:\\pw\\webkit-2100\\Playwright.exe --inspector-pipe")).toBe(true);
});

test("only a vendor's sign-in endpoint counts as a login page", () => {
    expect(opensOnlyLogin("chrome https://platform.claude.com/oauth/authorize?x=1")).toBe(true);
    expect(opensOnlyLogin("chrome https://auth.openai.com/oauth/authorize?client_id=x")).toBe(true);
    expect(opensOnlyLogin("chrome https://github.com/login/device")).toBe(true);
    expect(opensOnlyLogin("chrome https://claude.ai/new")).toBe(false);
    expect(opensOnlyLogin("chrome http://localhost:3000/oauth/authorize")).toBe(false);
    expect(opensOnlyLogin("chrome https://evil.example/claude.ai/oauth")).toBe(false);
    expect(opensOnlyLogin("chrome https://platform.claude.com/oauth/authorize http://localhost:3000")).toBe(false);
    expect(opensOnlyLogin("chrome about:blank")).toBe(false);
    expect(opensOnlyLogin("chrome https://github.com/acme/device-tree")).toBe(false);
});

test("macOS app bundles and plain commands resolve to the program that runs", () => {
    expect(commandImage("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222")).toBe("Google Chrome");
    expect(commandImage("/Applications/Firefox.app/Contents/MacOS/firefox")).toBe("firefox");
    expect(commandImage("/usr/bin/chromium --headless")).toBe("/usr/bin/chromium");
});

test("descendants are found through every generation and nothing outside the tree", () => {
    const rows = parsePsTree("  10     1 /bin/launcher\n  20    10 node agent.js\n  30    20 bash -c x\n  40    30 chromium http://x\n  50     1 chromium --mine\n");
    expect(descendantsOf(10, rows).map((r) => r.pid)).toEqual([20, 30, 40]);
    expect(rows.find((r) => r.pid === 40)?.args).toBe("chromium http://x");
});

test("the agent environment tells dev servers and the Playwright report not to open a browser", () => {
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");
    const env: NodeJS.ProcessEnv = { BROWSER: "firefox" };
    applyAgentBrowserEnv(env);
    expect(env.BROWSER).toBe("none");
    expect(env.PLAYWRIGHT_HTML_OPEN).toBe("never");

    writeFileSync(join(HOME, ".enigma.json"), `${JSON.stringify({ browserHeadless: false })}\n`);
    const off: NodeJS.ProcessEnv = {};
    applyAgentBrowserEnv(off);
    expect(off.BROWSER).toBeUndefined();
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");
});

/** Run `exe args`, resolving with its exit code and how long it lived. */
function run(exe: string, args: string[]): Promise<{ code: number | null; ms: number; }> {
    const started = Date.now();
    return new Promise((resolve) => {
        const child = spawn(exe, args, { stdio: "ignore", windowsHide: true });
        child.on("exit", (code) => resolve({ code, ms: Date.now() - started }));
        child.on("error", () => resolve({ code: -1, ms: Date.now() - started }));
    });
}

const windowsBun = process.platform === "win32" && typeof (globalThis as { Bun?: unknown; }).Bun !== "undefined";

test.skipIf(!windowsBun)("on Windows a visible browser started in the session is closed before it runs, a headless one is left until the session ends", async () => {
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");
    const dir = join(HOME, "fake");
    mkdirSync(dir, { recursive: true });
    const fake = join(dir, "chrome.exe");
    copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), fake);

    const jail = await startBrowserJail(process.pid);
    expect(jail).not.toBeNull();
    try {
        // The fake writes a marker as its first act: no marker means it died before doing anything.
        const marker = join(HOME, "visible.txt");
        const visible = await run(fake, ["/d", "/c", `echo x>"${marker}"& ping -n 5 127.0.0.1 >nul`]);
        expect(visible.code).toBe(1);
        expect(existsSync(marker)).toBe(false);

        const headless = await run(fake, ["/d", "/c", "echo --headless >nul & ping -n 2 127.0.0.1 >nul"]);
        expect(headless.code).toBe(0);

        // Started through ShellExecute, whose parent is gone by the time it runs: still in the job.
        const viaShell = await run("powershell", ["-NoProfile", "-Command", `Start-Process -WindowStyle Hidden -Wait '${fake}' -ArgumentList '/d','/c','ping -n 8 127.0.0.1'`]);
        expect(viaShell.ms).toBeLessThan(6000);

        // `detached` asks to leave the job: the spawn must still succeed (no EPERM), a detached
        // non-browser must keep running, and a detached browser is followed by its parent and closed.
        const daemon = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "ignore", windowsHide: true, detached: true });
        const daemonExit = new Promise<number | null>((resolve) => daemon.on("exit", resolve));
        const loose = spawn(fake, ["/d", "/c", "ping -n 8 127.0.0.1 >nul"], { stdio: "ignore", windowsHide: true, detached: true });
        const looseStarted = Date.now();
        const looseExit = await new Promise<number | null>((resolve) => loose.on("exit", resolve));
        expect(looseExit).toBe(1);
        expect(Date.now() - looseStarted).toBeLessThan(3000);
        expect(await daemonExit).toBe(0);
    } finally {
        const left = spawn(fake, ["/d", "/c", "echo --headless >nul & ping -n 30 127.0.0.1 >nul"], { stdio: "ignore", windowsHide: true });
        const exited = new Promise<number | null>((resolve) => left.on("exit", resolve));
        await new Promise((resolve) => setTimeout(resolve, 500));
        jail?.close();
        expect(await exited).toBe(1);
    }
}, 30000);
