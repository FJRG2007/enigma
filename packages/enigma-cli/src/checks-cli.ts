/**
 * `enigma checks`: list, inspect, run and curate convention checks.
 */

import * as llm from "./llm";
import * as checks from "./checks";
import { projectRoot } from "./handoff";
import * as judge from "./checks-judge";
import * as learn from "./checks-learn";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";

export const CHECKS_HELP = `usage: enigma checks [list | show <name> | run | pending | approve <name|--all> | reject <name|--all> | learn]
Short convention rules judged by a small model against each changed file, in the background
while the agent works. A failed check is handed back to the agent at turn end; the catalog
costs the agent no context.

  list                  the active checks and where each comes from (default)
  show <name>           print one check
  run                   judge this repository's uncommitted changes now and print the findings
  pending               checks proposed from your own corrections, waiting for approval
  approve <name|--all>  start enforcing a proposed check (moves it to ~/.enigma/checks)
  reject <name|--all>   drop a proposed check
  learn                 look for new corrections in your recent sessions now

Add your own: a markdown file with name, description and files frontmatter in ~/.enigma/checks
(every project) or <repo>/.enigma/checks (this project; .agents/checks and .continue/checks are
read too). A file with 'enabled: false' under a name turns that check off.`;

function listChecks(cwd: string): number {
    const catalog = checks.loadChecks(projectRoot(cwd));
    const provider = llm.resolveProvider();
    console.log(provider ? `Judge: ${provider.model} (${provider.kind}).` : "Judge: none configured - checks are not judged. Sign in to Claude Code, or set recall-provider with an API key.");
    for (const c of catalog) console.log(`  ${c.name.padEnd(28)} ${c.source.padEnd(8)} ${c.description}`);
    const pending = learn.pendingChecks().length;
    if (pending) console.log(`${pending} proposed check(s) waiting: enigma checks pending`);
    return 0;
}

function showCheck(cwd: string, name: string | undefined): number {
    const c = [...checks.loadChecks(projectRoot(cwd)), ...learn.pendingChecks()].find((x) => x.name === name);
    if (!c) { console.error(`enigma checks: no check named "${name ?? ""}".`); return 1; }
    console.log(readFileSync(c.path, "utf8").trimEnd());
    return 0;
}

async function runNow(cwd: string): Promise<number> {
    const root = projectRoot(cwd);
    if (!existsSync(join(root, ".git"))) { console.error("enigma checks: not a git repository."); return 1; }
    await judge.runChecks(root, { settleMs: 0 });
    const v = judge.checksVerdict(cwd, 60_000);
    if (v.skipped === "no-provider") { console.error("enigma checks: no judge configured (sign in to Claude Code, or set recall-provider)."); return 1; }
    if (v.skipped === "no-checks") { console.log("No checks are active."); return 0; }
    if (!v.findings.length) { console.log(v.pending ? `No findings; ${v.pending} file(s) could not be judged.` : "No findings."); return 0; }
    console.log(judge.findingsMessage(v.findings));
    return v.findings.some((f) => f.severity === "block") ? 2 : 0;
}

function listPending(): number {
    const pending = learn.pendingChecks();
    if (!pending.length) { console.log("No proposed checks."); return 0; }
    for (const c of pending) console.log(`  ${c.name.padEnd(28)} ${c.description}`);
    console.log("Approve with 'enigma checks approve <name>' (or --all); read one with 'enigma checks show <name>'.");
    return 0;
}

function decide(target: string | undefined, approve: boolean): number {
    const pending = learn.pendingChecks();
    const chosen = target === "--all" ? pending : pending.filter((c) => c.name === target);
    if (!chosen.length) { console.error(`enigma checks: no proposed check named "${target ?? ""}".`); return 1; }
    mkdirSync(checks.userChecksDir(), { recursive: true });
    for (const c of chosen) {
        if (approve) renameSync(c.path, join(checks.userChecksDir(), basename(c.path)));
        else rmSync(c.path, { force: true });
        console.log(`${approve ? "Enforcing" : "Dropped"} ${c.name}.`);
    }
    return 0;
}

async function learnNow(): Promise<number> {
    const n = await learn.learn();
    if (n === null) { console.error("enigma checks: no judge configured (sign in to Claude Code, or set recall-provider)."); return 1; }
    console.log(n ? `${n} new proposed check(s): enigma checks pending` : "No new corrections to learn from.");
    return 0;
}

/** `enigma checks ...`. Returns the exit code. */
export async function runChecksCli(argv: string[], cwd = process.cwd()): Promise<number> {
    const [sub, arg] = argv;
    switch (sub) {
        case undefined: case "list": return listChecks(cwd);
        case "show": return showCheck(cwd, arg);
        case "run": return runNow(cwd);
        case "pending": return listPending();
        case "approve": return decide(arg, true);
        case "reject": return decide(arg, false);
        case "learn": return learnNow();
        case "-h": case "--help": console.log(CHECKS_HELP); return 0;
        default: console.log(CHECKS_HELP); return 2;
    }
}
