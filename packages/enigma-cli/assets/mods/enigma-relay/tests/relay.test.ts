import { describe, expect, test } from "claude-code/testing";

const CWD = "/work/repo/pkg";
const turn = { answer: "", text: "", durationMs: 1, isAborted: false, turnId: "t", reason: "answer" as const, category: null, explanation: null };

/** Wires the engine's side of every call the relay makes, recording what it asked for. */
function engine(on: Parameters<Parameters<typeof test>[1] & ((...a: never[]) => unknown)>[1], opts: { tokens: number; latest: () => string | null; }) {
    const seen = { prompts: [] as string[], commands: [] as string[], toasts: [] as string[] };
    let settle: () => void = () => {};
    const submitted = new Promise<void>((r) => { settle = r; });
    on("turn.complete", () => ({ text: "" }));
    on("session.usage", () => ({ value: { startedAt: 0, context: { tokens: opts.tokens, window: 1_000_000, percent: Math.round(opts.tokens / 10_000) }, rateLimits: {}, cost: { totalUsd: 0 } } }) as never);
    on("session.cwd", () => ({ value: CWD }) as never);
    on("fs.read", ($, e) => {
        const path = (e as { path: string; }).path;
        if (path.endsWith("latest.json")) { const v = opts.latest(); return (v === null ? { deny: "ENOENT" } : { value: v }) as never; }
        if (path.endsWith(".json")) return { value: JSON.stringify({ consumedAt: null }) } as never;
        return { value: "# goal\n\n## Next\n1. finish" } as never;
    });
    on("prompt.submit", ($, e) => { seen.prompts.push((e as { text: string; }).text); settle(); return { text: (e as { text: string; }).text } as never; });
    on("command.run", ($, e) => { seen.commands.push((e as { command: string; }).command); return { value: { text: "" } } as never; });
    on("ui.toast", ($, e) => { seen.toasts.push(String((e as { text?: string; }).text ?? e)); return { value: undefined } as never; });
    return { seen, submitted };
}

describe("enigma relay", () => {
    test("stays quiet under the threshold", async ($, on) => {
        const { seen } = engine(on, { tokens: 10_000, latest: () => null });
        await $.turn.complete(turn);
        expect(seen.prompts.length).toBe(0);
    });

    test("asks for a handoff past the threshold, then clears and continues once it is saved", async ($, on) => {
        let saved: string | null = null;
        const { seen, submitted } = engine(on, { tokens: 400_000, latest: () => saved });
        await $.turn.complete(turn);
        await submitted;
        expect(seen.prompts[0]).toContain("/handoff");
        saved = JSON.stringify({ root: "/work/repo", savedAt: Date.now() + 1000, done: false, text: "/h/x.md", meta: "/h/x.json", consumedAt: null });
        await $.turn.complete(turn);
        for (let i = 0; i < 50 && seen.prompts.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
        expect(seen.commands).toEqual(["clear"]);
        expect(seen.prompts[1]).toContain("Continue the work from the handoff");
        expect(seen.prompts[1]).toContain("## Next");
    });

    test("never clears without a saved handoff", async ($, on) => {
        const { seen, submitted } = engine(on, { tokens: 400_000, latest: () => null });
        await $.turn.complete(turn);
        await submitted;
        await $.turn.complete(turn);
        expect(seen.commands).toEqual([]);
    });

    test("does not ask again at the same size after a turn that saved nothing", async ($, on) => {
        const { seen, submitted } = engine(on, { tokens: 400_000, latest: () => null });
        await $.turn.complete(turn);
        await submitted;
        await $.turn.complete(turn);
        await $.turn.complete(turn);
        await new Promise((r) => setTimeout(r, 20));
        expect(seen.prompts.length).toBe(1);
        expect(seen.commands).toEqual([]);
    });
});
