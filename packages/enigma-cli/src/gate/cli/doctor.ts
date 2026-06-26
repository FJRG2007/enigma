/**
 * `gate doctor`: check system health and dependencies (git, gh, data dir, DB,
 * daemon, and known agents). Faithful port of no-mistakes'
 * `internal/cli/doctor.go`. Always exits 0 (it only reports), printing
 * "some checks failed" when any check fails, as the Go command does.
 */

import { Database } from "../db";
import { existsSync } from "node:fs";
import type { Paths } from "../paths";
import { run as gitRun } from "../git";
import { lookPath } from "../agent/factory";
import { isDaemonRunning } from "./daemonCmd";
import { out, sRed, sCyan, sDim, sGreen, sYellow, errMessage } from "./common";

/** The native agents probed by doctor, with their default binary names. */
const AGENTS: ReadonlyArray<{ name: string; binary: string }> = [
    { name: "claude", binary: "claude" },
    { name: "codex", binary: "codex" },
    { name: "rovodev", binary: "acli" },
    { name: "opencode", binary: "opencode" },
    { name: "pi", binary: "pi" }
];

/** Runs the health checks and prints the report. */
export async function runDoctorCli(paths: Paths): Promise<void> {
    let allOK = true;

    const ok = (label: string, detail: string): void => out(`  ${sGreen("✓")} ${sDim(label)}  ${detail}\n`);
    const warn = (label: string, detail: string): void => out(`  ${sYellow("–")} ${sDim(label)}  ${detail}\n`);
    const fail = (label: string, detail: string): void => out(`  ${sRed("✗")} ${sDim(label)}  ${detail}\n`);

    out(`  ${sCyan("System")}\n`);

    try {
        await lookPath("git");
        try {
            const version = await gitRun(".", ["--version"]);
            ok("git           ", version);
        } catch (err) {
            fail("git           ", `error (${errMessage(err)})`);
            allOK = false;
        }
    } catch {
        fail("git           ", "not found");
        allOK = false;
    }

    try {
        await lookPath("gh");
        ok("gh            ", "ok");
    } catch {
        warn("gh            ", `not found ${sDim("(optional, needed for PR/CI)")}`);
    }

    if (!existsSync(paths.root())) {
        fail("data directory", `not found (${paths.root()})`);
        allOK = false;
    } else {
        ok("data directory", paths.root());
    }

    if (!existsSync(paths.db())) {
        warn("database      ", `not found ${sDim("(will be created on first use)")}`);
    } else {
        try {
            const d = new Database(paths.db());
            d.close();
            ok("database      ", "ok");
        } catch (err) {
            fail("database      ", `error (${errMessage(err)})`);
            allOK = false;
        }
    }

    if (await isDaemonRunning(paths)) {
        ok("daemon        ", "running");
    } else {
        warn("daemon        ", "stopped");
    }

    out("\n");
    out(`  ${sCyan("Agents")}\n`);
    for (const agent of AGENTS) {
        const label = agent.name.padEnd(14);
        try {
            const path = await lookPath(agent.binary);
            ok(label, path);
        } catch {
            warn(label, "not found");
        }
    }

    if (!allOK) {
        out("\n");
        out(`  ${sRed("some checks failed")}\n`);
    }
}
