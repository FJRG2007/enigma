/**
 * Shell completion: the scripts are generated from the live command and setting lists,
 * so the test that matters is that they cannot drift. Every subcommand the completion
 * offers is checked against the command's own help text - a subcommand renamed in the
 * CLI and forgotten here would otherwise keep completing to a word the CLI rejects.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

const { completionScript, detectShell, COMPLETION_SHELLS, SUBCOMMANDS } = await import("../src/completion");
const { ALL_SETTINGS } = await import("../src/settings-registry");

const CLI_SOURCE = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8");
const COMMANDS = ["account", "compress", "config", "install", "skills", "version"];

test("a script is produced for every supported shell", () => {
    for (const shell of COMPLETION_SHELLS) {
        const script = completionScript(shell, COMMANDS);
        expect(script.length, shell).toBeGreaterThan(200);
        expect(script, shell).toContain("enigma");
        expect(script.endsWith("\n"), shell).toBe(true);
    }
});

test("every command and config key reaches the script", () => {
    for (const shell of COMPLETION_SHELLS) {
        const script = completionScript(shell, COMMANDS);
        for (const command of COMMANDS) expect(script, `${shell}/${command}`).toContain(command);
        for (const setting of ALL_SETTINGS) expect(script, `${shell}/${setting.key}`).toContain(setting.key);
    }
});

test("every completed subcommand is documented by that command's help", () => {
    // COMMAND_HELP entries are template literals in cli.ts; the help text for a command
    // is everything from its `usage: enigma <cmd>` line to the next one.
    for (const [command, subs] of Object.entries(SUBCOMMANDS)) {
        const start = CLI_SOURCE.indexOf(`usage: enigma ${command}`);
        expect(start, `${command} has no COMMAND_HELP entry`).toBeGreaterThan(-1);
        const rest = CLI_SOURCE.slice(start + 1);
        const end = rest.indexOf("usage: enigma ");
        const help = end === -1 ? rest : rest.slice(0, end);
        for (const sub of subs) {
            expect(help, `enigma ${command} ${sub} is completed but not documented`).toContain(sub);
        }
    }
});

test("every command with subcommands is a real command", () => {
    for (const command of Object.keys(SUBCOMMANDS)) {
        expect(CLI_SOURCE, command).toContain(`"${command}"`);
    }
});

test("detectShell reads the environment and always names a supported shell", () => {
    const before = { shell: process.env.SHELL, ps: process.env.PSModulePath };
    try {
        process.env.SHELL = "/usr/bin/zsh";
        expect(detectShell()).toBe("zsh");
        process.env.SHELL = "/opt/homebrew/bin/fish";
        expect(detectShell()).toBe("fish");
        process.env.SHELL = "/bin/bash";
        expect(detectShell()).toBe("bash");
        delete process.env.SHELL;
        expect(COMPLETION_SHELLS).toContain(detectShell());
    } finally {
        if (before.shell === undefined) delete process.env.SHELL; else process.env.SHELL = before.shell;
        if (before.ps === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = before.ps;
    }
});

test("word lists are deduplicated and sorted", () => {
    const script = completionScript("bash", ["zebra", "alpha", "alpha", "middle"]);
    expect(script).toContain('compgen -W "alpha middle zebra"');
});
