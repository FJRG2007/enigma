/**
 * System-resource parsers: the pure output-parsing of tasklist/ps/netstat/lsof, the probes
 * behind the leftover sweep, and the `enigma kill` target grammar - the part of resources.ts
 * that can be tested without spawning processes or killing anything. The destructive actions
 * (killPid/killPids/freePort/killByName/shutdownWsl/quitDocker/reapAgentLeftovers) are
 * verified by the user.
 *
 * `isStatuslineCommand` and `isWholeMachineSearch` each earn their own case list, because they
 * are the only thing standing between the sweep and somebody's real process: what they match
 * gets force-killed, so a false positive costs work and a miss only costs one orphan.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import * as res from "../src/resources";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";

test("parseTasklist reads name/pid/mem from CSV (commas in mem stripped)", () => {
    const out = '"chrome.exe","1234","Console","1","523,480 K"\r\n"vmmemWSL","9001","Services","0","2,100,000 K"\r\n';
    const procs = res.parseTasklist(out);
    expect(procs).toHaveLength(2);
    expect(procs[0]).toEqual({ name: "chrome.exe", pid: 1234, memKB: 523480 });
    expect(procs[1]).toEqual({ name: "vmmemWSL", pid: 9001, memKB: 2100000 });
});

test("parsePs reads pid/rss/comm", () => {
    const procs = res.parsePs("  1234   523480 /usr/lib/firefox/firefox\n  42 100 node\n");
    expect(procs[0]).toEqual({ pid: 1234, memKB: 523480, name: "firefox" });
    expect(procs[1]).toEqual({ pid: 42, memKB: 100, name: "node" });
});

test("parseNetstat keeps only LISTENING TCP rows and dedupes", () => {
    const out = [
        "  Proto  Local Address          Foreign Address        State           PID",
        "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234",
        "  TCP    127.0.0.1:5432         0.0.0.0:0              LISTENING       9999",
        "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234",
        "  TCP    10.0.0.1:54321         93.184.216.34:443     ESTABLISHED     5555",
        "  UDP    0.0.0.0:53             *:*                                    7777",
    ].join("\r\n");
    const ports = res.parseNetstat(out);
    expect(ports).toHaveLength(2);
    expect(ports.find((p) => p.port === 3000)).toEqual({ proto: "tcp", port: 3000, pid: 1234, name: "" });
    expect(ports.find((p) => p.port === 5432)?.pid).toBe(9999);
});

test("parseLsof reads command/pid/port from LISTEN rows", () => {
    const out = [
        "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
        "node    1234 me     20u  IPv4  0x12      0t0  TCP *:3000 (LISTEN)",
        "postgres 999 me      7u  IPv6  0x34      0t0  TCP [::1]:5432 (LISTEN)",
    ].join("\n");
    const ports = res.parseLsof(out);
    expect(ports.find((p) => p.port === 3000)).toEqual({ proto: "tcp", port: 3000, pid: 1234, name: "node" });
    expect(ports.find((p) => p.port === 5432)?.name).toBe("postgres");
});

test("a plain number is a port, because that is what 'enigma kill 3000' means", () => {
    expect(res.parseKillTarget("3000")).toEqual({ kind: "port", port: 3000, bare: true });
    // Above the port range it can only be a PID, so no reading is being guessed at.
    expect(res.parseKillTarget("74210")).toEqual({ kind: "pid", pid: 74210 });
});

test("the explicit forms are never read as anything else", () => {
    expect(res.parseKillTarget(":3000")).toEqual({ kind: "port", port: 3000, bare: false });
    expect(res.parseKillTarget("port:3000")).toEqual({ kind: "port", port: 3000, bare: false });
    expect(res.parseKillTarget("port 3000")).toEqual({ kind: "port", port: 3000, bare: false });
    expect(res.parseKillTarget("pid:1234")).toEqual({ kind: "pid", pid: 1234 });
    expect(res.parseKillTarget("pid 1234")).toEqual({ kind: "pid", pid: 1234 });
});

test("the two Windows pain points answer to their own names", () => {
    for (const word of ["wsl", "WSL", "vmmem", "vmmemWSL"]) expect(res.parseKillTarget(word), word).toEqual({ kind: "wsl" });
    for (const word of ["docker", "Docker", "docker-desktop", "Docker Desktop"]) expect(res.parseKillTarget(word), word).toEqual({ kind: "docker" });
});

test("anything else is a process name, keeping its original casing", () => {
    expect(res.parseKillTarget("app.exe")).toEqual({ kind: "name", name: "app.exe" });
    expect(res.parseKillTarget("  Node  ")).toEqual({ kind: "name", name: "Node" });
    expect(res.parseKillTarget("   ")).toBeNull();
});

test("system processes are refused by name, with or without .exe", () => {
    // The protected list is per-platform (killing `dwm` is fatal on Windows and ordinary on
    // Linux), so the test asks about the platform it is running on.
    const critical = process.platform === "win32"
        ? ["System", "lsass.exe", "csrss", "svchost.exe", "Memory Compression"]
        : ["init", "systemd", "systemd-journald", "launchd", "kernel_task"];
    for (const name of critical) expect(res.isProtectedProcess(name), name).toBe(true);
    for (const name of ["node", "app.exe", "Docker Desktop.exe", "chrome.exe"]) {
        expect(res.isProtectedProcess(name), name).toBe(false);
    }
});

test("the kill refusal covers system processes, enigma itself and its shell", () => {
    const system = process.platform === "win32" ? "svchost.exe" : "systemd";
    expect(res.killRefusalReason(4, system)).toContain("system process");
    expect(res.killRefusalReason(process.pid, "bun")).toBe("enigma itself");
    expect(res.killRefusalReason(process.ppid, "bash")).toBe("the shell enigma runs in");
    expect(res.killRefusalReason(999999, "node")).toBeNull();
});

test("a by-name kill past the bulk limit needs --yes, a small one never does", () => {
    expect(res.isBulkKill(res.KILL_BY_NAME_BULK_LIMIT)).toBe(false);
    expect(res.isBulkKill(res.KILL_BY_NAME_BULK_LIMIT + 1)).toBe(true);
    expect(res.isBulkKill(res.KILL_BY_NAME_BULK_LIMIT + 1, true)).toBe(false);
    expect(res.isBulkKill(1)).toBe(false);
});

test("parseKillTarget reads the leftover sweep and its narrower spelling", () => {
    expect(res.parseKillTarget("leftovers")).toEqual({ kind: "leftovers" });
    expect(res.parseKillTarget("leftover")).toEqual({ kind: "leftovers" });
    expect(res.parseKillTarget("statusline")).toEqual({ kind: "leftovers", family: "statusline" });
    expect(res.parseKillTarget("statuslines")).toEqual({ kind: "leftovers", family: "statusline" });
    expect(res.parseKillTarget("status-line")).toEqual({ kind: "leftovers", family: "statusline" });
    // Still a process name, so `enigma kill statusline-daemon` is not silently a sweep.
    expect(res.parseKillTarget("statusline-daemon")).toEqual({ kind: "name", name: "statusline-daemon" });
});

test("isStatuslineCommand matches enigma's own renders and nothing that merely says the word", () => {
    // The three shapes a render is actually spawned as.
    expect(res.isStatuslineCommand(String.raw`C:\nvm4w\nodejs\node.exe C:\nvm4w\nodejs/node_modules/enigma-cli/bin/enigma.mjs statusline`)).toBe(true);
    expect(res.isStatuslineCommand("enigma statusline")).toBe(true);
    expect(res.isStatuslineCommand(String.raw`"C:\Users\me\.enigma\bin\1.54.3\enigma-bin.exe" statusline`)).toBe(true);
    // The janitor itself, so one that gets stuck is swept by the next one.
    expect(res.isStatuslineCommand(String.raw`node C:\npm\enigma-cli\dist\leftovers.js`)).toBe(true);
    // The probe's OWN command line says "statusline" and must never be a candidate.
    expect(res.isStatuslineCommand("powershell -NoProfile -Command Get-CimInstance Win32_Process -Filter 'CommandLine LIKE ''%statusline%'''")).toBe(false);
    expect(res.isStatuslineCommand("node build.js --watch src/statusline.mjs")).toBe(false);
    expect(res.isStatuslineCommand("enigma statusline-refresh 10")).toBe(false);
    expect(res.isStatuslineCommand("enigma gate axi run")).toBe(false);
});

test("parseWinProcs reads pid/age/command, command lines with pipes included", () => {
    const out = "1234|9876|node.exe C:/n/enigma.mjs statusline\r\n42|3|enigma statusline\r\nheader row\r\n";
    const procs = res.parseWinProcs(out);
    expect(procs).toHaveLength(2);
    expect(procs[0]).toEqual({ pid: 1234, ageSec: 9876, command: "node.exe C:/n/enigma.mjs statusline" });
    expect(procs[1]!.ageSec).toBe(3);
});

test("parseElapsed reads every shape ps prints, and rejects the rest", () => {
    expect(res.parseElapsed("00:07")).toBe(7);
    expect(res.parseElapsed("02:30")).toBe(150);
    expect(res.parseElapsed("01:02:03")).toBe(3723);
    expect(res.parseElapsed("2-01:02:03")).toBe(176523);
    expect(res.parseElapsed("ELAPSED")).toBe(-1);
});

test("parsePsProcs keeps the whole command line and converts the elapsed column", () => {
    const out = "  911 04:10 node /usr/lib/node_modules/enigma-cli/bin/enigma.mjs statusline\n  912 ELAPSED node x\n";
    const procs = res.parsePsProcs(out);
    expect(procs).toHaveLength(1);
    expect(procs[0]).toEqual({ pid: 911, ageSec: 250, command: "node /usr/lib/node_modules/enigma-cli/bin/enigma.mjs statusline" });
});

test("selectLeftovers takes only a known family, only past ITS age, and never itself", () => {
    const procs = [
        { pid: 1, ageSec: res.STATUSLINE_ORPHAN_MIN_AGE_SEC, command: "enigma statusline" },
        { pid: 2, ageSec: res.STATUSLINE_ORPHAN_MIN_AGE_SEC - 1, command: "enigma statusline" }, // a live render
        { pid: 3, ageSec: 99999, command: "node watch.js src/statusline.mjs" },                  // not ours
        { pid: 4, ageSec: res.WHOLE_MACHINE_SEARCH_MIN_AGE_SEC, command: "find / -name run.md" },
        // A whole-disk search gets a longer rope than a status bar: the ones people start
        // deliberately are slow, not abandoned.
        { pid: 5, ageSec: res.STATUSLINE_ORPHAN_MIN_AGE_SEC, command: "find / -name run.md" },
        { pid: process.pid, ageSec: 99999, command: "enigma statusline" },                       // the sweeper
    ];
    const hits = res.selectLeftovers(procs);
    expect(hits.map((p) => p.pid)).toEqual([1, 4]);
    expect(hits.map((p) => p.kind.label)).toEqual(["status bar", "whole-machine search"]);
});

test("isWholeMachineSearch takes a search rooted at the machine, never a scoped one", () => {
    // Every root spelling a session here can produce: POSIX, home, Git Bash and WSL drive
    // mounts, the native Windows one, and the directory that holds every user's home.
    for (const cmd of [
        "find / -name run.md",
        "find / -type f -name maplibre-gl/package.json",
        "find -L / -name x",
        "find ~ -name .npmrc",
        "find $HOME/ -name x",
        "find /c/ -name x",
        "find /mnt/c -name x",
        "find /Users -name x",
        "find /home -name x",
        "C:\\Program Files\\Git\\usr\\bin\\find.exe C:\\ -name x",
    ]) expect(res.isWholeMachineSearch(cmd), cmd).toBe(true);

    // A scoped search is the thing this must never touch - the root has to be the WHOLE
    // argument, so a path that merely starts at one is not a match.
    for (const cmd of [
        "find . -name x",
        "find src -name x",
        "find /c/Users/me/project -name x",
        "find ~/dev/app -name x",
        "find node_modules -maxdepth 2",
        "rg --files -g run.md",
        "npm run find",
    ]) expect(res.isWholeMachineSearch(cmd), cmd).toBe(false);
});

// Command lines as the Windows probe reported them on the machine the rule was written on: the
// Chrome DevTools MCP server's isolated browser, an `enigma design` browser, one of their child
// processes, and the user's own Chrome.
const MCP_BROWSER = String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --allow-pre-commit-input --disable-background-networking --headless --remote-debugging-pipe --user-data-dir=C:\Users\me\AppData\Local\Temp\puppeteer_dev_chrome_profile-oEi2DK about:blank`;
const DESIGN_BROWSER = String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=0 --user-data-dir=C:\Users\me\AppData\Local\Temp\enigma-design-LDw2kL --no-first-run about:blank`;
const MCP_RENDERER = String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --type=renderer --user-data-dir=C:\Users\me\AppData\Local\Temp\puppeteer_dev_chrome_profile-oEi2DK --lang=en-US`;
const USER_CHROME = String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --profile-directory=Default --flag-switches-begin --flag-switches-end`;

test("isAutomationBrowser takes only the main process of an automation profile, never the user's Chrome", () => {
    expect(res.isAutomationBrowser(MCP_BROWSER)).toBe(true);
    expect(res.isAutomationBrowser(DESIGN_BROWSER)).toBe(true);
    expect(res.isAutomationBrowser("/usr/bin/chromium --headless --user-data-dir=/tmp/puppeteer_dev_chrome_profile-abc123 about:blank")).toBe(true);
    expect(res.isAutomationBrowser(MCP_RENDERER)).toBe(false);
    expect(res.isAutomationBrowser(USER_CHROME)).toBe(false);
    expect(res.isAutomationBrowser(String.raw`"C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir=C:\Users\me\work-profile`)).toBe(false);
    // A process merely mentioning the profile (an editor, a grep) is not a browser.
    expect(res.isAutomationBrowser("grep -r puppeteer_dev_chrome_profile- /tmp")).toBe(false);
    expect(res.automationProfileDir(MCP_BROWSER)).toBe("C:\\Users\\me\\AppData\\Local\\Temp\\puppeteer_dev_chrome_profile-oEi2DK");
});

// Playwright's own launch (a script an agent wrote) runs on its temp profile, and a script that
// crashed or forgot `browser.close()` leaves it running exactly like the MCP server's.
test("a browser on Playwright's temp profile is an automation browser too", () => {
    const pw = String.raw`"C:\Users\me\AppData\Local\ms-playwright\chromium-1200\chrome-win\chrome.exe" --no-first-run --user-data-dir=C:\Users\me\AppData\Local\Temp\playwright_chromiumdev_profile-AbC123 --remote-debugging-pipe about:blank`;
    expect(res.isAutomationBrowser(pw)).toBe(true);
    expect(res.automationProfileDir(pw)).toBe("C:\\Users\\me\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-AbC123");
    const root = mkdtempSync(join(tmpdir(), "enigma-res-pw-"));
    const profile = join(root, "playwright_chromiumdev_profile-AbC123");
    mkdirSync(profile);
    expect(res.removeTempProfile(profile, root)).toBe(true);
});

test("an automation browser is reaped only past its age", () => {
    const young = res.selectLeftovers([{ pid: 4_000_001, ageSec: res.AUTOMATION_BROWSER_MIN_AGE_SEC - 1, command: MCP_BROWSER }]);
    const old = res.selectLeftovers([{ pid: 4_000_002, ageSec: res.AUTOMATION_BROWSER_MIN_AGE_SEC, command: MCP_BROWSER }]);
    expect(young).toHaveLength(0);
    expect(old.map((p) => p.kind.label)).toEqual(["idle automation browser"]);
});

test("removeTempProfile deletes only an automation profile directly under the temp dir", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-res-test-"));
    const profile = join(root, "puppeteer_dev_chrome_profile-xyz");
    const nested = join(root, "keep", "puppeteer_dev_chrome_profile-abc");
    const other = join(root, "my-profile");
    for (const d of [profile, nested, other]) mkdirSync(d, { recursive: true });
    expect(res.removeTempProfile(profile, root)).toBe(true);
    expect(existsSync(profile)).toBe(false);
    expect(res.removeTempProfile(nested, root)).toBe(false);
    expect(res.removeTempProfile(other, root)).toBe(false);
    expect(existsSync(nested) && existsSync(other)).toBe(true);
});

test("sweepStaleProfiles removes old, unreferenced automation profiles only", () => {
    const root = mkdtempSync(join(tmpdir(), "enigma-res-test-"));
    const now = Date.now() + res.AUTOMATION_BROWSER_MIN_AGE_SEC * 1000 + 60_000;
    const stale = join(root, "puppeteer_dev_chrome_profile-old111");
    const live = join(root, "puppeteer_dev_chrome_profile-live22");
    const unrelated = join(root, "some-other-dir");
    for (const d of [stale, live, unrelated]) mkdirSync(d);
    const removed = res.sweepStaleProfiles([`chrome.exe --user-data-dir=${live}`], root, now);
    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live) && existsSync(unrelated)).toBe(true);
    // A fresh profile is left alone: its browser may still be starting.
    const fresh = join(root, "enigma-design-fresh1");
    mkdirSync(fresh);
    expect(res.sweepStaleProfiles([], root, Date.now())).toBe(0);
    expect(existsSync(fresh)).toBe(true);
});
