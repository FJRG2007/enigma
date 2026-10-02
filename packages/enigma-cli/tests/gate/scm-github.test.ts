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
import { stripAttributionLines } from "@/attribution-guard";
import { New, type Cmd, type CmdFactory, parseIncludedResponse } from "@/gate/scm/github";

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

/**
 * A PR parked on a merge is re-read every few seconds, so the read must be a
 * conditional request: an unchanged PR answers 304, which GitHub does not count
 * against the rate limit, and the cached state is replayed.
 */
function scriptedCmdFactory(invocations: Invocation[], answers: Array<{ out: string; err: Error | null; }>): CmdFactory {
    return (_signal, _name, ...args) => {
        const invocation: Invocation = { args, stdin: undefined };
        invocations.push(invocation);
        const answer = answers.shift() ?? { out: "", err: new Error("unexpected call") };
        const cmd: Cmd = {
            run: async () => answer.err,
            output: async () => answer,
            combinedOutput: async () => answer,
            withStdin: (text: string) => {
                invocation.stdin = text;
                return cmd;
            }
        };
        return cmd;
    };
}

const pr = { number: "7", url: "https://github.com/o/r/pull/7" };
const ok = (etag: string, body: object): string => `HTTP/2.0 200 OK\r\nEtag: ${etag}\r\nX-Other: 1\r\n\r\n${JSON.stringify(body)}`;
const notModified = (etag: string): { out: string; err: Error; } => ({ out: `HTTP/2.0 304 Not Modified\r\nEtag: ${etag}\r\n\r\n`, err: new Error("exit status 1") });

test("getPRState sends the last ETag and replays the cached state on 304", async () => {
    const invocations: Invocation[] = [];
    const host = New(scriptedCmdFactory(invocations, [
        { out: ok('W/"a"', { state: "open", merged: false, merged_at: null }), err: null },
        notModified('"a"'),
        { out: ok('W/"b"', { state: "closed", merged: true, merged_at: "2026-10-02T00:00:00Z" }), err: null }
    ]), () => true, "o/r");

    expect(await host.getPRState(undefined, pr)).toBe("OPEN");
    expect(invocations[0].args).toEqual(["api", "--include", "repos/o/r/pulls/7"]);

    expect(await host.getPRState(undefined, pr)).toBe("OPEN");
    expect(invocations[1].args).toEqual(["api", "--include", "repos/o/r/pulls/7", "-H", 'If-None-Match: W/"a"']);

    // REST reports a merged PR as closed + merged; it must read as MERGED, not CLOSED.
    expect(await host.getPRState(undefined, pr)).toBe("MERGED");
});

test("getPRState reports a closed, unmerged PR as CLOSED", async () => {
    const host = New(scriptedCmdFactory([], [{ out: ok('"c"', { state: "closed", merged: false, merged_at: null }), err: null }]), () => true, "o/r");
    expect(await host.getPRState(undefined, pr)).toBe("CLOSED");
});

test("getPRState resolves the repo from the checkout when none is configured", async () => {
    const invocations: Invocation[] = [];
    const host = New(scriptedCmdFactory(invocations, [{ out: ok('"a"', { state: "open" }), err: null }]), () => true, "");
    await host.getPRState(undefined, pr);
    expect(invocations[0].args[2]).toBe("repos/{owner}/{repo}/pulls/7");
});

test("getPRState throws on a failed read instead of guessing a state", async () => {
    const host = New(scriptedCmdFactory([], [{ out: "", err: new Error("gh: Not Found (HTTP 404)") }]), () => true, "o/r");
    await expect(host.getPRState(undefined, pr)).rejects.toThrow("Not Found");
});

test("a 304 with nothing cached is an error, not a state", async () => {
    const host = New(scriptedCmdFactory([], [notModified('"a"')]), () => true, "o/r");
    await expect(host.getPRState(undefined, pr)).rejects.toThrow();
});

test("parseIncludedResponse reads status, ETag and body", () => {
    expect(parseIncludedResponse('HTTP/1.1 200 OK\nETag: "x"\n\n{"a":1}')).toEqual({ status: 200, etag: '"x"', body: '{"a":1}' });
    expect(parseIncludedResponse("")).toEqual({ status: 0, etag: "", body: "" });
});

// A squash merge assembles its message from the branch's commits, so a commit that still carries
// an AI trailer makes the merge credit the AI. With attribution off the merge sets the message
// itself, keeping the PR title (and its emoji) as the subject.
test("mergePR writes the squash message without AI attribution when asked", async () => {
    const invocations: Invocation[] = [];
    const view = JSON.stringify({
        title: "✨ feat(deploy): zero-downtime cutover",
        commits: [
            { messageHeadline: "✨ feat(hostd): aliases per network", messageBody: "Why it matters.\n\nCo-Authored-By: Claude <noreply@anthropic.com>" },
            { messageHeadline: "🐛 fix(deploy): harden the port gate", messageBody: "" },
        ],
    });
    const host = New(scriptedCmdFactory(invocations, [{ out: view, err: null }, { out: "", err: null }]), () => true, "o/r");
    await host.mergePR(undefined, pr, "squash", { stripAttribution: true });
    const merge = invocations[1]!.args;
    expect(merge.slice(0, 2)).toEqual(["pr", "merge"]);
    expect(merge[merge.indexOf("--subject") + 1]).toBe("✨ feat(deploy): zero-downtime cutover (#7)");
    expect(merge).toContain("--body-file");
    expect(invocations[1]!.stdin).toBe("* ✨ feat(hostd): aliases per network\n\nWhy it matters.\n\n* 🐛 fix(deploy): harden the port gate");
});

// Without an AI line in any commit, and for a merge commit, GitHub's own message stays.
test("mergePR leaves GitHub's message alone when there is nothing to strip", async () => {
    const view = JSON.stringify({ title: "feat: x", commits: [{ messageHeadline: "feat: x", messageBody: "Co-authored-by: Jane <jane@example.invalid>" }] });
    const clean: Invocation[] = [];
    await New(scriptedCmdFactory(clean, [{ out: view, err: null }, { out: "", err: null }]), () => true, "o/r").mergePR(undefined, pr, "squash", { stripAttribution: true });
    expect(clean[1]!.args).not.toContain("--subject");
    const spaced = JSON.stringify({ title: "feat: x", commits: [{ messageHeadline: "feat: x", messageBody: "Why.\n\n\n\nMore." }] });
    const blank: Invocation[] = [];
    await New(scriptedCmdFactory(blank, [{ out: spaced, err: null }, { out: "", err: null }]), () => true, "o/r").mergePR(undefined, pr, "squash", { stripAttribution: true });
    expect(blank[1]!.args).not.toContain("--subject");
    const merged: Invocation[] = [];
    await New(scriptedCmdFactory(merged, [{ out: "", err: null }]), () => true, "o/r").mergePR(undefined, pr, "merge", { stripAttribution: true });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.args).not.toContain("--subject");
});

test("stripAttributionLines keeps everything but the AI lines", () => {
    const body = "* feat: a\n\nWhy.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\n* fix: b\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-authored-by: Jane <jane@example.invalid>";
    expect(stripAttributionLines(body)).toBe("* feat: a\n\nWhy.\n\n* fix: b\n\nCo-authored-by: Jane <jane@example.invalid>");
});
