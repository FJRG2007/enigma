/**
 * Gate command dispatcher: routes `enigma gate <sub> [args]` to the ported gate
 * command implementations, and exposes the daemon lifecycle hooks the axi
 * machine interface needs. Dispatched early from cli.ts (by argv[0]) so the
 * gate's own flags never pass through enigma's argument parser.
 */

import { runAxi } from "./axi";
import { Paths } from "../paths";
import { runRunsCli } from "./runs";
import { runInitCli } from "./init";
import { runEjectCli } from "./eject";
import { runRerunCli } from "./rerun";
import { runDoctorCli } from "./doctor";
import { runStatusCli } from "./status";
import { readConfig } from "../../config";
import { type AxiDaemon } from "./axiEnv";
import { runDaemonCli, notifyPush, ensureDaemon, isDaemonRunning } from "./daemonCmd";

/** Reads `--fork-url <url>` (or `--fork-url=<url>`) from the init args. */
function parseForkFlag(args: string[]): { forkUrl?: string; } {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--fork-url") return { forkUrl: args[i + 1] };
        if (a.startsWith("--fork-url=")) return { forkUrl: a.slice("--fork-url=".length) };
    }
    return {};
}

/** Reads `--limit <n>` (or `--limit=<n>`) from the runs args. */
function parseLimitFlag(args: string[]): { limit?: number; } {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--limit") {
            const n = Number(args[i + 1]);
            return Number.isFinite(n) ? { limit: n } : {};
        }
        if (a.startsWith("--limit=")) {
            const n = Number(a.slice("--limit=".length));
            return Number.isFinite(n) ? { limit: n } : {};
        }
    }
    return {};
}

/** Usage text for one gate subcommand, or the command list when it is unknown or absent. */
export function gateSubcommandHelp(sub: string): string {
    const usage: Record<string, string> = {
        init: "usage: enigma gate init [--fork <url>]\nInitializes the gate in this repository.",
        eject: "usage: enigma gate eject\nRemoves the gate's hooks and mirror from this repository.",
        doctor: "usage: enigma gate doctor\nReports why the gate is not working.",
        status: "usage: enigma gate status\nShows the current run.",
        runs: "usage: enigma gate runs [--limit <n>]\nLists recent runs.",
        rerun: "usage: enigma gate rerun\nStarts a new run from the current branch, reusing the last run's applied fixes.",
        daemon: "usage: enigma gate daemon <start|stop|status>\nControls the background daemon.",
        axi: "usage: enigma gate axi [run|respond|status|logs|abort] [flags]\nThe machine-readable surface agents drive. Add --help to a subcommand for its flags."
    };
    return usage[sub] ?? "usage: enigma gate <init|status|runs|rerun|doctor|eject|daemon|axi>\nAdd --help to any subcommand for its usage.";
}

/** Dispatches a gate subcommand. Returns the process exit code. */
export async function runGateCli(argv: string[]): Promise<number> {
    // The gate is on by default, so reaching this means the user switched it off -
    // globally, or for this project via its own .enigma.json. Say both, since the
    // second is easy to forget about in a repo someone else configured.
    if (!readConfig().config.gate) {
        process.stderr.write("enigma gate is switched off here.\n");
        process.stderr.write("Turn it back on with:  enigma config gate on\n");
        process.stderr.write("If only this project is off, its .enigma.json carries `gate: false` - remove it or run `enigma config gate on -l`.\n");
        return 1;
    }
    const sub = argv[0] ?? "";
    const rest = argv.slice(1);
    // `--help` must never DO the thing. `enigma gate rerun --help` used to drop `rest` on the
    // floor and start a rerun - the one command someone types to find out what it does was the
    // command that did it. Answered before any side effect, for every subcommand.
    // `axi` answers for its own subcommands (`axi run --help` documents run's flags), so it is
    // left to dispatch; intercepting here would flatten every axi help to one generic line.
    if (sub !== "axi" && (rest.includes("--help") || rest.includes("-h"))) {
        process.stdout.write(`${gateSubcommandHelp(sub)}\n`);
        return 0;
    }
    const paths = Paths.resolve();
    paths.ensureDirs();
    const daemon: AxiDaemon = { ensureDaemon, isDaemonRunning };

    switch (sub) {
        case "init":
            await runInitCli(parseForkFlag(rest), paths);
            return 0;
        case "eject":
            await runEjectCli(paths);
            return 0;
        case "doctor":
            await runDoctorCli(paths);
            return 0;
        case "status":
            await runStatusCli(paths);
            return 0;
        case "runs":
            await runRunsCli(parseLimitFlag(rest), paths);
            return 0;
        case "rerun":
            await runRerunCli(paths);
            return 0;
        case "daemon":
            await runDaemonCli(rest, paths);
            return 0;
        case "axi":
            return runAxi(rest, { daemon });
        case "":
            // Bare `enigma gate` opens the TUI; until the TUI lands it shows the
            // axi home view (the same machine-readable run overview).
            return runAxi([], { daemon });
        default:
            process.stderr.write(`unknown gate subcommand: ${sub}\n`);
            process.stderr.write("usage: enigma gate <init|status|runs|rerun|doctor|eject|daemon|axi>\n");
            return 2;
    }
}

/** Handler for the hidden `__gate-notify` command invoked by the post-receive hook. */
export async function runGateNotify(argv: string[]): Promise<void> {
    await notifyPush(argv, Paths.resolve());
}
