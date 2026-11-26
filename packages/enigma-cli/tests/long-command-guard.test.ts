/**
 * The long-command guard refuses a Bash command that Claude Code's Windows Bash tool would cut
 * near 8,000 characters, and nothing else: other platforms, other agents, the PowerShell tool
 * and commands under the limit all pass.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { LONG_COMMAND_LIMIT, effectiveLength, longCommandReason } from "@/long-command-guard";

const claude = { CLAUDECODE: "1" } as NodeJS.ProcessEnv;
const heredoc = (bodyChars: number, line = "x".repeat(79)): string => {
    const lines = Array.from({ length: Math.ceil(bodyChars / (line.length + 1)) }, () => line);
    return `cat > /tmp/patch.py <<'EOF'\n${lines.join("\n")}\nEOF\npython /tmp/patch.py`;
};

test("counts each single quote as the four characters the harness turns it into", () => {
    expect(effectiveLength("abc")).toBe(3);
    expect(effectiveLength("'a'")).toBe(9);
});

test("refuses a long heredoc from Claude Code's Bash tool on Windows and names the way out", () => {
    const reason = longCommandReason(heredoc(9000), "Bash", "win32", claude);
    expect(reason).toContain("Write tool");
    expect(reason).toContain(String(effectiveLength(heredoc(9000))));
});

test("judges the escaped length, so a quote-heavy command under the raw limit is refused", () => {
    const quoted = heredoc(6000, `s=s.replace('''a''','''b''')${"y".repeat(40)}`);
    expect(quoted.length).toBeLessThan(LONG_COMMAND_LIMIT);
    expect(longCommandReason(quoted, "Bash", "win32", claude)).not.toBe("");
});

test("lets through what fits, and every case the measurement does not cover", () => {
    expect(longCommandReason(heredoc(5000), "Bash", "win32", claude)).toBe("");
    expect(longCommandReason(heredoc(9000), "Bash", "linux", claude)).toBe("");
    expect(longCommandReason(heredoc(9000), "Bash", "darwin", claude)).toBe("");
    expect(longCommandReason(heredoc(9000), "PowerShell", "win32", claude)).toBe("");
    expect(longCommandReason(heredoc(9000), "Bash", "win32", {} as NodeJS.ProcessEnv)).toBe("");
});

// Both ways `enigma __browser-guard` is answered: the binary's CLI, and the npm launcher's Node
// fast path over dist/browser-guard.js, which is what Claude Code's hook actually reaches.
const ENTRIES: Array<{ name: string; argv: string[]; needs?: string; }> = [
    { name: "the CLI", argv: [process.execPath, join(import.meta.dir, "..", "src", "bin", "enigma.ts")] },
    { name: "the launcher fast path", argv: ["node", join(import.meta.dir, "..", "bin", "enigma.mjs")], needs: join(import.meta.dir, "..", "dist", "browser-guard.js") },
];

for (const entry of ENTRIES) {
    test.skipIf(Boolean(entry.needs) && !existsSync(entry.needs!))(`${entry.name} refuses a long command with exit 2`, () => {
        const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: heredoc(9000) }, cwd: process.cwd() });
        const run = (env: NodeJS.ProcessEnv) => spawnSync(entry.argv[0]!, [...entry.argv.slice(1), "__browser-guard"], { input, encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true });
        const refused = run({ CLAUDECODE: "1" });
        if (process.platform === "win32") {
            expect(refused.status).toBe(2);
            expect(refused.stderr).toContain("Write tool");
        } else expect(refused.status).toBe(0);
        expect(run({ CLAUDECODE: "" }).status).toBe(0);
    });
}
