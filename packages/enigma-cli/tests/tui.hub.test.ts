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
import type { HubAccount, HubProfile, HubSkill, HubContext } from "../src/tui/types";

const accounts: HubAccount[] = [
    { tool: "claude", toolLabel: "Claude Code", name: "default", dir: "C:/fake/claude", email: "me@example.com", active: true, removable: false },
    { tool: "codex", toolLabel: "Codex", name: "work", dir: "C:/fake/codex-work", active: false, removable: true },
];
const profiles: HubProfile[] = [{ name: "personal", active: false, summary: "claude=default" }];
let skills: HubSkill[] = [
    { name: "alpha-skill", version: "1.0.0", discarded: false, agentsOff: [] },
    { name: "beta-skill", version: "2.1.0", discarded: false, agentsOff: [] },
];
const hub: HubContext = {
    agents: [{ name: "claude", label: "Claude Code", installed: true }],
    protections: [{ value: "secrets", label: "Secrets", hint: "block secrets" }],
    runAction: async () => ({ ok: true, title: "noop", lines: [] }),
    skills,
    setSkillDiscarded: (name, discarded) => {
        skills = skills.map((s) => (s.name === name ? { ...s, discarded } : s));
        return skills;
    },
    setSkillAgent: (name, agent, off) => {
        skills = skills.map((s) => (s.name === name
            ? { ...s, agentsOff: off ? [...new Set([...s.agentsOff, agent])] : s.agentsOff.filter((a) => a !== agent) }
            : s));
        return skills;
    },
    accounts,
    activateAccount: () => accounts,
    removeAccount: () => accounts,
    addAccount: () => ({ ok: true, accounts }),
    renameAccount: () => ({ ok: true, accounts }),
    tools: [{ name: "claude", label: "Claude Code" }, { name: "codex", label: "Codex" }],
    toolPaths: [{ name: "claude", label: "Claude Code", status: "on PATH" }, { name: "codex", label: "Codex", status: "not installed" }],
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

test("unified panel renders sections and the wheel mirrors the arrows", async () => {
    const done = runHomeTui(hub);
    const first = await until((f) => f.includes("MENU"), "menu");
    expect(first).toContain("Accounts & profiles"); // single sidebar entry
    expect(first).not.toMatch(/ Profiles {2}/); // no separate Profiles entry

    // Navigate the sidebar to the identity entry (last item) and focus the panel.
    const identityIndex = CATEGORIES.length + 6; // categories + usage + recall + resources + 3 actions (skills, security, fix-path)
    await press(...Array(identityIndex).fill("ARROW_DOWN"));
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
    await press("ARROW_UP", "ARROW_UP");
    await until((f) => f.includes("c connect/login"), "arrows back to account row");

    // Wheel over the sidebar moves the menu selection back up (focus returns left).
    await setup.mockMouse.scroll(5, 4, "up");
    await until((f) => !f.includes("ACCOUNTS"), "sidebar wheel changes panel");

    // Install panel: the SKILLS section lists every skill under the agents. The wheel
    // up landed on the fix-path action; step up past security to the skills action.
    await press("ARROW_UP", "ARROW_UP"); // fix-path -> security -> skills action
    const install = await until((f) => f.includes("AGENTS") && f.includes("SKILLS"), "install panel sections");
    expect(install).toContain("alpha-skill");
    expect(install).toContain("v2.1.0");

    // Focus the panel and move past the single agent row onto the first skill row;
    // space asks for confirmation, y discards (the row flips to unchecked/discarded).
    await setup.mockInput.pressKey("RETURN");
    await until((f) => f.includes("enter install"), "install panel focused");
    await setup.mockInput.pressKey("ARROW_DOWN");
    await until((f) => f.includes("space discard/restore"), "cursor on a skill row");
    await setup.mockInput.pressKey(" ");
    // The message wraps in the dialog, so match the header chip and the buttons.
    await until((f) => f.includes("discard skill") && f.includes("Cancel"), "discard confirm overlay");
    await setup.mockInput.pressKey("y");
    const discardedFrame = await until((f) => f.includes("[ ] alpha-skill") && f.includes("discarded"), "skill discarded");
    expect(skills[0]!.discarded).toBe(true);
    expect(discardedFrame).toContain("[x] beta-skill");

    // Space on a discarded skill restores it immediately (no confirmation).
    await setup.mockInput.pressKey(" ");
    await until((f) => f.includes("[x] alpha-skill"), "skill restored");
    expect(skills[0]!.discarded).toBe(false);

    // 'a' on the skill row opens the per-app overlay; space toggles the skill off for
    // Claude Code, recording the per-agent opt-out via the setSkillAgent callback.
    await setup.mockInput.pressKey("a");
    const overlay = await until((f) => f.includes("skill per app") && f.includes("Claude Code"), "per-app overlay");
    expect(overlay).toContain(" on "); // the only app starts enabled
    await setup.mockInput.pressKey(" ");
    await until(() => skills[0]!.agentsOff.includes("claude"), "skill off for claude");
    // The overlay re-renders the app as off.
    await until((f) => f.includes("skill per app") && f.includes(" off "), "app shown off");

    // Quit with Ctrl+C, which exits unconditionally even with the overlay open (a lone ESC
    // byte is buffered by the key parser in this headless harness, so it cannot drive close).
    await setup.mockInput.pressKey("\x03");
    expect(await done).toBeNull();
}, 30000);
