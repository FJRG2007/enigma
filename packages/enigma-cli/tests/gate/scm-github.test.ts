/**
 * PR bodies must never ride in argv.
 *
 * A generated PR body carries the change summary plus the intent, risk, testing and
 * pipeline sections, so it routinely runs to tens of kilobytes. Windows caps an entire
 * command line at 32767 characters, so passing it as `--body <text>` failed the pr step
 * with `ENAMETOOLONG: name too long, uv_spawn` - after review, test, document and lint
 * had already spent their agent time, losing the whole run. The body goes over stdin
 * with `--body-file -` instead (upstream PR 370).
 */
import { test, expect } from "bun:test";
import { New, type Cmd, type CmdFactory } from "../../src/gate/scm/github";

interface Invocation {
    args: string[];
    stdin: string | undefined;
}

/** Records what would have been spawned and answers with `out`. */
function recordingCmdFactory(invocations: Invocation[], out: string): CmdFactory {
    return (_signal, _name, ...args) => {
        const invocation: Invocation = { args, stdin: undefined };
        invocations.push(invocation);
        const cmd: Cmd = {
            run: async () => null,
            output: async () => ({ out, err: null }),
            combinedOutput: async () => ({ out, err: null }),
            withStdin: (text: string) => {
                invocation.stdin = text;
                return cmd;
            }
        };
        return cmd;
    };
}

const bigBody = `## What Changed\n\n${"- a reviewed change worth describing at length\n".repeat(2000)}`;

test("createPR sends the body over stdin, never argv", async () => {
    const invocations: Invocation[] = [];
    const host = New(recordingCmdFactory(invocations, "https://github.com/o/r/pull/7\n"), () => true, "o/r");

    const pr = await host.createPR(undefined, "feature/x", "main", { title: "feat: x", body: bigBody });

    expect(pr.number).toBe("7");
    expect(invocations).toHaveLength(1);
    const { args, stdin } = invocations[0];
    expect(args).toContain("--body-file");
    expect(args[args.indexOf("--body-file") + 1]).toBe("-");
    expect(args).not.toContain("--body");
    expect(stdin).toBe(bigBody);
    // The body is the only oversized part, so the command line stays far below the cap.
    expect(args.join(" ").length).toBeLessThan(8_000);
});

test("updatePR sends the body over stdin, never argv", async () => {
    const invocations: Invocation[] = [];
    const host = New(recordingCmdFactory(invocations, ""), () => true, "o/r");

    await host.updatePR(undefined, { number: "7", url: "https://github.com/o/r/pull/7" }, {
        title: "feat: x",
        body: bigBody
    });

    expect(invocations).toHaveLength(1);
    const { args, stdin } = invocations[0];
    expect(args).toContain("--body-file");
    expect(args).not.toContain("--body");
    expect(stdin).toBe(bigBody);
});
