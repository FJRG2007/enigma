/**
 * The browser guard reaches every agent that can refuse a shell command: Kimi's config.toml
 * `[[hooks]]`, Codex's hooks.json and an OpenCode plugin. Each write is idempotent and leaves the
 * rest of the file alone, and the OpenCode plugin really refuses: it is loaded and called here
 * with a stand-in `enigma` on PATH that speaks the guard's protocol.
 */
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { applyCodexBrowserGuard, applyKimiBrowserGuard, applyOpencodeBrowserGuard } from "@/browser-guard-deploy";

const DIR = mkdtempSync(join(tmpdir(), "enigma-browser-guard-deploy-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

test("Kimi gets one PreToolUse rule over its shell tools, after the user's own settings", () => {
    const config = join(DIR, "kimi", "config.toml");
    mkdirSync(join(DIR, "kimi"), { recursive: true });
    writeFileSync(config, "default_model = \"k2\"\n\n[[hooks]]\nevent = \"PostToolUse\"\nmatcher = \"Write|Edit\"\ncommand = \"my-own-hook\"\n");
    expect(applyKimiBrowserGuard(config, true)).toBe(true);
    expect(applyKimiBrowserGuard(config, true)).toBe(false);
    const text = readFileSync(config, "utf8");
    expect(text).toContain("default_model = \"k2\"");
    expect(text).toContain("command = \"my-own-hook\"");
    expect(text.match(/__browser-guard/g)?.length).toBe(1);
    expect(text).toContain("event = \"PreToolUse\"\nmatcher = \"^(?:Bash|PowerShell)$\"\ncommand = \"enigma __browser-guard\"\ntimeout = 60\n");
});

test("Codex gets a PreToolUse group in hooks.json and nothing it would reject", () => {
    const hooks = join(DIR, "codex", "hooks.json");
    mkdirSync(join(DIR, "codex"), { recursive: true });
    writeFileSync(hooks, `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }, null, 2)}\n`);
    expect(applyCodexBrowserGuard(hooks, true)).toBe(true);
    expect(applyCodexBrowserGuard(hooks, true)).toBe(false);
    const data = JSON.parse(readFileSync(hooks, "utf8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>>; }>>; };
    // Codex rejects unknown top-level keys, so `hooks` stays the only one.
    expect(Object.keys(data)).toEqual(["hooks"]);
    expect(data.hooks.Stop?.[0]?.hooks[0]?.command).toBe("mine");
    expect(data.hooks.PreToolUse).toEqual([{ matcher: "^Bash$", hooks: [{ type: "command", command: "enigma __browser-guard", timeout: 60 }] }]);
});

test("the OpenCode plugin hands each shell command to the guard and throws its refusal", async () => {
    const config = join(DIR, "opencode");
    expect(applyOpencodeBrowserGuard(config, true)).toBe(true);
    expect(applyOpencodeBrowserGuard(config, true)).toBe(false);

    // A stand-in guard: refuses (exit 2, reason on stderr) any payload naming a URL.
    const bin = join(DIR, "bin");
    mkdirSync(bin, { recursive: true });
    if (process.platform === "win32") {
        writeFileSync(join(bin, "enigma.cmd"), "@echo off\r\nfindstr /c:\"http\" >nul && (echo refused by stand-in 1>&2 & exit /b 2)\r\nexit /b 0\r\n");
    } else {
        writeFileSync(join(bin, "enigma"), "#!/bin/sh\nif grep -q http; then echo 'refused by stand-in' >&2; exit 2; fi\nexit 0\n");
        chmodSync(join(bin, "enigma"), 0o755);
    }
    // The plugin runs in its own process, as it would inside OpenCode, with the stand-in first on PATH.
    const driver = join(DIR, "driver.mjs");
    writeFileSync(driver, [
        `const { EnigmaBrowserGuard } = await import(${JSON.stringify(pathToFileURL(join(config, "plugins", "enigma-browser-guard.js")).href)});`,
        "const before = (await EnigmaBrowserGuard())[\"tool.execute.before\"];",
        "const outcome = async (input, args) => { try { await before(input, { args }); return \"ran\"; } catch (e) { return e.message; } };",
        "console.log(JSON.stringify([await outcome({ tool: \"bash\" }, { command: \"start http://localhost:3000\" }), await outcome({ tool: \"bash\" }, { command: \"npm test\" }), await outcome({ tool: \"read\" }, { filePath: \"http.txt\" })]));",
    ].join("\n"));
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== "PATH") env[k] = v;
    env.PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
    const result = spawnSync(process.execPath, [driver], { env, encoding: "utf8", windowsHide: true, timeout: 30000 });
    expect(JSON.parse(result.stdout.trim())).toEqual(["refused by stand-in", "ran", "ran"]);

    expect(applyOpencodeBrowserGuard(config, false)).toBe(true);
    expect(applyOpencodeBrowserGuard(config, false)).toBe(false);
});
