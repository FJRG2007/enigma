/**
 * `shell: true` spawns join their arguments with plain spaces, so a path under a Windows profile
 * with a space (`C:\Users\Jane Doe\...`) reached npm as two arguments and `enigma update` from a
 * release tarball failed. shellArgs quotes each one for cmd.exe.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { quoteWinArg, shellArgs } from "@/util";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";

test("quotes only what cmd.exe would split or interpret", () => {
    expect(quoteWinArg("enigma-cli@latest")).toBe("enigma-cli@latest");
    expect(quoteWinArg("C:\\Users\\Jane Doe\\a.tgz")).toBe("\"C:\\Users\\Jane Doe\\a.tgz\"");
    expect(quoteWinArg("a&b")).toBe("\"a&b\"");
    expect(quoteWinArg("")).toBe("\"\"");
    expect(quoteWinArg("say \"hi\"")).toBe("\"say \"\"hi\"\"\"");
});

test("a path with a space reaches the program as one argument through the shell", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "enigma-shellargs-")), "Jane Doe");
    mkdirSync(dir, { recursive: true });
    const script = join(dir, "argv.js");
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const tarball = join(dir, "enigma-cli-1.0.0.tgz");
    const result = spawnSync("node", shellArgs([script, "i", "-g", tarball]), { shell: process.platform === "win32", encoding: "utf8", windowsHide: true });
    expect(JSON.parse(result.stdout.trim())).toEqual(["i", "-g", tarball]);
});
