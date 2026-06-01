/**
 * Full-screen settings TUI, built with Ink (React for the terminal) - the same
 * model/update/view approach as OpenCode's Bubble Tea UI. It takes over the whole
 * terminal via the alternate screen buffer (like vim/htop): a header bar, a body
 * that fills every row (categories sidebar + settings panel with live on/off
 * values), and a fixed footer of key hints. The previous terminal contents are
 * restored on exit. Toggling writes straight to the underlying config file via the
 * shared registry; scope (global vs project) is a screen-level switch.
 *
 * React and Ink are imported dynamically inside `runSettingsTui` so that ordinary
 * commands (version, guard, config <key> <val>) never load them at startup.
 */

import { CATEGORIES, valueLabel } from "../settings-registry";
import type { Scope } from "../settings-registry";

const ENTER_ALT = "\x1b[?1049h\x1b[?25l"; // alternate screen buffer + hide cursor
const LEAVE_ALT = "\x1b[?25h\x1b[?1049l"; // show cursor + restore main buffer

/**
 * Launch the full-screen settings TUI and resolve when the user quits. No-op off
 * a TTY. Restores the terminal (main buffer + cursor) on exit, including an
 * `exit` handler so an unexpected termination cannot leave the alt screen up.
 */
export async function runSettingsTui(): Promise<void> {
    if (!process.stdout.isTTY) return;

    const React = (await import("react")).default;
    const ink = await import("ink");
    const { render } = ink;
    const h = React.createElement;

    const restore = (): void => { try { process.stdout.write(LEAVE_ALT); } catch { /* ignore */ } };
    const App = buildSettingsApp(React, ink);

    process.stdout.write(ENTER_ALT);
    process.on("exit", restore);
    try {
        const app = render(h(App), { exitOnCtrlC: true });
        await app.waitUntilExit();
    } finally {
        process.removeListener("exit", restore);
        restore();
    }
}

/**
 * Build the settings App component, given the dynamically imported React and Ink.
 * Separated from `runSettingsTui` (which owns the alt-screen lifecycle) so the
 * component can be rendered in isolation for testing.
 */
export function buildSettingsApp(React: typeof import("react"), ink: typeof import("ink")) {
    const { useApp, useInput, useStdout } = ink;
    const Box = ink.Box as never;
    const Text = ink.Text as never;
    const { useState, useEffect } = React;
    const h = React.createElement;

    return function App() {
        const { exit } = useApp();
        const { stdout } = useStdout();
        const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
        const [scope, setScope] = useState<Scope>("global");
        const [focusSettings, setFocusSettings] = useState(false);
        const [catIndex, setCatIndex] = useState(0);
        const [setIndex, setSetIndex] = useState(0);
        const [, redraw] = useState(0); // force a re-read after a write

        useEffect(() => {
            const onResize = (): void => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
            stdout.on("resize", onResize);
            return () => { stdout.off("resize", onResize); };
        }, [stdout]);

        const category = CATEGORIES[catIndex]!;
        const settings = category.settings;
        const focused = settings[setIndex]!;

        useInput((input, key) => {
            if (input === "q" || key.escape) { exit(); return; }
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
                if (focusSettings) setSetIndex((i) => Math.min(settings.length - 1, i + 1));
                else { setCatIndex((i) => Math.min(CATEGORIES.length - 1, i + 1)); setSetIndex(0); }
                return;
            }
            if (key.return || input === " ") {
                if (!focusSettings) { setFocusSettings(true); return; }
                focused.write(!focused.read(scope), scope);
                redraw((n) => n + 1);
            }
        });

        const sidebarWidth = Math.min(28, Math.max(18, Math.floor(size.columns * 0.3)));

        const header = h(Box, { width: size.columns, paddingX: 1, justifyContent: "space-between" },
            h(Text, { bold: true, color: "cyan" }, "enigma settings"),
            h(Box, {},
                h(Text, { dimColor: true }, "scope "),
                h(Text, { bold: true, color: scope === "global" ? "green" : "yellow" }, scope),
                h(Text, { dimColor: true }, "   (g to change)")));

        const sidebar = h(Box, {
            flexDirection: "column", borderStyle: "round",
            borderColor: focusSettings ? "gray" : "cyan", paddingX: 1, width: sidebarWidth, marginRight: 1,
        }, [
            h(Text, { key: "__t", bold: true, dimColor: true }, "CATEGORIES"),
            ...CATEGORIES.map((c, i) => h(Text, {
                key: c.title, inverse: !focusSettings && i === catIndex,
                color: i === catIndex ? "cyan" : undefined,
            }, ` ${c.title} `)),
        ]);

        const rows = settings.map((s, i) => {
            const on = s.read(scope);
            const selected = focusSettings && i === setIndex;
            return h(Box, { key: s.key, justifyContent: "space-between" },
                h(Text, { inverse: selected, bold: selected }, ` ${s.label}${s.globalOnly ? "  (global)" : ""} `),
                h(Text, { bold: true, color: on ? "green" : "gray" }, `${valueLabel(on)} `));
        });

        const panel = h(Box, {
            flexDirection: "column", borderStyle: "round",
            borderColor: focusSettings ? "cyan" : "gray", paddingX: 1, flexGrow: 1,
        }, [
            h(Text, { key: "__b", bold: true, color: "cyan" }, category.title),
            h(Text, { key: "__bl", dimColor: true }, category.blurb),
            h(Box, { key: "__sp1", marginTop: 1, flexDirection: "column" }, rows),
            h(Box, { key: "__grow", flexGrow: 1 }),
            h(Text, { key: "__hint", dimColor: true, wrap: "truncate-end" }, focused.hint),
        ]);

        const footer = h(Box, { width: size.columns, paddingX: 1 },
            h(Text, { dimColor: true },
                "up/down move    tab/left/right switch    enter toggle    g scope    q quit"));

        return h(Box, { width: size.columns, height: size.rows, flexDirection: "column" },
            header,
            h(Box, { flexGrow: 1 }, sidebar, panel),
            footer);
    };
}
