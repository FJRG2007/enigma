/**
 * `enigma design`: argument parsing, the interactive prompts, progress output and the
 * final summary. Every flag is validated before anything runs; a usage error exits 2.
 */

import { AGENTS } from "@/agents";
import * as p from "@clack/prompts";
import { isCloneableUrl } from "./modes";
import { relative, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { runDesign, type DesignOptions, type DesignResult, type Reporter, type SourceKind } from "./run";

interface ParsedArgs {
    options: DesignOptions | null;
    error: string | null;
}

const MAX_SCREENS = 20;

function isHttpUrl(value: string): boolean {
    try {
        const u = new URL(value);
        return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
    } catch { return false; }
}

/** A bare positional as a source: a git URL, an http(s) URL, or an existing directory. */
function detectSource(value: string): SourceKind | null {
    if (/\.git$/i.test(value) || /^git@|^ssh:\/\/|^git:\/\//i.test(value) || /^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/]+\/?$/i.test(value)) return "repo";
    if (isHttpUrl(value)) return "url";
    if (existsSync(value) && statSync(value).isDirectory()) return "dir";
    return null;
}

function validateSource(kind: SourceKind, target: string): string | null {
    if (kind === "url" && !isHttpUrl(target)) return `--url needs an http(s) URL, got '${target}'`;
    if (kind === "repo" && !isCloneableUrl(target)) return `--repo needs a git URL (https://, ssh://, git@host:path), got '${target}'`;
    if (kind === "dir" && !(existsSync(target) && statSync(target).isDirectory())) return `--dir: no such directory '${target}'`;
    return null;
}

export function parseDesignArgs(argv: string[]): ParsedArgs {
    const opts: DesignOptions = {
        source: "url", target: "", out: ".", format: "both", ultra: false, screens: 5, browser: null,
        install: "global", agents: [], fonts: true, siteFonts: false, force: false,
    };
    const sources: Array<[SourceKind, string]> = [];
    let error: string | null = null;
    for (let i = 0; i < argv.length && !error; i++) {
        const a = argv[i]!;
        const value = (): string => {
            const v = argv[++i];
            if (v === undefined || v.startsWith("-")) { error = `missing value for ${a}`; return ""; }
            return v;
        };
        switch (a) {
            case "--url": sources.push(["url", value()]); break;
            case "--dir": sources.push(["dir", value()]); break;
            case "--repo": sources.push(["repo", value()]); break;
            case "--out": case "-o": opts.out = value(); break;
            case "--name": opts.name = value().trim() || undefined; break;
            case "--format": {
                const f = value();
                if (f === "both" || f === "skill" || f === "design-md") opts.format = f;
                else if (!error) error = `--format must be both, skill or design-md, got '${f}'`;
                break;
            }
            case "--no-skill": opts.format = "design-md"; break;
            case "--ultra": opts.ultra = true; break;
            case "--mode": {
                const m = value();
                if (m === "ultra" || m === "default") opts.ultra = m === "ultra";
                else if (!error) error = `--mode must be default or ultra, got '${m}'`;
                break;
            }
            case "--screens": {
                const raw = value();
                const n = Number(raw);
                if (Number.isInteger(n) && n >= 1 && n <= MAX_SCREENS) opts.screens = n;
                else if (!error) error = `--screens must be a whole number from 1 to ${MAX_SCREENS}, got '${raw}'`;
                break;
            }
            case "--browser": opts.browser = value(); break;
            case "--no-browser": opts.useBrowser = false; break;
            case "--no-install": opts.install = "none"; break;
            case "-g": case "--global": opts.install = "global"; break;
            case "-l": case "--local": opts.install = "local"; break;
            case "-a": case "--agent": {
                const list = value().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
                const unknown = list.filter((x) => !AGENTS[x]);
                if (unknown.length > 0 && !error) error = `unknown agent '${unknown.join(", ")}' (known: ${Object.keys(AGENTS).join(", ")})`;
                opts.agents.push(...list);
                break;
            }
            case "--no-fonts": opts.fonts = false; break;
            case "--bundle-site-fonts": opts.siteFonts = true; break;
            case "--force": opts.force = true; break;
            default:
                if (a.startsWith("-")) { error = `unknown option ${a}`; break; }
                {
                    const kind = detectSource(a);
                    if (!kind) error = `'${a}' is not a URL, a git URL or an existing directory`;
                    else sources.push([kind, a]);
                }
        }
    }
    if (error) return { options: null, error };
    if (opts.ultra && opts.useBrowser === false) return { options: null, error: "--ultra needs the browser; drop --no-browser" };
    if (sources.length > 1) return { options: null, error: "give one source: a URL, a directory or a git URL" };
    if (sources.length === 1) {
        const [kind, target] = sources[0]!;
        const invalid = validateSource(kind, target);
        if (invalid) return { options: null, error: invalid };
        opts.source = kind;
        opts.target = kind === "url" ? new URL(target).href : target;
    }
    return { options: opts, error: null };
}

async function promptSource(opts: DesignOptions): Promise<boolean> {
    p.intro("enigma design");
    const kind = await p.select({
        message: "What do you want to extract from?",
        options: [
            { value: "url", label: "Website URL", hint: "https://example.com" },
            { value: "dir", label: "Local directory", hint: "./my-app" },
            { value: "repo", label: "Git repository", hint: "https://github.com/org/repo" },
        ],
    });
    if (p.isCancel(kind)) return false;
    const target = await p.text({
        message: kind === "url" ? "Website URL" : kind === "dir" ? "Directory path" : "Repository URL",
        validate: (v) => validateSource(kind as SourceKind, v.trim()) ?? undefined,
    });
    if (p.isCancel(target)) return false;
    let ultra: boolean | symbol = false;
    if (kind === "url") {
        ultra = await p.confirm({ message: "Ultra capture (screenshots, motion, hover states)? Needs Chrome, Edge, Chromium or Brave.", initialValue: false });
        if (p.isCancel(ultra)) return false;
    }
    const out = await p.text({ message: "Output folder", initialValue: opts.out, validate: (v) => (v.trim() ? undefined : "Enter a folder") });
    if (p.isCancel(out)) return false;
    opts.source = kind as SourceKind;
    opts.target = kind === "url" ? new URL(target.trim()).href : target.trim();
    opts.ultra = ultra === true;
    opts.out = out.trim();
    return true;
}

function consoleReporter(): Reporter {
    return {
        step: (label) => process.stdout.write(`  ... ${label}\n`),
        done: (label, detail) => process.stdout.write(`  ok  ${label}${detail ? `  ${detail}` : ""}\n`),
        warn: (message) => process.stdout.write(`  !   ${message}\n`),
    };
}

function rel(path: string): string {
    const r = relative(process.cwd(), path);
    return r && !r.startsWith("..") ? `./${r.replace(/\\/g, "/")}` : path;
}

function printSummary(result: DesignResult): void {
    const { profile, animations } = result;
    const rows: Array<[string, string]> = [
        ["Colors", `${profile.colors.length}`],
        ["Fonts", `${new Set(profile.typography.map((t) => t.fontFamily)).size} families`],
        ["Grid", `${profile.spacing.base}px`],
        ["Components", `${profile.components.length}`],
        ["Animations", `${profile.animations.length}`],
        ["Frameworks", profile.frameworks.map((f) => f.name).join(", ") || "none detected"],
        ["Dark mode", profile.designTraits.hasDarkMode ? "light/dark pair" : "single theme"],
    ];
    if (animations) {
        rows.push(["Keyframes", `${animations.keyframes.length}`], ["Scroll frames", `${animations.scrollFrames.length}`]);
        if (animations.libraries.length > 0) rows.push(["Motion stack", animations.libraries.map((l) => l.name).join(", ")]);
    }
    console.log(`\n  ${profile.projectName}`);
    for (const [k, v] of rows) console.log(`    ${k.padEnd(14)}${v}`);
    console.log("\n  Output");
    console.log(`    ${rel(result.designDir)}`);
    if (result.designMdPath) console.log(`    ${rel(result.designMdPath)}`);
    if (result.skillFile) console.log(`    ${rel(result.skillFile)}`);
    if (result.installs.length > 0) {
        console.log("\n  Installed skill");
        for (const i of result.installs) console.log(`    ${i.status === "installed" ? "ok" : "skipped"}  ${AGENTS[i.agent]?.label ?? i.agent}  ${i.path}${i.reason ? `  (${i.reason})` : ""}`);
    } else if (result.skillFile) {
        console.log("\n  Skill not installed; copy the folder into an agent's skills directory, or re-run without --no-install.");
    }
    console.log("");
}

export async function runDesignCli(argv: string[]): Promise<number> {
    const parsed = parseDesignArgs(argv);
    if (!parsed.options) {
        console.error(`enigma design: ${parsed.error}\nRun 'enigma design --help' for usage.`);
        return 2;
    }
    const opts = parsed.options;
    if (!opts.target) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            console.error("enigma design: give a source (a URL, a directory or a git URL).\nRun 'enigma design --help' for usage.");
            return 2;
        }
        if (!(await promptSource(opts))) { p.cancel("Cancelled."); return 1; }
    }
    // Ctrl+C mid-run: exit through 'exit', which stops the browser and removes its temp profile.
    const onSigint = (): void => process.exit(130);
    process.once("SIGINT", onSigint);
    try {
        console.log(`\n  enigma design  ${opts.source}  ${opts.target}${opts.ultra ? "  (ultra)" : ""}\n`);
        const result = await runDesign({ ...opts, out: resolve(opts.out) }, consoleReporter());
        printSummary(result);
        return 0;
    } catch (err) {
        console.error(`\n  enigma design failed: ${(err as Error).message}\n`);
        return 1;
    } finally {
        process.off("SIGINT", onSigint);
    }
}
