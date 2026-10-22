/**
 * The browser guard refuses a shell command that would put a browser window on the user's
 * screen: a browser started without --headless, a URL handed to the default browser, a headed
 * test run. Commands that only NAME a browser (kill it, list it, look for its binary) and
 * browsers started headless pass, and so does everything once headless is turned off.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { COMMAND_PATTERNS, applyBrowserGuard, commandSegments, runBrowserGuardHook, visibleBrowserReason } from "@/browser-guard";

const payload = (command: string, tool = "Bash"): string => JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: process.cwd() });
const headlessOn = (): boolean => true;

const BROWSER_STARTS = [
    String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" http://localhost:3000`,
    "\"/c/Program Files/Google/Chrome/Application/chrome.exe\" --remote-debugging-port=9222 --user-data-dir=/tmp/capture",
    "chrome --remote-debugging-port=9222",
    "& \"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\" --new-window about:blank",
    "google-chrome-stable --app=http://localhost:5173",
    "firefox http://localhost:8080",
    "firefox",
    "firefox about:blank",
    "brave-browser",
    "Start-Process firefox",
    "start brave",
    "Start-Process chrome http://localhost:3000",
    "Start-Process -FilePath \"msedge.exe\" -ArgumentList \"http://localhost:3000\"",
    "cmd /c start chrome http://localhost:3000",
    "cd app && npm run build && chromium --user-data-dir=/tmp/x http://localhost:4173",
    "timeout 30 chrome --remote-debugging-port=9222 http://localhost:3000",
    String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe"`,
];

const URL_OPENS = [
    "start http://localhost:3000",
    "cmd /c start \"\" \"http://localhost:3000/?a=1&b=2\"",
    "Start-Process \"http://localhost:3000\"",
    "Start-Process -WindowStyle Maximized http://localhost:3000",
    "explorer.exe http://localhost:3000",
    "rundll32 url.dll,FileProtocolHandler http://localhost:3000",
    "open http://localhost:3000",
    "xdg-open https://example.invalid/report",
    "open coverage/index.html",
    "start coverage/index.html",
    "python -m webbrowser http://localhost:8000",
    "gh pr view 12 --web",
    "gh browse",
    "powershell -NoProfile -Command \"Start-Process http://localhost:3000\"",
    "pwsh -c Start-Process http://localhost:3000",
    "bash -c \"xdg-open http://localhost:3000\"",
    "cmd /c \"start http://localhost:3000\"",
    "bash -lc \"xdg-open http://localhost:3000\"",
];

const HEADED_TOOLS = [
    "npx playwright test --headed",
    "npx playwright test e2e/login.spec.ts --ui",
    "pnpm exec playwright test --debug",
    "npx playwright show-report",
    "npx playwright codegen http://localhost:3000",
    "PWDEBUG=1 npx playwright test",
    "npx cypress open",
    "npx lighthouse http://localhost:3000 --output json",
    "npx vite --open",
    "npm run dev -- --open",
    "npx storybook dev -p 6006",
    "npx vitest --ui",
    "ng serve -o",
];

test("refuses a browser started with a window", () => {
    for (const command of BROWSER_STARTS) expect(visibleBrowserReason(command), command).not.toBe("");
});

test("refuses a URL handed to the default browser", () => {
    for (const command of URL_OPENS) expect(visibleBrowserReason(command), command).not.toBe("");
});

test("refuses headed test runs, viewers and visible launchers", () => {
    for (const command of HEADED_TOOLS) expect(visibleBrowserReason(command), command).not.toBe("");
});

// The hook only runs for a command one of its `if` filters matches, so every refused shape has
// to be reachable through one of them, or the refusal never happens in a real session.
test("every refused command is reachable through an if filter", () => {
    const globs = COMMAND_PATTERNS.map((p) => new RegExp(`^${p.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`));
    for (const command of [...BROWSER_STARTS, ...URL_OPENS, ...HEADED_TOOLS]) expect(globs.some((g) => g.test(command)), command).toBe(true);
});

test("lets through headless launches and commands that only name a browser", () => {
    for (const command of [
        String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --screenshot=out.png http://localhost:3000`,
        "chromium --headless --dump-dom http://localhost:4173",
        "firefox -headless --screenshot http://localhost:8080",
        "taskkill /IM chrome.exe /F",
        "Get-Process chrome, msedge | Select-Object Id",
        "Stop-Process -Name chrome",
        "tasklist | grep -i chrome",
        "ls \"/c/Program Files/Google/Chrome/Application/chrome.exe\"",
        "grep -rn \"chrome.exe\" src",
        "curl -s http://localhost:3000/health",
        "npx playwright test",
        "npx playwright install chromium",
        "npx playwright screenshot http://localhost:3000 out.png",
        "npx lighthouse http://localhost:3000 --chrome-flags=\"--headless=new\" --output json",
        "npx storybook dev -p 6006 --ci",
        "npx vitest --ui --open=false",
        "npm start",
        "Start-Process -WindowStyle Hidden -FilePath node -ArgumentList server.js",
        "start /b node server.js",
        "explorer .",
        "open README.md",
        "gh browse --no-browser",
        "gh pr view 12",
        "echo \"open http://localhost:3000 in your browser\"",
        "git commit -m \"docs: start http://localhost:3000 to preview\"",
        "node scripts/shots.mjs",
        "timeout 60 npx playwright test",
        "powershell -NoProfile -Command \"Get-Process chrome\"",
        "bash scripts/open-report.sh",
        "bash -c \"npm run build\"",
        "bash -lc \"npm run build\"",
    ]) expect(visibleBrowserReason(command), command).toBe("");
});

// A version or help probe prints and exits, except Chrome on Windows, which ignores the flag and opens a window.
test("a browser version probe passes except on Windows", () => {
    for (const command of ["google-chrome --version", "chromium --help", "firefox --version"]) {
        expect(visibleBrowserReason(command, "linux"), command).toBe("");
        expect(visibleBrowserReason(command, "win32"), command).not.toBe("");
    }
    expect(visibleBrowserReason("google-chrome --version http://localhost:3000", "linux")).not.toBe("");
});

test("heredoc and here-string bodies are data, not commands", () => {
    expect(visibleBrowserReason("cat > NOTES.md <<'EOF'\nstart http://localhost:3000\nopen http://localhost:3000\nEOF\necho done")).toBe("");
    expect(visibleBrowserReason("Set-Content notes.md @'\nstart http://localhost:3000\n'@")).toBe("");
    expect(visibleBrowserReason("cat > x.md <<'EOF'\nnothing\nEOF\nstart http://localhost:3000")).not.toBe("");
});

test("segments split at separators outside quotes", () => {
    expect(commandSegments("a && b; c | d || e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(commandSegments("echo \"a && b\"; c")).toEqual(["echo \"a && b\"", "c"]);
});

test("the hook denies with exit 2, and allows when headless is off or the payload is unreadable", () => {
    expect(runBrowserGuardHook(payload("start http://localhost:3000"), headlessOn)).toBe(2);
    expect(runBrowserGuardHook(payload("Start-Process http://localhost:3000", "PowerShell"), headlessOn)).toBe(2);
    expect(runBrowserGuardHook(payload("start http://localhost:3000"), () => false)).toBe(0);
    expect(runBrowserGuardHook(payload("npx playwright test"), headlessOn)).toBe(0);
    expect(runBrowserGuardHook("", headlessOn)).toBe(0);
    expect(runBrowserGuardHook(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } }), headlessOn)).toBe(0);
});

test("installs filtered PreToolUse handlers idempotently and removes them", () => {
    const file = join(mkdtempSync(join(tmpdir(), "enigma-browser-guard-")), "settings.json");
    writeFileSync(file, JSON.stringify({ model: "kept" }));
    expect(applyBrowserGuard(file, true)).toBe("changed");
    expect(applyBrowserGuard(file, true)).toBe("unchanged");
    const on = JSON.parse(readFileSync(file, "utf8"));
    expect(on.model).toBe("kept");
    const ours = on.hooks.PreToolUse.find((g: { hooks: Array<{ command: string; }>; }) => g.hooks[0]!.command.includes("__browser-guard"));
    expect(ours.matcher).toBe("Bash|PowerShell");
    expect(ours.hooks).toHaveLength(COMMAND_PATTERNS.length * 2);
    expect(ours.hooks.every((h: { if?: string; }) => /^(?:Bash|PowerShell)\(.+\)$/.test(h.if ?? ""))).toBe(true);
    expect(applyBrowserGuard(file, false)).toBe("changed");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks?.PreToolUse ?? []).toEqual([]);
});
