/**
 * The enigma TUI, built with Ink (React for the terminal). One unified view: a
 * left "MENU" sidebar listing the setting categories and, in hub mode, the action
 * entries (install skills, git hooks); the right panel adapts to the selection.
 * Selecting an action opens a NATIVE Ink sub-view (multiselect of agents/scope or
 * guard protections) - no clack prompt is shown inside the TUI, since mixing
 * clack's raw-mode prompts with Ink is unreliable. On confirm the TUI exits and the
 * chosen options are executed non-interactively by the launcher; clack is only used
 * when the user runs `enigma install` / `enigma security` directly.
 *
 * Settings toggles are staged in memory and persisted via the shared registry only
 * on an explicit save (s save, x save & exit). Leaving with unsaved edits raises a
 * save/discard/cancel overlay.
 *
 * By default (the `fullscreen` config toggle) the screen is cleared and the layout
 * fills the terminal height - using an OS-agnostic clear sequence, NOT the alternate
 * screen buffer, so exiting returns to the shell without wiping/restoring the
 * terminal (it never "closes" it). With the toggle off it renders inline at natural
 * height. React and Ink are imported dynamically so ordinary commands never load
 * them at startup.
 */

import { readConfig } from "../config";
import { ALL_SETTINGS, CATEGORIES, valueLabel } from "../settings-registry";
import type { Scope, Setting } from "../settings-registry";

const CLEAR_SCREEN = "\x1b[2J\x1b[H"; // erase screen + home cursor (VT100; preserves scrollback)

/** A hub action and the options the user chose for it in the native sub-view. */
export interface LeaveIntent {
    action: "skills" | "security" | "quit";
    scope?: Scope;
    agents?: string[];
    protections?: string[];
}

/** Minimal agent/protection shapes the hub needs (passed in to avoid heavy imports). */
export interface HubAgent { name: string; label: string; installed: boolean; }
export interface HubProtection { value: string; label: string; hint: string; }
export interface HubContext {
    agents: HubAgent[];
    protections: HubProtection[];
    runAction: (intent: LeaveIntent) => Promise<void>;
}

/** Registry lookup by stable key, used to resolve staged edits back to settings. */
const SETTING_BY_KEY = new Map<string, Setting>(ALL_SETTINGS.map((s) => [s.key, s]));

/** Compose/parse the staging-map key (scope cannot contain "/", keys are kebab). */
const stageKey = (key: string, scope: Scope): string => `${scope}/${key}`;
const parseStageKey = (composite: string): { key: string; scope: Scope } => {
    const i = composite.indexOf("/");
    return { scope: composite.slice(0, i) as Scope, key: composite.slice(i + 1) };
};

const ACTION_ITEMS: Array<{ action: "skills" | "security"; title: string; blurb: string }> = [
    { action: "skills", title: "Install agent skills", blurb: "Claude Code, Codex, OpenCode" },
    { action: "security", title: "Git security hooks", blurb: "block secrets, .env, node_modules on commit" },
];

const EXIT_OPTIONS = ["Save & exit", "Exit without saving", "Cancel"] as const;

/** Open the hub TUI (settings + native install/security sub-views). */
export async function runHomeTui(hub: HubContext): Promise<void> {
    await runTui({ showActions: true, hub });
}

/** Open the settings-only TUI directly (for `enigma config`). */
export async function runSettingsTui(): Promise<void> {
    await runTui({ showActions: false });
}

async function runTui(opts: { showActions: boolean; hub?: HubContext }): Promise<void> {
    if (!process.stdout.isTTY) return;

    const fullscreen = readConfig().config.fullscreen;
    const React = (await import("react")).default;
    const ink = await import("ink");
    const { render } = ink;
    const h = React.createElement;
    const agents = opts.hub?.agents ?? [];
    const protections = opts.hub?.protections ?? [];
    const clear = (): void => { if (fullscreen) try { process.stdout.write(CLEAR_SCREEN); } catch { /* ignore */ } };

    for (;;) {
        const state: { intent: LeaveIntent } = { intent: { action: "quit" } };
        const App = buildApp(React, ink, { showActions: opts.showActions, fullscreen, agents, protections, onLeave: (i) => { state.intent = i; } });

        clear(); // clean slate for the TUI
        const app = render(h(App), { exitOnCtrlC: true });
        await app.waitUntilExit();

        const { intent } = state;
        if (opts.hub && (intent.action === "skills" || intent.action === "security")) {
            clear(); // clean slate so the action's output does not draw over the TUI
            await opts.hub.runAction(intent);
            await waitForEnter(); // let the user read the result before the hub reopens
            continue;
        }
        break;
    }
}

/** Block until the user presses a key, so action output is readable before reopening. */
function waitForEnter(): Promise<void> {
    return new Promise((resolve) => {
        process.stdout.write("\nPress Enter to return to the menu...\n");
        const stdin = process.stdin;
        stdin.resume();
        stdin.once("data", () => { stdin.pause(); resolve(); });
    });
}

/**
 * Build the root TUI component. Separated from the launcher (which owns the render
 * loop) so it can be rendered in isolation for testing. `showActions` adds the hub
 * action entries; `fullscreen` fills the terminal height; `agents`/`protections`
 * feed the native action sub-views; `onLeave` reports the chosen intent.
 */
export function buildApp(
    React: typeof import("react"),
    ink: typeof import("ink"),
    opts: { showActions: boolean; fullscreen: boolean; agents: HubAgent[]; protections: HubProtection[]; onLeave: (intent: LeaveIntent) => void },
) {
    const { useApp, useInput, useStdout } = ink;
    const Box = ink.Box as never;
    const Text = ink.Text as never;
    const { useState, useEffect } = React;
    const h = React.createElement;
    const fill = opts.fullscreen;

    type SideItem =
        | { kind: "category"; catIndex: number; title: string }
        | { kind: "action"; action: "skills" | "security"; title: string; blurb: string };
    const sideItems: SideItem[] = [
        ...CATEGORIES.map((c, i) => ({ kind: "category" as const, catIndex: i, title: c.title })),
        ...(opts.showActions ? ACTION_ITEMS.map((a) => ({ kind: "action" as const, ...a })) : []),
    ];

    return function App() {
        const { exit } = useApp();
        const { stdout } = useStdout();
        const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
        const [mode, setMode] = useState<"menu" | "skills" | "security">("menu");
        const [scope, setScope] = useState<Scope>("global");
        const [sideIndex, setSideIndex] = useState(0);
        const [focusRight, setFocusRight] = useState(false);
        const [setIndex, setSetIndex] = useState(0);
        const [pending, setPending] = useState<Record<string, boolean>>({});
        const [confirm, setConfirm] = useState<{ index: number } | null>(null);
        // Native action sub-view state: cursor, per-item checkbox, and install scope.
        const [actCursor, setActCursor] = useState(0);
        const [actChecked, setActChecked] = useState<Record<string, boolean>>({});
        const [actScope, setActScope] = useState<Scope>("global");

        useEffect(() => {
            const onResize = (): void => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
            stdout.on("resize", onResize);
            return () => { stdout.off("resize", onResize); };
        }, [stdout]);

        const current = sideItems[sideIndex]!;
        const category = current.kind === "category" ? CATEGORIES[current.catIndex]! : null;

        const valueOf = (setting: Setting, sc: Scope): boolean => {
            const k = stageKey(setting.key, sc);
            return k in pending ? pending[k]! : setting.read(sc);
        };
        const isModified = (setting: Setting, sc: Scope): boolean => {
            const k = stageKey(setting.key, sc);
            return k in pending && pending[k] !== setting.read(sc);
        };
        const dirty = Object.entries(pending).some(([k, v]) => {
            const { key, scope: sc } = parseStageKey(k);
            return SETTING_BY_KEY.get(key)?.read(sc) !== v;
        });
        const persistPending = (): void => {
            for (const [k, v] of Object.entries(pending)) {
                const { key, scope: sc } = parseStageKey(k);
                const setting = SETTING_BY_KEY.get(key);
                if (setting && setting.read(sc) !== v) setting.write(v, sc);
            }
        };
        const leave = (intent: LeaveIntent): void => { opts.onLeave(intent); exit(); };

        // Enter a native action sub-view, preselecting sensible defaults.
        const openAction = (action: "skills" | "security"): void => {
            setActCursor(0);
            if (action === "security") {
                setActChecked(Object.fromEntries(opts.protections.map((p) => [p.value, true])));
            } else {
                const detected = opts.agents.filter((a) => a.installed);
                const preselect = detected.length ? detected : opts.agents;
                setActChecked(Object.fromEntries(opts.agents.map((a) => [a.name, preselect.some((d) => d.name === a.name)])));
                setActScope("global");
            }
            setMode(action);
        };

        useInput((input, key) => {
            // --- exit confirmation overlay (unsaved settings) ---
            if (confirm) {
                if (key.escape) { setConfirm(null); return; }
                if (key.upArrow || input === "k") { setConfirm((c) => c && { index: Math.max(0, c.index - 1) }); return; }
                if (key.downArrow || input === "j") { setConfirm((c) => c && { index: Math.min(EXIT_OPTIONS.length - 1, c.index + 1) }); return; }
                if (key.return || input === " ") {
                    const index = confirm.index;
                    setConfirm(null);
                    if (index === 2) return; // cancel
                    if (index === 0) persistPending(); // save & exit
                    setPending({});
                    leave({ action: "quit" });
                }
                return;
            }

            // --- native action sub-views (skills / security) ---
            if (mode !== "menu") {
                const items = mode === "security"
                    ? opts.protections.map((p) => p.value)
                    : opts.agents.map((a) => a.name);
                if (key.escape || input === "q") { setMode("menu"); return; }
                if (mode === "skills" && input === "g") { setActScope((s) => (s === "global" ? "local" : "global")); return; }
                if (key.upArrow || input === "k") { setActCursor((i) => Math.max(0, i - 1)); return; }
                if (key.downArrow || input === "j") { setActCursor((i) => Math.min(items.length - 1, i + 1)); return; }
                if (input === " ") { const k = items[actCursor]!; setActChecked((c) => ({ ...c, [k]: !c[k] })); return; }
                if (key.return) {
                    const chosen = items.filter((k) => actChecked[k]);
                    persistPending(); setPending({}); // don't lose staged settings when leaving
                    if (mode === "security") leave({ action: "security", protections: chosen });
                    else leave({ action: "skills", scope: actScope, agents: chosen });
                }
                return;
            }

            // --- menu (settings categories + action entries) ---
            if (input === "q" || key.escape) { dirty ? setConfirm({ index: 0 }) : leave({ action: "quit" }); return; }
            if (input === "s") { persistPending(); setPending({}); return; }
            if (input === "x") { persistPending(); setPending({}); leave({ action: "quit" }); return; }
            if (input === "g") { setScope((s) => (s === "global" ? "local" : "global")); return; }
            if (key.tab) { if (category) setFocusRight((f) => !f); return; }
            if (key.leftArrow || input === "h") { setFocusRight(false); return; }
            if (key.rightArrow || input === "l") { if (category) setFocusRight(true); return; }
            if (key.upArrow || input === "k") {
                if (focusRight && category) setSetIndex((i) => Math.max(0, i - 1));
                else { setSideIndex((i) => Math.max(0, i - 1)); setSetIndex(0); setFocusRight(false); }
                return;
            }
            if (key.downArrow || input === "j") {
                if (focusRight && category) setSetIndex((i) => Math.min(category.settings.length - 1, i + 1));
                else { setSideIndex((i) => Math.min(sideItems.length - 1, i + 1)); setSetIndex(0); setFocusRight(false); }
                return;
            }
            if (key.return || input === " ") {
                if (current.kind === "action") { openAction(current.action); return; }
                if (!focusRight) { setFocusRight(true); return; }
                const setting = category!.settings[setIndex]!;
                setPending((p) => ({ ...p, [stageKey(setting.key, scope)]: !valueOf(setting, scope) }));
            }
        });

        // --- header ---
        const headerRight = confirm
            ? h(Text, { color: "yellow" }, "unsaved changes")
            : mode === "menu"
                ? h(Box, {}, h(Text, { dimColor: true }, "scope "),
                    h(Text, { bold: true, color: scope === "global" ? "green" : "yellow" }, scope),
                    h(Text, { dimColor: true }, "  (g)"),
                    dirty ? h(Text, { color: "yellow" }, "   * unsaved") : null)
                : h(Text, { dimColor: true }, mode === "skills" ? "install" : "security");
        const titleBar = h(Box, { width: size.columns, paddingX: 1, justifyContent: "space-between" },
            h(Text, { bold: true, color: "cyan" }, "enigma"), headerRight);

        // --- body ---
        let content: import("react").ReactElement;
        if (confirm) {
            content = renderConfirm(h, Box, Text, confirm.index, fill);
        } else if (mode === "security") {
            content = renderChecklist(h, Box, Text, {
                title: "Git security hooks", blurb: "Choose what the commit guard enforces, then press enter.",
                items: opts.protections.map((p) => ({ key: p.value, label: p.label, hint: p.hint })),
                cursor: actCursor, checked: actChecked, fill,
            });
        } else if (mode === "skills") {
            content = renderChecklist(h, Box, Text, {
                title: "Install agent skills", blurb: `Scope ${actScope} (g to change). Choose agents, then press enter.`,
                items: opts.agents.map((a) => ({ key: a.name, label: a.label, hint: a.installed ? "detected" : "not detected" })),
                cursor: actCursor, checked: actChecked, fill,
            });
        } else {
            const sidebarWidth = Math.min(28, Math.max(20, Math.floor(size.columns * 0.3)));
            const panel = category
                ? renderCategoryPanel(h, Box, Text, { category, scope, focusRight, setIndex, valueOf, isModified, fill })
                : renderActionPanel(h, Box, Text, current as Extract<SideItem, { kind: "action" }>);
            content = h(Box, fill ? { flexGrow: 1 } : {}, renderSidebar(h, Box, Text, sideItems, sideIndex, focusRight, sidebarWidth), panel);
        }

        // --- footer ---
        const footerText = confirm
            ? "up/down move    enter select    esc cancel"
            : mode === "security"
                ? "up/down move    space toggle    enter apply    esc back"
                : mode === "skills"
                    ? "up/down move    space toggle    g scope    enter install    esc back"
                    : `up/down move    tab switch    ${category ? "enter toggle    g scope    " : "enter open    "}s save    x save & exit    q quit`;
        const footer = h(Box, { width: size.columns, paddingX: 1 }, h(Text, { dimColor: true }, footerText));

        return h(Box, { width: size.columns, ...(fill ? { height: size.rows } : {}), flexDirection: "column" },
            titleBar, content, footer);
    };
}

/** Left "MENU" column: setting categories and (in hub mode) action entries. */
function renderSidebar(
    h: typeof import("react").createElement, Box: never, Text: never,
    items: Array<{ title: string }>, index: number, focusRight: boolean, width: number,
): import("react").ReactElement {
    return h(Box, {
        flexDirection: "column", borderStyle: "round",
        borderColor: focusRight ? "gray" : "cyan", paddingX: 1, width, marginRight: 1,
    }, [
        h(Text, { key: "__t", bold: true, dimColor: true }, "MENU"),
        ...items.map((it, i) => h(Text, {
            key: String(i), inverse: !focusRight && i === index, color: i === index ? "cyan" : undefined,
        }, ` ${it.title} `)),
    ]);
}

/** Centered confirmation overlay shown when leaving with staged, unsaved edits. */
function renderConfirm(h: typeof import("react").createElement, Box: never, Text: never, index: number, fill: boolean): import("react").ReactElement {
    return h(Box, { justifyContent: "center", ...(fill ? { flexGrow: 1, alignItems: "center" } : {}) },
        h(Box, {
            flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 2, paddingY: 1,
        }, [
            h(Text, { key: "__t", bold: true, color: "yellow" }, "You have unsaved changes"),
            h(Box, { key: "__o", marginTop: 1, flexDirection: "column" },
                EXIT_OPTIONS.map((o, i) => h(Text, { key: o, inverse: i === index, bold: i === index }, ` ${o} `))),
        ]));
}

interface ChecklistState {
    title: string;
    blurb: string;
    items: Array<{ key: string; label: string; hint: string }>;
    cursor: number;
    checked: Record<string, boolean>;
    fill: boolean;
}

/** Native multiselect panel used by the install and security action sub-views. */
function renderChecklist(h: typeof import("react").createElement, Box: never, Text: never, s: ChecklistState): import("react").ReactElement {
    const rows = s.items.map((it, i) => {
        const on = !!s.checked[it.key];
        const selected = i === s.cursor;
        return h(Box, { key: it.key, justifyContent: "space-between" },
            h(Text, { inverse: selected, bold: selected }, ` ${on ? "[x]" : "[ ]"} ${it.label} `),
            h(Text, { dimColor: true }, `${it.hint}  `));
    });
    return h(Box, {
        flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1,
        ...(s.fill ? { flexGrow: 1 } : {}),
    }, [
        h(Text, { key: "__t", bold: true, color: "cyan" }, s.title),
        h(Text, { key: "__bl", dimColor: true }, s.blurb),
        h(Box, { key: "__rows", marginTop: 1, flexDirection: "column" }, rows),
        ...(s.fill ? [h(Box, { key: "__grow", flexGrow: 1 })] : []),
    ]);
}

interface CategoryPanelState {
    category: { title: string; blurb: string; settings: Setting[] };
    scope: Scope;
    focusRight: boolean;
    setIndex: number;
    fill: boolean;
    valueOf(setting: Setting, scope: Scope): boolean;
    isModified(setting: Setting, scope: Scope): boolean;
}

/** Right panel for a settings category: its toggles with live (staged) values. */
function renderCategoryPanel(h: typeof import("react").createElement, Box: never, Text: never, s: CategoryPanelState): import("react").ReactElement {
    const focused = s.category.settings[s.setIndex]!;
    const rows = s.category.settings.map((setting, i) => {
        const on = s.valueOf(setting, s.scope);
        const modified = s.isModified(setting, s.scope);
        const selected = s.focusRight && i === s.setIndex;
        return h(Box, { key: setting.key, justifyContent: "space-between" },
            h(Text, { inverse: selected, bold: selected }, ` ${setting.label}${setting.globalOnly ? "  (global)" : ""} `),
            h(Text, { bold: true, color: modified ? "yellow" : on ? "green" : "gray" }, `${valueLabel(on)}${modified ? " *" : ""} `));
    });

    return h(Box, {
        flexDirection: "column", borderStyle: "round",
        borderColor: s.focusRight ? "cyan" : "gray", paddingX: 1, flexGrow: 1,
    }, [
        h(Text, { key: "__b", bold: true, color: "cyan" }, s.category.title),
        h(Text, { key: "__bl", dimColor: true }, s.category.blurb),
        h(Box, { key: "__rows", marginTop: 1, flexDirection: "column" }, rows),
        ...(s.fill ? [h(Box, { key: "__grow", flexGrow: 1 })] : []),
        h(Text, { key: "__hint", marginTop: 1, dimColor: true, wrap: "truncate-end" }, focused.hint),
    ]);
}

/** Right panel for an action entry: what it does and how to open it. */
function renderActionPanel(
    h: typeof import("react").createElement, Box: never, Text: never,
    item: { title: string; blurb: string },
): import("react").ReactElement {
    return h(Box, {
        flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1, flexGrow: 1,
    }, [
        h(Text, { key: "__t", bold: true, color: "cyan" }, item.title),
        h(Text, { key: "__bl", dimColor: true }, item.blurb),
        h(Text, { key: "__h", marginTop: 1, dimColor: true }, "Press enter to open"),
    ]);
}
