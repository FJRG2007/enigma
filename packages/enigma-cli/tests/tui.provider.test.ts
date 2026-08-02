/**
 * Headless smoke test for the hub TUI's per-account provider editor (point a Claude
 * account at another backend, e.g. MiniMax). Its own file so it gets a FRESH test
 * renderer + a single runHomeTui - the native OpenTUI core segfaults if runHomeTui is
 * mounted twice on one renderer, and Bun runs each test file in its own process.
 * Run under Bun: bun test tests/tui.provider.test.ts
 */
import { test, expect, mock } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

process.env.ENIGMA_GH_BIN = "gh-missing-for-test";

const core = await import("@opentui/core");
const setup = await createTestRenderer({ width: 100, height: 32 });
mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }));
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

const { CATEGORIES } = await import("../src/settings-registry");
const { runHomeTui } = await import("../src/tui/opentui");
import type { HubAccount, HubContext } from "../src/tui/types";

const accounts: HubAccount[] = [
    { tool: "claude", toolLabel: "Claude Code", name: "default", dir: "C:/fake/claude", email: "me@example.com", active: true, removable: false, supportsProvider: true, provider: null },
    { tool: "claude", toolLabel: "Claude Code", name: "mm", dir: "C:/fake/claude-mm", active: false, removable: true, supportsProvider: true, provider: null },
];
let provCall: { tool: string; name: string; input: unknown; } | null = null;
const hub: HubContext = {
    agents: [{ name: "claude", label: "Claude Code", installed: true }],
    protections: [{ value: "secrets", label: "Secrets", hint: "block secrets" }],
    runAction: async () => ({ ok: true, title: "noop", lines: [] }),
    accounts,
    activateAccount: () => accounts,
    removeAccount: () => accounts,
    addAccount: () => ({ ok: true, accounts }),
    renameAccount: () => ({ ok: true, accounts }),
    tools: [{ name: "claude", label: "Claude Code" }],
    providerPresets: [{ id: "minimax", label: "MiniMax", tool: "claude", baseUrl: "https://api.minimax.io/anthropic", model: "MiniMax-M3[1m]" }],
    setAccountProvider: (tool, name, input) => { provCall = { tool, name, input }; return { ok: true, accounts }; },
};

const until = async (pred: (f: string) => boolean, label: string): Promise<string> => {
    let frame = "";
    for (let i = 0; i < 50; i++) {
        await setup.renderOnce();
        frame = setup.captureCharFrame();
        if (pred(frame)) return frame;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`frame never matched: ${label}; last frame:\n${frame}`);
};

/**
 * Press keys one at a time, rendering after each so the cursor state commits between them.
 * A batched pressKeys can drop intermediate updates on the non-free-running test scheduler
 * (green on Windows, but the events race the render on Linux CI).
 */
const press = async (...keys: string[]): Promise<void> => {
    for (const key of keys) {
        await setup.mockInput.pressKey(key);
        await setup.renderOnce();
    }
};

// The native OpenTUI core delivers injected mock key events on Windows and macOS but not on
// the headless Linux CI runner (every keypress is dropped, so navigation never advances). Run
// this smoke test where key delivery works; skip it on Linux rather than assert against a
// renderer that never receives the input.
const SKIP_HEADLESS_LINUX = process.platform === "linux";

test.skipIf(SKIP_HEADLESS_LINUX)("provider editor: 'p' on a managed Claude account opens the backend picker and fires the callback", async () => {
    const done = runHomeTui(hub);
    await until((f) => f.includes("MENU"), "menu");

    // Navigate the sidebar to the identity entry (last item) and focus the panel.
    const identityIndex = CATEGORIES.length + 7; // categories + usage + recall + resources + ssh + 3 actions (skills, security, fix-path)
    await press(...Array(identityIndex).fill("ARROW_DOWN"));
    await setup.mockInput.pressKey("RETURN");
    await until((f) => f.includes("ACCOUNTS"), "identity panel");

    // The default row is not removable (stays on Anthropic); move to the managed 'mm' account.
    await setup.mockInput.pressKey("ARROW_DOWN");
    await until((f) => f.includes("p provider"), "cursor on a provider-capable account");

    // 'p' opens the backend picker, which lists the MiniMax preset.
    await setup.mockInput.pressKey("p");
    await until((f) => f.includes("Provider for 'mm'") && f.includes("MiniMax"), "backend picker lists presets");

    // The cursor starts on "Default (Anthropic)"; picking it clears the override (input=null),
    // exercising the full row -> 'p' -> pick -> callback wiring without typing into an input.
    await setup.mockInput.pressKey("RETURN");
    await until(() => provCall !== null, "provider callback fired");
    expect(provCall!.tool).toBe("claude");
    expect(provCall!.name).toBe("mm");
    expect(provCall!.input).toBeNull();

    await setup.mockInput.pressKey("\x03");
    expect(await done).toBeNull();
}, 30000);
