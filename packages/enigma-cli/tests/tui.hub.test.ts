/**
 * Headless smoke test for the hub TUI: the unified Accounts & profiles panel
 * and mouse-wheel navigation. Drives the REAL runHomeTui - createCliRenderer is
 * mocked (bun mock.module) to return an @opentui/core test renderer, then keys
 * and mouse are injected and frames are driven explicitly with renderOnce (the
 * test renderer's scheduler does not free-run). Must run under Bun (native
 * core): bun test tests/tui.hub.test.ts
 */
import { test, expect, mock } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

// Make the gh-backed setting read a fast no-op (no gh spawn during renders).
process.env.ENIGMA_GH_BIN = "gh-missing-for-test";

const core = await import("@opentui/core");
const setup = await createTestRenderer({ width: 100, height: 32 });
mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }));
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

const { CATEGORIES } = await import("../src/settings-registry");
const { runHomeTui } = await import("../src/tui/opentui");
import type { HubAccount, HubProfile, HubContext } from "../src/tui/types";

const accounts: HubAccount[] = [
    { tool: "claude", toolLabel: "Claude Code", name: "default", dir: "C:/fake/claude", email: "me@example.com", active: true, removable: false },
    { tool: "codex", toolLabel: "Codex", name: "work", dir: "C:/fake/codex-work", active: false, removable: true },
];
const profiles: HubProfile[] = [{ name: "personal", active: false, summary: "claude=default" }];
const hub: HubContext = {
    agents: [{ name: "claude", label: "Claude Code", installed: true }],
    protections: [{ value: "secrets", label: "Secrets", hint: "block secrets" }],
    runAction: async () => ({ ok: true, title: "noop", lines: [] }),
    accounts,
    activateAccount: () => accounts,
    removeAccount: () => accounts,
    addAccount: () => ({ ok: true, accounts }),
    renameAccount: () => ({ ok: true, accounts }),
    tools: [{ name: "claude", label: "Claude Code" }, { name: "codex", label: "Codex" }],
    profiles,
    activateProfile: () => profiles,
    addProfile: () => ({ ok: true, profiles }),
    renameProfile: () => ({ ok: true, profiles }),
    removeProfile: () => profiles,
    setProfileAccount: () => ({ ok: true, profiles }),
};

/** Drive render passes until the frame matches (the test scheduler is not free-running). */
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

test("unified panel renders sections and the wheel mirrors the arrows", async () => {
    const done = runHomeTui(hub);
    const first = await until((f) => f.includes("MENU"), "menu");
    expect(first).toContain("Accounts & profiles"); // single sidebar entry
    expect(first).not.toMatch(/ Profiles {2}/); // no separate Profiles entry

    // Navigate the sidebar to the identity entry (last item) and focus the panel.
    const identityIndex = CATEGORIES.length + 2; // categories + 2 actions
    await setup.mockInput.pressKeys(Array(identityIndex).fill("ARROW_DOWN"));
    await setup.mockInput.pressKey("RETURN");
    const panel = await until((f) => f.includes("ACCOUNTS") && f.includes("PROFILES"), "identity sections");
    expect(panel).toContain("me@example.com");
    expect(panel).toContain("(none)");
    expect(panel).toContain("c connect/login"); // cursor starts on an account row

    // Wheel down twice over the panel: 2 accounts -> first profile row; the
    // contextual hint flips to the profile keys.
    await setup.mockMouse.scroll(60, 10, "down");
    await setup.mockMouse.scroll(60, 10, "down");
    await until((f) => f.includes("e edit accounts"), "wheel reaches profile rows");

    // Arrows still share the same cursor: two ups land back on an account row.
    await setup.mockInput.pressKeys(["ARROW_UP", "ARROW_UP"]);
    await until((f) => f.includes("c connect/login"), "arrows back to account row");

    // Wheel over the sidebar moves the menu selection back up (focus returns left).
    await setup.mockMouse.scroll(5, 4, "up");
    await until((f) => !f.includes("ACCOUNTS"), "sidebar wheel changes panel");

    await setup.mockInput.pressKey("q");
    expect(await done).toBeNull();
}, 30000);
