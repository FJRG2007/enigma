/**
 * Make a directory persistently discoverable on the user's PATH so a bare command
 * inside it (e.g. `claude`) runs in any new terminal - the other half of fixing the
 * "claude is not recognized" bug (persisting the path in enigma's config only fixes
 * `enigma <tool>`, not the bare shell command).
 *
 * User scope only, no admin: on Windows it edits the per-user PATH in the registry
 * via PowerShell's [Environment]::SetEnvironmentVariable (which preserves the value
 * type and broadcasts the change); on POSIX it appends a marked line to the shell
 * profile. Idempotent and best-effort - a failure is reported, never thrown, so the
 * config-level fix still stands. Changes apply to NEW terminals, not the current one.
 */

import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";

/** Outcome of trying to put a directory on the persistent user PATH. */
export interface PathResult {
    /** A persistent PATH entry was newly written this call. */
    changed: boolean;
    /** Where the entry lives (the registry scope, or the profile file path). */
    where: string;
    /** Human-readable status (already present / added / manual fallback). */
    note: string;
}

/** Normalize a directory for PATH comparison (drop trailing separators; lowercase on Windows). */
function normalizeDir(dir: string): string {
    const r = resolve(dir);
    return process.platform === "win32" ? r.replace(/[\\/]+$/, "").toLowerCase() : r.replace(/\/+$/, "");
}

/** True when `dir` is already on the CURRENT process PATH. */
export function isDirOnPath(dir: string): boolean {
    const sepChar = process.platform === "win32" ? ";" : ":";
    const target = normalizeDir(dir);
    const entries = (process.env.PATH || process.env.Path || "").split(sepChar).filter(Boolean).map(normalizeDir);
    return entries.includes(target);
}

/** Append `dir` to the per-user PATH in the Windows registry (no admin). */
function addToWindowsUserPath(dir: string): PathResult {
    // The directory is passed via env (not interpolated into the script) so a path
    // with spaces or quotes cannot break or inject into the PowerShell command.
    const script = "$d=$env:ENIGMA_PATH_ADD; $c=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $c){$c=''}; $p=@($c -split ';' | Where-Object {$_ -ne ''}); if($p -notcontains $d){$n=if($c.TrimEnd(';')){$c.TrimEnd(';')+';'+$d}else{$d}; [Environment]::SetEnvironmentVariable('Path',$n,'User'); 'added'}else{'present'}";
    try {
        const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
            env: { ...process.env, ENIGMA_PATH_ADD: dir },
            encoding: "utf8",
            timeout: 15000,
            windowsHide: true,
        }).trim();
        if (out.endsWith("added")) return { changed: true, where: "user PATH (registry)", note: `Added ${dir} to your user PATH.` };
        return { changed: false, where: "user PATH (registry)", note: `${dir} is already on your user PATH.` };
    } catch {
        return { changed: false, where: "user PATH (registry)", note: `Could not update PATH automatically; add ${dir} to your PATH manually.` };
    }
}

/** The shell profile file to edit, chosen from $SHELL (falls back to ~/.profile). */
function unixProfile(): string {
    const home = homedir();
    const shell = process.env.SHELL || "";
    if (shell.includes("zsh")) return join(home, ".zshrc");
    if (shell.includes("bash")) return join(home, ".bashrc");
    if (shell.includes("fish")) return join(home, ".config", "fish", "config.fish");
    return join(home, ".profile");
}

/** Append a PATH line for `dir` to the user's shell profile (idempotent by dir match). */
function addToUnixProfile(dir: string): PathResult {
    const file = unixProfile();
    let content = "";
    try { content = readFileSync(file, "utf8"); } catch { /* file may not exist yet */ }
    if (content.includes(dir)) return { changed: false, where: file, note: `${dir} is already in ${file}.` };
    const isFish = file.endsWith("config.fish");
    const line = isFish ? `fish_add_path '${dir}'` : `export PATH="$PATH:${dir}"`;
    const block = `\n# Added by enigma fix-path so the tool's command is on PATH\n${line}\n`;
    try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, block);
        return { changed: true, where: file, note: `Added ${dir} to ${file}.` };
    } catch {
        return { changed: false, where: file, note: `Could not edit ${file}; add ${dir} to your PATH manually.` };
    }
}

/**
 * Ensure `dir` is on the persistent user PATH. No-op (reported as unchanged) when it
 * is already on the current PATH; otherwise persists it for new terminals. Honors the
 * test/escape hatch ENIGMA_NO_PATH_EDIT=1, which skips the system write entirely.
 */
export function addDirToUserPath(dir: string): PathResult {
    if (process.env.ENIGMA_NO_PATH_EDIT === "1") {
        return { changed: false, where: "(skipped)", note: `PATH edit skipped (ENIGMA_NO_PATH_EDIT); add ${dir} to your PATH manually.` };
    }
    if (isDirOnPath(dir)) return { changed: false, where: "PATH", note: `${dir} is already on your PATH.` };
    return process.platform === "win32" ? addToWindowsUserPath(dir) : addToUnixProfile(dir);
}
