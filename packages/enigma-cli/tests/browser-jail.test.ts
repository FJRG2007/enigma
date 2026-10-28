/**
 * The browser jail closes a visible browser that anything in an agent's session starts, and at
 * the end every browser the session left behind. The decision is pure and tested everywhere; the
 * Windows job object is exercised for real, with a copy of cmd.exe named chrome.exe standing in
 * for a browser so the test never puts a window on the screen.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import * as browserJail from "@/browser-jail";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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
    expect(browserJail.isVisibleBrowser(CHROME, `"${CHROME}" --single-argument http://localhost:3000`)).toBe(true);
    expect(browserJail.isVisibleBrowser(CHROME, `"${CHROME}" --user-data-dir=C:\\tmp\\p about:blank`)).toBe(true);
    expect(browserJail.isVisibleBrowser("/usr/bin/firefox", "/usr/bin/firefox http://localhost:8080")).toBe(true);
    expect(browserJail.isVisibleBrowser("msedge.exe", "msedge.exe")).toBe(true);
    expect(browserJail.isVisibleBrowser(CHROME, `"${CHROME}" --headless=new --dump-dom about:blank`)).toBe(false);
    expect(browserJail.isVisibleBrowser("firefox", "firefox -headless -screenshot")).toBe(false);
    expect(browserJail.isVisibleBrowser(CHROME, `"${CHROME}" --type=renderer --lang=en`)).toBe(false);
    expect(browserJail.isVisibleBrowser("firefox.exe", "firefox.exe -contentproc -childID 1")).toBe(false);
    expect(browserJail.isVisibleBrowser(CHROME, `"${CHROME}" --single-argument https://claude.com/cai/oauth/authorize?code=true`)).toBe(false);
    expect(browserJail.isVisibleBrowser("node.exe", "node.exe server.js --open")).toBe(false);
    expect(browserJail.isVisibleBrowser("msedgewebview2.exe", "msedgewebview2.exe --embedded-browser-webview=1")).toBe(false);
    // On Linux and macOS `playwright` is the test runner, not a browser; on Windows Playwright.exe is WebKit.
    expect(browserJail.isVisibleBrowser("/repo/node_modules/.bin/playwright", "/repo/node_modules/.bin/playwright test")).toBe(false);
    expect(browserJail.isVisibleBrowser("C:\\pw\\webkit-2100\\Playwright.exe", "C:\\pw\\webkit-2100\\Playwright.exe --inspector-pipe")).toBe(true);
});

test("a vendor's sign-in endpoint or an OAuth authorization request counts as a login page", () => {
    expect(browserJail.opensOnlyLogin("chrome https://platform.claude.com/oauth/authorize?x=1")).toBe(true);
    expect(browserJail.opensOnlyLogin("chrome https://auth.openai.com/oauth/authorize?client_id=x")).toBe(true);
    expect(browserJail.opensOnlyLogin("chrome https://github.com/login/device")).toBe(true);
    expect(browserJail.opensOnlyLogin("chrome https://claude.ai/new")).toBe(false);
    expect(browserJail.opensOnlyLogin("chrome http://localhost:3000/oauth/authorize")).toBe(false);
    expect(browserJail.opensOnlyLogin("chrome https://evil.example/claude.ai/oauth")).toBe(false);
    expect(browserJail.opensOnlyLogin("chrome https://platform.claude.com/oauth/authorize http://localhost:3000")).toBe(false);
    expect(browserJail.opensOnlyLogin("chrome about:blank")).toBe(false);
    expect(browserJail.opensOnlyLogin("chrome https://github.com/acme/device-tree")).toBe(false);
    expect(browserJail.opensOnlyLogin("chrome https://linear.app/oauth/authorize?client_id=abc&response_type=code&redirect_uri=http://localhost:3118/callback")).toBe(true);
    expect(browserJail.opensOnlyLogin("chrome https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=x.apps.googleusercontent.com")).toBe(true);
    expect(browserJail.opensOnlyLogin("chrome https://example.com/authorize?client_id=x")).toBe(false);
    expect(browserJail.opensOnlyLogin("chrome http://localhost:3000/authorize?client_id=x&response_type=code")).toBe(false);
});

test("at session end a browser is closed unless it is a helper or a sign-in", () => {
    expect(browserJail.closedAtExit(`"${CHROME}" --headless=new about:blank`)).toBe(true);
    expect(browserJail.closedAtExit(`"${CHROME}" http://localhost:3000`)).toBe(true);
    expect(browserJail.closedAtExit(`"${CHROME}" --type=renderer`)).toBe(false);
    expect(browserJail.closedAtExit(`"${CHROME}" --single-argument https://claude.com/cai/oauth/authorize?code=true`)).toBe(false);
    expect(browserJail.closedAtExit(`"${CHROME}" https://mcp.notion.com/authorize?response_type=code&client_id=x`)).toBe(false);
});

test("macOS app bundles and plain commands resolve to the program that runs", () => {
    expect(browserJail.commandImage("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222")).toBe("Google Chrome");
    expect(browserJail.commandImage("/Applications/Firefox.app/Contents/MacOS/firefox")).toBe("firefox");
    expect(browserJail.commandImage("/usr/bin/chromium --headless")).toBe("/usr/bin/chromium");
});

test("descendants are found through every generation and nothing outside the tree", () => {
    const rows = browserJail.parsePsTree("  10     1 Ss   /bin/launcher\n  20    10 S+   node agent.js\n  30    20 S    bash -c x\n  40    30 Sl   chromium http://x\n  50     1 Sl   chromium --mine\n  60     1 Z    [chromium] <defunct>\n");
    expect(browserJail.descendantsOf(10, rows).map((r) => r.pid)).toEqual([20, 30, 40]);
    expect(rows.find((r) => r.pid === 40)?.args).toBe("chromium http://x");
    expect(rows.find((r) => r.pid === 60)?.stat).toBe("Z");
    // An orphan the jail saw before its parent exited is followed through its own pid.
    const orphaned = browserJail.parsePsTree("  10     1 Ss   /bin/launcher\n  40     1 Sl   chromium http://x\n  41    40 Sl   chromium --type=renderer\n");
    expect(browserJail.descendantsOf(10, orphaned)).toEqual([]);
    expect(browserJail.descendantsOf([10, 40], orphaned).map((r) => r.pid)).toEqual([41]);
});

test("the agent environment tells dev servers and the Playwright report not to open a browser", () => {
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");
    const env: NodeJS.ProcessEnv = { BROWSER: "firefox" };
    browserJail.applyAgentBrowserEnv(env);
    expect(env.BROWSER).toBe("none");
    expect(env.PLAYWRIGHT_HTML_OPEN).toBe("never");

    writeFileSync(join(HOME, ".enigma.json"), `${JSON.stringify({ browserHeadless: false })}\n`);
    const off: NodeJS.ProcessEnv = {};
    browserJail.applyAgentBrowserEnv(off);
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

    const jail = await browserJail.startBrowserJail(process.pid);
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
        const login = spawn(fake, ["/d", "/c", "echo https://claude.com/cai/oauth/authorize >nul & ping -n 30 127.0.0.1 >nul"], { stdio: "ignore", windowsHide: true });
        const left = spawn(fake, ["/d", "/c", "echo --headless >nul & ping -n 30 127.0.0.1 >nul"], { stdio: "ignore", windowsHide: true });
        const exited = new Promise<number | null>((resolve) => left.on("exit", resolve));
        await new Promise((resolve) => setTimeout(resolve, 500));
        await jail?.close();
        expect(await exited).toBe(1);
        // A sign-in started in the session may be the user's browser from now on: it is left running.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(login.exitCode).toBeNull();
        login.kill();
    }
}, 30000);

test("an argument survives the Windows command line it is quoted into, and the environment block is sorted", () => {
    expect(browserJail.quoteWindowsArg("plain")).toBe("plain");
    expect(browserJail.quoteWindowsArg("")).toBe("\"\"");
    expect(browserJail.quoteWindowsArg("two words")).toBe("\"two words\"");
    expect(browserJail.quoteWindowsArg("say \"hi\"")).toBe("\"say \\\"hi\\\"\"");
    expect(browserJail.quoteWindowsArg("C:\\dir with space\\")).toBe("\"C:\\dir with space\\\\\"");
    expect(browserJail.quoteWindowsArg("a\\\\\"b c")).toBe("\"a\\\\\\\\\\\"b c\"");
    expect(browserJail.environmentBlock({ b: "2", A: "1", skip: undefined, "=C:": "x" })).toBe("A=1\0b=2\0\0");
});

test.skipIf(!windowsBun)("on Windows an agent the jail spawns gets its arguments, stdio and exit code, and a daemon it starts outlives the session under the npm launcher", async () => {
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");
    const node = Bun.which("node");
    expect(node).not.toBeNull();
    const out = join(HOME, "argv.json");
    const daemonPid = join(HOME, "daemon.pid");
    const agent = join(HOME, "agent.cjs");
    writeFileSync(agent, [
        "const { spawn } = require(\"node:child_process\");",
        "const { writeFileSync } = require(\"node:fs\");",
        "const d = spawn(process.execPath, [\"-e\", \"setTimeout(() => {}, 20000)\"], { stdio: \"ignore\", detached: true, windowsHide: true });",
        "d.unref();",
        `writeFileSync(${JSON.stringify(daemonPid)}, String(d.pid));`,
        `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), browser: process.env.BROWSER }));`,
        "process.stdout.write(\"to-stdout\");",
        "process.exit(7);",
    ].join("\n"));
    // The launcher process the npm wrapper starts: in libuv's kill-on-close job, as in a real session.
    const launcher = join(HOME, "launcher.ts");
    const args = ["two words", "say \"hi\"", "C:\\dir with space\\", ""];
    writeFileSync(launcher, [
        `import { startAgentBrowserJail } from ${JSON.stringify(join(import.meta.dir, "..", "src", "browser-jail.ts"))};`,
        `import { spawnInherit } from ${JSON.stringify(join(import.meta.dir, "..", "src", "accounts.ts"))};`,
        "const browsers = await startAgentBrowserJail();",
        "if (!browsers?.spawn) process.exit(90);",
        `const code = await spawnInherit(${JSON.stringify(node)}, [${JSON.stringify(agent)}, ...${JSON.stringify(args)}], { ...process.env, BROWSER: "none" }, browsers);`,
        "await browsers.close();",
        "process.exit(code);",
    ].join("\n"));
    const wrapper = spawn(node!, ["-e", `const r = require("child_process").spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(launcher)}], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }); process.stdout.write(r.stdout); process.exit(r.status);`], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    let stdout = "";
    wrapper.stdout!.on("data", (chunk) => { stdout += chunk; });
    const code = await new Promise<number | null>((resolve) => wrapper.on("exit", resolve));
    expect(code).toBe(7);
    expect(stdout).toBe("to-stdout");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ argv: args, browser: "none" });
    const pid = Number(readFileSync(daemonPid, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(true);
    try { process.kill(pid); } catch { /* already gone */ }
}, 60000);

test.skipIf(!windowsBun)("on Windows an agent the jail spawns ends when its launcher is killed, and a daemon it started does not", async () => {
    writeFileSync(join(HOME, ".enigma.json"), "{}\n");
    const node = Bun.which("node");
    expect(node).not.toBeNull();
    const pids = join(HOME, "orphan.json");
    const agent = join(HOME, "orphan-agent.cjs");
    writeFileSync(agent, [
        "const { spawn } = require(\"node:child_process\");",
        "const { writeFileSync } = require(\"node:fs\");",
        "const d = spawn(process.execPath, [\"-e\", \"setTimeout(() => {}, 20000)\"], { stdio: \"ignore\", detached: true, windowsHide: true });",
        "d.unref();",
        `writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ agent: process.pid, daemon: d.pid }));`,
        "setTimeout(() => {}, 20000);",
    ].join("\n"));
    const launcher = join(HOME, "orphan-launcher.ts");
    writeFileSync(launcher, [
        `import { startAgentBrowserJail } from ${JSON.stringify(join(import.meta.dir, "..", "src", "browser-jail.ts"))};`,
        `import { spawnInherit } from ${JSON.stringify(join(import.meta.dir, "..", "src", "accounts.ts"))};`,
        "const browsers = await startAgentBrowserJail();",
        "if (!browsers?.spawn) process.exit(90);",
        `process.exit(await spawnInherit(${JSON.stringify(node)}, [${JSON.stringify(agent)}], process.env, browsers));`,
    ].join("\n"));
    const run = spawn(process.execPath, [launcher], { stdio: "ignore", windowsHide: true });
    const exited = new Promise((resolve) => run.on("exit", resolve));
    const deadline = Date.now() + 20000;
    while (!existsSync(pids) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const { agent: agentPid, daemon } = JSON.parse(readFileSync(pids, "utf8")) as { agent: number; daemon: number; };
    run.kill();
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive(agentPid)).toBe(false);
    expect(alive(daemon)).toBe(true);
    try { process.kill(daemon); } catch { /* already gone */ }
    try { process.kill(agentPid); } catch { /* already gone */ }
}, 60000);
