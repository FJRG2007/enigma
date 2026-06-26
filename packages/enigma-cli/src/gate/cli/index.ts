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
function parseForkFlag(args: string[]): { forkUrl?: string } {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--fork-url") return { forkUrl: args[i + 1] };
        if (a.startsWith("--fork-url=")) return { forkUrl: a.slice("--fork-url=".length) };
    }
    return {};
}

/** Reads `--limit <n>` (or `--limit=<n>`) from the runs args. */
function parseLimitFlag(args: string[]): { limit?: number } {
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

/** Dispatches a gate subcommand. Returns the process exit code. */
export async function runGateCli(argv: string[]): Promise<number> {
    // The gate is EXPERIMENTAL and off by default. It does nothing (and the /gate
    // command is not deployed to agents) until the user opts in.
    if (!readConfig().config.gate) {
        process.stderr.write("enigma gate is experimental and off by default.\n");
        process.stderr.write("Enable it with:  enigma config gate on\n");
        process.stderr.write("Then `enigma gate init` in a repo, and the /gate command becomes available to your agent.\n");
        return 1;
    }
    const sub = argv[0] ?? "";
    const rest = argv.slice(1);
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
