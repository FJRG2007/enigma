/**
 * Full-screen TUI, built with Ink (React for the terminal) - the same
 * model/update/view approach as OpenCode's Bubble Tea UI. It takes over the whole
 * terminal via the alternate screen buffer (like vim/htop) and restores the
 * previous contents on exit.
 *
 * One app, two views sized to fill the terminal:
 *   - "home": the top-level menu (configure / install / security / exit).
 *   - "settings": a categories sidebar + a settings panel with live on/off values
 *     that write straight to the underlying config file via the shared registry.
 *
 * React and Ink are imported dynamically inside the launchers so that ordinary
 * commands (version, guard, config <key> <val>) never load them at startup.
 */

import { CATEGORIES, valueLabel } from "../settings-registry";
import type { Scope } from "../settings-registry";

const ENTER_ALT = "\x1b[?1049h\x1b[?25l"; // alternate screen buffer + hide cursor
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l"; // show cursor + restore main buffer

/** Action the user picked that requires leaving the TUI (run by the caller). */
export type LeaveAction = "skills" | "security" | "quit";

const HOME_ITEMS: Array<{ key: string; label: string; hint: string }> = [
    { key: "settings", label: "Configure settings", hint: "emoji, attribution, permission bypass, ..." },
    { key: "skills", label: "Install agent skills", hint: "Claude Code, Codex, opencode" },
    { key: "security", label: "Git security hooks", hint: "block secrets, .env, node_modules on commit" },
    { key: "exit", label: "Exit", hint: "leave enigma" },
];

/**
 * Open the full-screen home menu. `runAction` is invoked (outside the alt screen)
 * when the user picks install or security, then the menu reopens; picking exit
 * ends the loop. Decoupled from the install/security modules via the callback.
 */
export async function runHomeTui(runAction: (action: "skills" | "security") => Promise<void>): Promise<void> {
    await runTui("home", runAction);
}

/** Open the full-screen settings view directly (for `enigma config`). */
export async function runSettingsTui(): Promise<void> {
    await runTui("settings");
}

async function runTui(initialView: "home" | "settings", runAction?: (a: "skills" | "security") => Promise<void>): Promise<void> {
    if (!process.stdout.isTTY) return;

    const React = (await import("react")).default;
    const ink = await import("ink");
    const { render } = ink;
    const h = React.createElement;
    const restore = (): void => { try { process.stdout.write(LEAVE_ALT); } catch { /* ignore */ } };

    for (;;) {
        const state: { leave: LeaveAction } = { leave: "quit" };
        const App = buildApp(React, ink, { initialView, onLeave: (a) => { state.leave = a; } });

        process.stdout.write(ENTER_ALT);
        process.on("exit", restore);
        try {
            const app = render(h(App), { exitOnCtrlC: true });
            await app.waitUntilExit();
        } finally {
            process.removeListener("exit", restore);
            restore();
        }

        if (runAction && (state.leave === "skills" || state.leave === "security")) { await runAction(state.leave); continue; }
        break;
    }
}

/**
 * Build the root TUI component, given the dynamically imported React and Ink.
 * Separated from the launcher (which owns the alt-screen lifecycle) so it can be
 * rendered in isolation for testing. `onLeave` reports the action chosen when the
 * app exits; `initialView` decides whether "back" returns to the home menu or
 * quits.
 */
export function buildApp(
    React: typeof import("react"),
    ink: typeof import("ink"),
    opts: { initialView: "home" | "settings"; onLeave: (action: LeaveAction) => void },
) {
    const { useApp, useInput, useStdout } = ink;
    const Box = ink.Box as never;
    const Text = ink.Text as never;
    const { useState, useEffect } = React;
    const h = React.createElement;
    const canGoHome = opts.initialView === "home";

    return function App() {
        const { exit } = useApp();
        const { stdout } = useStdout();
        const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
        const [view, setView] = useState(opts.initialView);
        const [homeIndex, setHomeIndex] = useState(0);
        const [scope, setScope] = useState<Scope>("global");
        const [focusSettings, setFocusSettings] = useState(false);
        const [catIndex, setCatIndex] = useState(0);
        const [setIndex, setSetIndex] = useState(0);
        const [, redraw] = useState(0);

        useEffect(() => {
            const onResize = (): void => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
            stdout.on("resize", onResize);
            return () => { stdout.off("resize", onResize); };
        }, [stdout]);

        const back = (): void => { if (canGoHome) setView("home"); else { opts.onLeave("quit"); exit(); } };

        useInput((input, key) => {
            if (view === "home") {
                if (input === "q" || key.escape) { opts.onLeave("quit"); exit(); return; }
                if (key.upArrow || input === "k") { setHomeIndex((i) => Math.max(0, i - 1)); return; }
                if (key.downArrow || input === "j") { setHomeIndex((i) => Math.min(HOME_ITEMS.length - 1, i + 1)); return; }
                if (key.return || input === " ") {
                    const item = HOME_ITEMS[homeIndex]!;
                    if (item.key === "settings") { setView("settings"); setFocusSettings(false); }
                    else if (item.key === "exit") { opts.onLeave("quit"); exit(); }
                    else { opts.onLeave(item.key as LeaveAction); exit(); }
                }
                return;
            }

            // settings view
            if (input === "q" || key.escape) { back(); return; }
            if (input === "g") { setScope((s) => (s === "global" ? "local" : "global")); return; }
            if (key.tab) { setFocusSettings((f) => !f); return; }
            if (key.leftArrow || input === "h") { setFocusSettings(false); return; }
            if (key.rightArrow || input === "l") { setFocusSettings(true); return; }
            if (key.upArrow || input === "k") {
                if (focusSettings) setSetIndex((i) => Math.max(0, i - 1));
                else { setCatIndex((i) => Math.max(0, i - 1)); setSetIndex(0); }
                return;
            }
            if (key.downArrow || input === "j") {
                if (focusSettings) setSetIndex((i) => Math.min(CATEGORIES[catIndex]!.settings.length - 1, i + 1));
                else { setCatIndex((i) => Math.min(CATEGORIES.length - 1, i + 1)); setSetIndex(0); }
                return;
            }
            if (key.return || input === " ") {
                if (!focusSettings) { setFocusSettings(true); return; }
                const setting = CATEGORIES[catIndex]!.settings[setIndex]!;
                setting.write(!setting.read(scope), scope);
                redraw((n) => n + 1);
            }
        });

        const titleBar = (right: import("react").ReactNode) => h(Box, { width: size.columns, paddingX: 1, justifyContent: "space-between" },
            h(Text, { bold: true, color: "cyan" }, "enigma"), right);

        const body = view === "home"
            ? renderHome(h, Box, Text, homeIndex)
            : renderSettings(h, Box, Text, { size, scope, focusSettings, catIndex, setIndex });

        const footer = h(Box, { width: size.columns, paddingX: 1 }, h(Text, { dimColor: true },
            view === "home"
                ? "up/down move    enter select    q quit"
                : `up/down move    tab/left/right switch    enter toggle    g scope    ${canGoHome ? "esc back" : "q quit"}`));

        const right = view === "home"
            ? h(Text, { dimColor: true }, "main menu")
            : h(Box, {}, h(Text, { dimColor: true }, "scope "),
                h(Text, { bold: true, color: scope === "global" ? "green" : "yellow" }, scope),
                h(Text, { dimColor: true }, "   (g to change)"));

        return h(Box, { width: size.columns, height: size.rows, flexDirection: "column" },
            titleBar(right), h(Box, { flexGrow: 1 }, body), footer);
    };
}

/** Home menu panel: a full-height list of top-level actions. */
function renderHome(h: typeof import("react").createElement, Box: never, Text: never, homeIndex: number): import("react").ReactElement {
    const items = HOME_ITEMS.map((item, i) => h(Box, { key: item.key, flexDirection: "column" },
        h(Text, { inverse: i === homeIndex, bold: i === homeIndex }, ` ${item.label} `),
        i === homeIndex && item.hint ? h(Text, { key: "h", dimColor: true }, `   ${item.hint}`) : null));

    return h(Box, {
        flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1, flexGrow: 1,
    }, [
        h(Text, { key: "__t", bold: true, color: "cyan" }, "What would you like to do?"),
        h(Box, { key: "__sp", marginTop: 1, flexDirection: "column" }, items),
    ]);
}

interface SettingsViewState {
    size: { columns: number; rows: number };
    scope: Scope;
    focusSettings: boolean;
    catIndex: number;
    setIndex: number;
}

/** Settings view: categories sidebar + the selected category's settings panel. */
function renderSettings(h: typeof import("react").createElement, Box: never, Text: never, s: SettingsViewState): import("react").ReactElement {
    const category = CATEGORIES[s.catIndex]!;
    const settings = category.settings;
    const focused = settings[s.setIndex]!;
    const sidebarWidth = Math.min(28, Math.max(18, Math.floor(s.size.columns * 0.3)));

    const sidebar = h(Box, {
        flexDirection: "column", borderStyle: "round",
        borderColor: s.focusSettings ? "gray" : "cyan", paddingX: 1, width: sidebarWidth, marginRight: 1,
    }, [
        h(Text, { key: "__t", bold: true, dimColor: true }, "CATEGORIES"),
        ...CATEGORIES.map((c, i) => h(Text, {
            key: c.title, inverse: !s.focusSettings && i === s.catIndex, color: i === s.catIndex ? "cyan" : undefined,
        }, ` ${c.title} `)),
    ]);

    const rows = settings.map((setting, i) => {
        const on = setting.read(s.scope);
        const selected = s.focusSettings && i === s.setIndex;
        return h(Box, { key: setting.key, justifyContent: "space-between" },
            h(Text, { inverse: selected, bold: selected }, ` ${setting.label}${setting.globalOnly ? "  (global)" : ""} `),
            h(Text, { bold: true, color: on ? "green" : "gray" }, `${valueLabel(on)} `));
    });

    const panel = h(Box, {
        flexDirection: "column", borderStyle: "round",
        borderColor: s.focusSettings ? "cyan" : "gray", paddingX: 1, flexGrow: 1,
    }, [
        h(Text, { key: "__b", bold: true, color: "cyan" }, category.title),
        h(Text, { key: "__bl", dimColor: true }, category.blurb),
        h(Box, { key: "__rows", marginTop: 1, flexDirection: "column" }, rows),
        h(Box, { key: "__grow", flexGrow: 1 }),
        h(Text, { key: "__hint", dimColor: true, wrap: "truncate-end" }, focused.hint),
    ]);

    return h(Box, { flexGrow: 1 }, sidebar, panel);
}
