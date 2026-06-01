/**
 * Full-screen settings TUI, built with Ink (React for the terminal) - the same
 * model/update/view approach as OpenCode's Bubble Tea UI. Two panes: categories
 * on the left, the selected category's settings (with live on/off values) on the
 * right. Toggling writes straight to the underlying config file via the shared
 * registry. Scope (global vs project) is a screen-level switch.
 *
 * React and Ink are imported dynamically inside `runSettingsTui` so that ordinary
 * commands (version, guard, config <key> <val>) never load them at startup.
 */

import { CATEGORIES, valueLabel } from "../settings-registry";
import type { Scope } from "../settings-registry";

/**
 * Launch the interactive settings TUI and resolve when the user quits. No-op off
 * a TTY (callers gate on interactivity, but this stays defensive).
 */
export async function runSettingsTui(): Promise<void> {
    if (!process.stdout.isTTY) return;

    const React = (await import("react")).default;
    const ink = await import("ink");
    const { render, useApp, useInput } = ink;
    const Box = ink.Box as never;
    const Text = ink.Text as never;
    const { useState } = React;
    const h = React.createElement;

    function App() {
        const { exit } = useApp();
        const [scope, setScope] = useState<Scope>("global");
        const [focusSettings, setFocusSettings] = useState(false);
        const [catIndex, setCatIndex] = useState(0);
        const [setIndex, setSetIndex] = useState(0);
        const [, bump] = useState(0); // force a re-read after a write

        const category = CATEGORIES[catIndex]!;
        const settings = category.settings;

        useInput((input, key) => {
            if (input === "q" || key.escape || (key.ctrl && input === "c")) { exit(); return; }
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
                const setting = settings[setIndex]!;
                setting.write(!setting.read(scope), scope);
                bump((n) => n + 1);
            }
        });

        const header = h(Box, { marginBottom: 1 },
            h(Text, { bold: true, color: "cyan" }, "enigma settings"),
            h(Text, { dimColor: true }, "    scope: "),
            h(Text, { bold: true, color: scope === "global" ? "green" : "yellow" }, scope),
            h(Text, { dimColor: true }, "  (g to change)"),
        );

        const left = h(Box, {
            flexDirection: "column", borderStyle: "round",
            borderColor: focusSettings ? "gray" : "cyan", paddingX: 1, width: 26, marginRight: 1,
        }, CATEGORIES.map((c, i) => h(Text, {
            key: c.title, color: i === catIndex ? "cyan" : undefined, inverse: !focusSettings && i === catIndex,
        }, `${i === catIndex ? ">" : " "} ${c.title}`)));

        const right = h(Box, {
            flexDirection: "column", borderStyle: "round",
            borderColor: focusSettings ? "cyan" : "gray", paddingX: 1, flexGrow: 1,
        }, [
            h(Text, { key: "__blurb", dimColor: true }, category.blurb),
            ...settings.map((s, i) => {
                const on = s.read(scope);
                const selected = focusSettings && i === setIndex;
                return h(Box, { key: s.key, justifyContent: "space-between" },
                    h(Text, { inverse: selected }, `${selected ? ">" : " "} ${s.label}${s.globalOnly ? " (global)" : ""}`),
                    h(Text, { bold: true, color: on ? "green" : "gray" }, ` ${valueLabel(on)}`),
                );
            }),
        ]);

        const footer = h(Box, { marginTop: 1 }, h(Text, { dimColor: true },
            "up/down move  -  tab/left/right switch pane  -  enter/space toggle  -  g scope  -  q quit"));

        return h(Box, { flexDirection: "column" }, header, h(Box, {}, left, right), footer);
    }

    const app = render(h(App));
    await app.waitUntilExit();
}
