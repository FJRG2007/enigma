/**
 * The enigma TUI, built with Ink (React for the terminal). One unified view: a
 * left "MENU" sidebar listing the setting categories and, in hub mode, the action
 * entries (install skills, git hooks); the right panel adapts to the selection.
 * An action's options (agents/scope or guard protections) render as a NATIVE Ink
 * checklist DIRECTLY in the right panel - exactly like a settings category shows
 * its toggles - so they are visible and editable in place (tab/enter/-> to focus,
 * space to toggle, enter to run). No clack prompt is shown inside the TUI, since
 * mixing clack's raw-mode prompts with Ink is unreliable. Running an action is
 * INLINE: installSkills/setupGitHooks write through a buffering reporter (no
 * stdout, which would corrupt the live render) and the outcome is shown in a
 * native result panel; the user returns to the menu with esc/enter. clack is only
 * used when the user runs `enigma install` / `enigma security` directly.
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

/** A skill-install or git-hook action requested from its right-panel checklist. */
export interface ActionRequest {
    action: "skills" | "security";
    scope?: Scope;
    agents?: string[];
    protections?: string[];
}

/** The outcome of a hub action, rendered inline in the native result panel. */
export interface ActionResult {
    ok: boolean;
    title: string;
    lines: string[];
}

/** Minimal agent/protection shapes the hub needs (passed in to avoid heavy imports). */
export interface HubAgent { name: string; label: string; installed: boolean; }
export interface HubProtection { value: string; label: string; hint: string; }
export interface HubContext {
    agents: HubAgent[];
    protections: HubProtection[];
    runAction: (req: ActionRequest) => Promise<ActionResult>;
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

/** The display title for an action, reused by the running and result panels. */
const actionTitle = (action: "skills" | "security"): string =>
    ACTION_ITEMS.find((a) => a.action === action)!.title;

const EXIT_OPTIONS = ["Save & exit", "Exit without saving", "Cancel"] as const;

/** Open the hub TUI (settings + native, inline install/security checklists). */
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
    // No-op fallback for the settings-only TUI, where no action can be invoked.
    const runAction = opts.hub?.runAction
        ?? (async (): Promise<ActionResult> => ({ ok: false, title: "", lines: [] }));

    if (fullscreen) try { process.stdout.write(CLEAR_SCREEN); } catch { /* ignore */ }
    const App = buildApp(React, ink, { showActions: opts.showActions, fullscreen, agents, protections, runAction });
    const app = render(h(App), { exitOnCtrlC: true });
    await app.waitUntilExit();
}

/**
 * Build the root TUI component. Separated from the launcher (which owns the
 * render) so it can be rendered in isolation for testing. `showActions` adds the
 * hub action entries; `fullscreen` fills the terminal height; `agents`/
 * `protections` feed the right-panel checklists; `runAction` executes a chosen
 * action inline and resolves with the result rendered in the result panel.
 */
export function buildApp(
    React: typeof import("react"),
    ink: typeof import("ink"),
    opts: {
        showActions: boolean;
        fullscreen: boolean;
        agents: HubAgent[];
        protections: HubProtection[];
        runAction: (req: ActionRequest) => Promise<ActionResult>;
    },
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

    /** Checklist item keys for an action: agent names (skills) or protection values (security). */
    const actionItemKeys = (action: "skills" | "security"): string[] =>
        action === "security" ? opts.protections.map((pr) => pr.value) : opts.agents.map((a) => a.name);

    type Mode = "menu" | "running" | "result";

    return function App() {
        const { exit } = useApp();
        const { stdout } = useStdout();
        const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
        const [mode, setMode] = useState<Mode>("menu");
        const [scope, setScope] = useState<Scope>("global");
        const [sideIndex, setSideIndex] = useState(0);
        const [focusRight, setFocusRight] = useState(false);
        const [setIndex, setSetIndex] = useState(0);
        const [pending, setPending] = useState<Record<string, boolean>>({});
        const [confirm, setConfirm] = useState<{ index: number } | null>(null);
        // Right-panel checklist state for the selected action: cursor + per-item checkbox.
        const [actCursor, setActCursor] = useState(0);
        const [actChecked, setActChecked] = useState<Record<string, boolean>>({});
        // Inline-execution state: title shown while running, the resolved result,
        // and the result panel's scroll offset (output can exceed the panel height).
        const [busyTitle, setBusyTitle] = useState("");
        const [result, setResult] = useState<ActionResult | null>(null);
        const [resultScroll, setResultScroll] = useState(0);

        useEffect(() => {
            const onResize = (): void => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
            stdout.on("resize", onResize);
            return () => { stdout.off("resize", onResize); };
        }, [stdout]);

        const current = sideItems[sideIndex]!;
        const category = current.kind === "category" ? CATEGORIES[current.catIndex]! : null;
        const action = current.kind === "action" ? current.action : null;

        // Preselect the checklist whenever the selected action changes (detected
        // agents for skills, every protection for security), resetting the cursor.
        useEffect(() => {
            if (!action) return;
            setActCursor(0);
            if (action === "security") {
                setActChecked(Object.fromEntries(opts.protections.map((pr) => [pr.value, true])));
            } else {
                const detected = opts.agents.filter((a) => a.installed);
                const preselect = detected.length ? detected : opts.agents;
                setActChecked(Object.fromEntries(opts.agents.map((a) => [a.name, preselect.some((d) => d.name === a.name)])));
            }
        }, [action]);

        // Visible result lines: in fullscreen the panel has a fixed height, so long
        // output (e.g. a multi-agent install plan) is windowed and scrolled; inline
        // mode lets the terminal scroll naturally, so every line is shown.
        const resultRows = fill ? Math.max(3, size.rows - 7) : (result?.lines.length ?? 0);
        const maxResultScroll = Math.max(0, (result?.lines.length ?? 0) - resultRows);

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

        // Run the selected action inline (no exit) and show its result in the panel.
        const runChosen = (act: "skills" | "security"): void => {
            const keys = actionItemKeys(act);
            const chosen = keys.filter((k) => actChecked[k]);
            const req: ActionRequest = act === "security"
                ? { action: act, protections: chosen }
                : { action: act, scope, agents: chosen };
            persistPending(); setPending({}); // don't lose staged settings while an action runs
            setBusyTitle(actionTitle(act));
            setResult(null);
            setResultScroll(0);
            setMode("running");
            opts.runAction(req)
                .then((res) => { setResult(res); setMode("result"); })
                .catch((err) => { setResult({ ok: false, title: actionTitle(act), lines: [`Error: ${(err as Error).message}`] }); setMode("result"); });
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
                    exit();
                }
                return;
            }

            // --- inline action in progress: ignore input until it resolves ---
            if (mode === "running") return;

            // --- result panel: scroll the buffered output, or return to the menu ---
            if (mode === "result") {
                if (key.return || key.escape || input === " " || input === "q") { setMode("menu"); return; }
                if (key.upArrow || input === "k") { setResultScroll((s) => Math.max(0, s - 1)); return; }
                if (key.downArrow || input === "j") { setResultScroll((s) => Math.min(maxResultScroll, s + 1)); return; }
                return;
            }

            // --- menu: sidebar + right panel (settings toggles or action checklist) ---
            if (input === "q" || key.escape) { dirty ? setConfirm({ index: 0 }) : exit(); return; }
            if (input === "s") { persistPending(); setPending({}); return; }
            if (input === "x") { persistPending(); setPending({}); exit(); return; }
            if (input === "g") { setScope((s) => (s === "global" ? "local" : "global")); return; }
            if (key.tab) { setFocusRight((f) => !f); return; }
            if (key.leftArrow || input === "h") { setFocusRight(false); return; }
            if (key.rightArrow || input === "l") { setFocusRight(true); return; }
            if (key.upArrow || input === "k") {
                if (focusRight && category) setSetIndex((i) => Math.max(0, i - 1));
                else if (focusRight && action) setActCursor((i) => Math.max(0, i - 1));
                else { setSideIndex((i) => Math.max(0, i - 1)); setSetIndex(0); setFocusRight(false); }
                return;
            }
            if (key.downArrow || input === "j") {
                if (focusRight && category) setSetIndex((i) => Math.min(category.settings.length - 1, i + 1));
                else if (focusRight && action) setActCursor((i) => Math.min(actionItemKeys(action).length - 1, i + 1));
                else { setSideIndex((i) => Math.min(sideItems.length - 1, i + 1)); setSetIndex(0); setFocusRight(false); }
                return;
            }
            // space toggles an action checkbox when the checklist is focused.
            if (input === " " && focusRight && action) {
                const k = actionItemKeys(action)[actCursor]!;
                setActChecked((c) => ({ ...c, [k]: !c[k] }));
                return;
            }
            if (key.return || input === " ") {
                if (!focusRight) { setFocusRight(true); return; }
                if (action) { runChosen(action); return; }
                const setting = category!.settings[setIndex]!;
                setPending((pr) => ({ ...pr, [stageKey(setting.key, scope)]: !valueOf(setting, scope) }));
            }
        });

        // --- header ---
        const headerRight = confirm
            ? h(Text, { color: "yellow" }, "unsaved changes")
            : mode === "running"
                ? h(Text, { dimColor: true }, "working")
                : mode === "result"
                    ? h(Text, { dimColor: true }, "result")
                    : h(Box, {}, h(Text, { dimColor: true }, "scope "),
                        h(Text, { bold: true, color: scope === "global" ? "green" : "yellow" }, scope),
                        h(Text, { dimColor: true }, "  (g)"),
                        dirty ? h(Text, { color: "yellow" }, "   * unsaved") : null);
        const titleBar = h(Box, { width: size.columns, paddingX: 1, justifyContent: "space-between" },
            h(Text, { bold: true, color: "cyan" }, "enigma"), headerRight);

        // --- body ---
        let content: import("react").ReactElement;
        if (confirm) {
            content = renderConfirm(h, Box, Text, confirm.index, fill);
        } else if (mode === "running") {
            content = renderRunning(h, Box, Text, busyTitle, fill);
        } else if (mode === "result" && result) {
            content = renderResult(h, Box, Text, { res: result, scroll: Math.min(resultScroll, maxResultScroll), maxRows: resultRows, fill });
        } else {
            const sidebarWidth = Math.min(28, Math.max(20, Math.floor(size.columns * 0.3)));
            const panel = category
                ? renderCategoryPanel(h, Box, Text, { category, scope, focusRight, setIndex, valueOf, isModified, fill })
                : renderChecklist(h, Box, Text, {
                    title: actionTitle(action!),
                    blurb: action === "skills"
                        ? `Scope ${scope} (g to change). Choose agents, then enter to install.`
                        : "Choose what the commit guard enforces, then enter to apply.",
                    items: action === "security"
                        ? opts.protections.map((pr) => ({ key: pr.value, label: pr.label, hint: pr.hint }))
                        : opts.agents.map((a) => ({ key: a.name, label: a.label, hint: a.installed ? "detected" : "not detected" })),
                    cursor: actCursor, checked: actChecked, focused: focusRight, fill,
                });
            content = h(Box, fill ? { flexGrow: 1 } : {}, renderSidebar(h, Box, Text, sideItems, sideIndex, focusRight, sidebarWidth), panel);
        }

        // --- footer ---
        const menuFooter = focusRight && action
            ? (action === "skills"
                ? "up/down move    space toggle    g scope    enter install    tab back"
                : "up/down move    space toggle    enter apply    tab back")
            : focusRight && category
                ? "up/down move    enter toggle    g scope    tab back"
                : `up/down move    tab switch    enter ${action ? "edit" : "focus"}    s save    x save & exit    q quit`;
        const footerText = confirm
            ? "up/down move    enter select    esc cancel"
            : mode === "running"
                ? "working..."
                : mode === "result"
                    ? `${maxResultScroll > 0 ? "up/down scroll    " : ""}enter / esc    back to menu`
                    : menuFooter;
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

/** Transient panel shown while an action runs inline (writes via a buffering reporter). */
function renderRunning(h: typeof import("react").createElement, Box: never, Text: never, title: string, fill: boolean): import("react").ReactElement {
    return h(Box, {
        flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1,
        ...(fill ? { flexGrow: 1 } : {}),
    }, [
        h(Text, { key: "__t", bold: true, color: "cyan" }, title || "Working"),
        h(Text, { key: "__w", marginTop: 1, dimColor: true }, "Working..."),
        ...(fill ? [h(Box, { key: "__grow", flexGrow: 1 })] : []),
    ]);
}

interface ResultState {
    res: ActionResult;
    scroll: number;
    maxRows: number;
    fill: boolean;
}

/**
 * Native panel for an action's outcome: the buffered output lines, colored by
 * success. When the output is taller than `maxRows` (fullscreen), a window of
 * `scroll..scroll+maxRows` lines is shown with "more above/below" markers so the
 * summary is always reachable; otherwise every line is rendered.
 */
function renderResult(h: typeof import("react").createElement, Box: never, Text: never, s: ResultState): import("react").ReactElement {
    const { res, maxRows } = s;
    const windowed = maxRows > 0 && res.lines.length > maxRows;
    const start = windowed ? Math.max(0, Math.min(s.scroll, res.lines.length - maxRows)) : 0;
    const slice = windowed ? res.lines.slice(start, start + maxRows) : res.lines;
    const rows = slice.length
        ? slice.map((line, i) => h(Text, { key: String(start + i), wrap: "truncate-end" }, ` ${line} `))
        : [h(Text, { key: "__none", dimColor: true }, " (no output) ")];
    const above = windowed && start > 0;
    const below = windowed && start + maxRows < res.lines.length;
    return h(Box, {
        flexDirection: "column", borderStyle: "round", borderColor: res.ok ? "green" : "red", paddingX: 1,
        ...(s.fill ? { flexGrow: 1 } : {}),
    }, [
        h(Text, { key: "__t", bold: true, color: res.ok ? "green" : "red" }, res.title),
        h(Text, { key: "__up", dimColor: true }, above ? ` ... ${start} more above ` : " "),
        h(Box, { key: "__rows", flexDirection: "column" }, rows),
        h(Text, { key: "__dn", dimColor: true }, below ? ` ... ${res.lines.length - start - maxRows} more below ` : " "),
        ...(s.fill ? [h(Box, { key: "__grow", flexGrow: 1 })] : []),
    ]);
}

interface ChecklistState {
    title: string;
    blurb: string;
    items: Array<{ key: string; label: string; hint: string }>;
    cursor: number;
    checked: Record<string, boolean>;
    focused: boolean;
    fill: boolean;
}

/**
 * Right-panel multiselect for an action (install agents / guard protections).
 * Mirrors the settings-category panel: border and row highlight only light up
 * when `focused`, so it reads as a live preview while the sidebar has focus.
 */
function renderChecklist(h: typeof import("react").createElement, Box: never, Text: never, s: ChecklistState): import("react").ReactElement {
    const rows = s.items.map((it, i) => {
        const on = !!s.checked[it.key];
        const selected = s.focused && i === s.cursor;
        return h(Box, { key: it.key, justifyContent: "space-between" },
            h(Text, { inverse: selected, bold: selected }, ` ${on ? "[x]" : "[ ]"} ${it.label} `),
            h(Text, { dimColor: true }, `${it.hint}  `));
    });
    return h(Box, {
        flexDirection: "column", borderStyle: "round",
        borderColor: s.focused ? "cyan" : "gray", paddingX: 1, flexGrow: 1,
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
