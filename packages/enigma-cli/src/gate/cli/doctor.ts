/**
 * `gate doctor`: check system health and dependencies (git, gh, data dir, DB,
 * daemon, and known agents). Faithful port of upstream's
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
import { NATIVE_AGENTS, agentPathEnvVar, defaultAgentBinary, loadGlobal } from "../config";

/** Runs the health checks and prints the report. */
export async function runDoctorCli(paths: Paths): Promise<void> {
    let allOK = true;

    const ok = (label: string, detail: string): void => out(`  ${sGreen("✓")} ${sDim(label)}  ${detail}\n`);
    const warn = (label: string, detail: string): void => out(`  ${sYellow("-")} ${sDim(label)}  ${detail}\n`);
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

    // Optional by design, and never a failed check: gh is reached only by the push, pr and
    // ci steps. A run that skips those (`axi run --skip push,pr,ci`) needs no forge CLI at
    // all, and neither does `gate init` - so an image without gh is a supported setup, not
    // a broken one.
    try {
        await lookPath("gh");
        ok("gh            ", "ok");
    } catch {
        warn("gh            ", `not found ${sDim("(optional: only the push, pr and ci steps use it - skip them and nothing here needs it)")}`);
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
    // Probed exactly as the pipeline resolves them, overrides included, so a run in a
    // sandbox that installed its agent off PATH sees the same answer here as there.
    let overrides: Record<string, string> = {};
    try {
        overrides = loadGlobal(paths.configFile()).agentPathOverride ?? {};
    } catch {
        // A config this broken is reported by the steps that read it; probing defaults is
        // still more useful than printing nothing.
    }
    for (const name of NATIVE_AGENTS) {
        const label = name.padEnd(14);
        const override = overrides[name];
        const source = override ? sDim(`  (${agentPathEnvVar(name)} / agent_path_override.${name})`) : "";
        try {
            const path = await lookPath(override || defaultAgentBinary(name));
            ok(label, `${path}${source}`);
        } catch {
            if (override) { fail(label, `override "${override}" is not an executable file${source}`); allOK = false; }
            else warn(label, `not found ${sDim(`(set ${agentPathEnvVar(name)}=<path> if it is installed off PATH)`)}`);
        }
    }
    if (Object.values(overrides).length === 0) {
        out(`  ${sDim("An agent installed outside PATH is found via ENIGMA_AGENT_<NAME>=<absolute path>.")}\n`);
        out(`  ${sDim("The daemon runs the pipeline, so set it before the daemon starts (else: enigma gate daemon stop).")}\n`);
    }

    if (!allOK) {
        out("\n");
        out(`  ${sRed("some checks failed")}\n`);
    }
}
