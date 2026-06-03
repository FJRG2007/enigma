/**
 * The hub TUI, rendered with @opentui/react primitives on a native Zig core. This
 * is the only renderer: enigma ships as a Bun-compiled binary (see scripts/
 * build-binaries.ts) that always runs under Bun, so the OpenTUI core is always
 * available. runHomeTui drives the full hub (settings + install/security actions);
 * runSettingsTui drives the settings-only view used by `enigma config`.
 *
 * @opentui/core and @opentui/react load via Bun FFI; every import here is dynamic so
 * non-TUI commands (run under tsx/Node in dev) never resolve the native core at
 * startup, only when a TUI is actually opened.
 *
 * Mouse support: rows carry onMouseDown handlers and the result view an onMouseScroll
 * handler, all reusing the same state setters as the key map (no duplicated logic).
 * OpenTUI enables mouse capture by default (useMouse).
 */

import { CATEGORIES, ALL_SETTINGS, valueLabel, invalidateSettingReads } from "../settings-registry";
import { applyMemoryToggles } from "../skills";
import { onGhTelemetryChange } from "../github";
import type { Scope, Setting } from "../settings-registry";
import type { HubContext, HubAccount, HubExitAction, ActionRequest, ActionResult } from "./types";

/** Rendered tree node (React element or primitive child). */
type RNode = import("react").ReactNode;
/** OpenTUI mouse event, typed via inline import so Node never resolves the native module at runtime. */
type MouseEvt = import("@opentui/core").MouseEvent;

// Hex palette mirroring the Ink TUI's named colors (OpenTUI takes hex/RGBA).
const COL = {
    cyan: "#22d3ee",
    green: "#22c55e",
    yellow: "#eab308",
    red: "#ef4444",
    gray: "#6b7280",
} as const;

// Selection bar: an explicit background + foreground, the way OpenTUI's own Select
// renders selection. The reverse-video attribute was unreliable here - it swaps the
// cell's fg/bg, so on terminals whose defaults differ it can render invisible. An
// explicit teal bar with white text is legible regardless of the terminal theme.
const SEL_BG = "#155e75";
const SEL_FG = "#ffffff";

// Registry lookup + staging-key helpers (mirrors ./settings.ts internals).
const SETTING_BY_KEY = new Map<string, Setting>(ALL_SETTINGS.map((s) => [s.key, s]));
const stageKey = (key: string, scope: Scope): string => `${scope}/${key}`;
const parseStageKey = (composite: string): { key: string; scope: Scope } => {
    const i = composite.indexOf("/");
    return { scope: composite.slice(0, i) as Scope, key: composite.slice(i + 1) };
};

const ACTION_ITEMS: Array<{ action: "skills" | "security"; title: string; blurb: string }> = [
    { action: "skills", title: "Install agent skills", blurb: "Claude Code, Codex, OpenCode" },
    { action: "security", title: "Git security hooks", blurb: "block secrets, .env, node_modules on commit" },
];
const actionTitle = (action: "skills" | "security"): string =>
    ACTION_ITEMS.find((a) => a.action === action)!.title;
const EXIT_OPTIONS = ["Save & exit", "Exit without saving", "Cancel"] as const;

/**
 * Open the OpenTUI hub (settings + native, inline install/security checklists).
 * Resolves with a follow-up action the caller must run after teardown (e.g.
 * connecting an account, which needs the terminal), or null on a plain exit.
 */
export async function runHomeTui(hub: HubContext): Promise<HubExitAction | null> {
    return runTui({ showActions: true, hub });
}

/** Open the settings-only OpenTUI directly (for `enigma config`). */
export async function runSettingsTui(): Promise<void> {
    await runTui({ showActions: false });
}

async function runTui(opts: { showActions: boolean; hub?: HubContext }): Promise<HubExitAction | null> {
    if (!process.stdout.isTTY) return null;

    const React = (await import("react")).default;
    const { createCliRenderer, TextAttributes } = await import("@opentui/core");
    const { createRoot, useKeyboard, useTerminalDimensions } = await import("@opentui/react");

    const h = React.createElement;
    const { useState, useEffect } = React;
    const box = "box" as never;
    const text = "text" as never;
    const input = "input" as never;
    const BOLD = TextAttributes.BOLD;
    const DIM = TextAttributes.DIM;
    const showActions = opts.showActions;
    const agents = opts.hub?.agents ?? [];
    const protections = opts.hub?.protections ?? [];
    const initialAccounts = opts.hub?.accounts ?? [];
    const activateAccount = opts.hub?.activateAccount;
    const removeAccountFn = opts.hub?.removeAccount;
    const addAccountFn = opts.hub?.addAccount;
    const update = opts.hub?.update ?? null;
    const firstRun = showActions && Boolean(opts.hub?.firstRun);
    // The Accounts panel only appears when the hub wired account operations in.
    const hasAccounts = showActions && Boolean(activateAccount) && initialAccounts.length > 0;
    // No-op fallback for the settings-only TUI, where no action can be invoked.
    const runAction = opts.hub?.runAction
        ?? (async (): Promise<ActionResult> => ({ ok: false, title: "", lines: [] }));

    // ---- render helpers (closures over the primitives) ----

    const txt = (content: string, props: Record<string, unknown> = {}): RNode =>
        h(text, props, content);

    /** Selection-bar style for a highlighted row; `normal` styles the unselected state. */
    const selStyle = (selected: boolean, normal: Record<string, unknown> = {}): Record<string, unknown> =>
        selected ? { bg: SEL_BG, fg: SEL_FG, attributes: BOLD } : normal;

    const panelBox = (borderColor: string, children: RNode[], extra: Record<string, unknown> = {}): RNode =>
        h(box, { border: true, borderStyle: "rounded", borderColor, flexDirection: "column", paddingLeft: 1, paddingRight: 1, flexGrow: 1, ...extra }, ...children);

    const renderSidebar = (items: Array<{ title: string }>, index: number, focusRight: boolean, width: number, onSelect: (i: number) => void): RNode =>
        h(box, { border: true, borderStyle: "rounded", borderColor: focusRight ? COL.gray : COL.cyan, flexDirection: "column", paddingLeft: 1, paddingRight: 1, width, marginRight: 1 },
            txt("MENU", { fg: COL.gray, attributes: BOLD }),
            ...items.map((it, i) => txt(` ${it.title} `, {
                ...(!focusRight && i === index
                    ? { bg: SEL_BG, fg: SEL_FG, attributes: BOLD }
                    : { fg: i === index ? COL.cyan : undefined }),
                onMouseDown: () => onSelect(i),
            })));

    const renderChecklist = (s: {
        title: string; blurb: string; focused: boolean;
        items: Array<{ key: string; label: string; hint: string }>;
        cursor: number; checked: Record<string, boolean>;
        onToggle: (i: number) => void;
    }): RNode =>
        panelBox(s.focused ? COL.cyan : COL.gray, [
            txt(s.title, { fg: COL.cyan, attributes: BOLD }),
            txt(s.blurb, { fg: COL.gray }),
            h(box, { flexDirection: "column", marginTop: 1 },
                ...s.items.map((it, i) => {
                    const on = !!s.checked[it.key];
                    const selected = s.focused && i === s.cursor;
                    return h(box, { flexDirection: "row", justifyContent: "space-between", onMouseDown: () => s.onToggle(i) },
                        txt(` ${on ? "[x]" : "[ ]"} ${it.label} `, selStyle(selected)),
                        txt(`${it.hint}  `, { fg: COL.gray }));
                })),
        ]);

    const renderAccounts = (s: {
        accounts: HubAccount[]; focused: boolean; cursor: number;
        onSelect: (i: number) => void;
    }): RNode => {
        const selectedAcc = s.accounts[s.cursor];
        return panelBox(s.focused ? COL.cyan : COL.gray, [
            txt("Accounts", { fg: COL.cyan, attributes: BOLD }),
            txt("Switch login without logging out (per-account config dir)", { fg: COL.gray }),
            h(box, { flexDirection: "column", marginTop: 1 },
                ...s.accounts.map((a, i) => {
                    const selected = s.focused && i === s.cursor;
                    const identity = a.email ?? "not logged in";
                    return h(box, { flexDirection: "row", justifyContent: "space-between", onMouseDown: () => s.onSelect(i) },
                        txt(` ${a.active ? "*" : " "} ${a.name} `, selStyle(selected, { fg: a.active ? COL.green : undefined, attributes: a.active ? BOLD : undefined })),
                        txt(`${identity}   ${a.toolLabel}  `, { fg: a.email ? COL.gray : COL.yellow, truncate: true }));
                })),
            h(box, { flexGrow: 1 }),
            txt(selectedAcc ? ` ${selectedAcc.dir}` : " ", { fg: COL.gray, truncate: true }),
            txt("enter set active   c connect/login   a add   d remove", { fg: COL.gray, marginTop: 1, truncate: true }),
        ]);
    };

    const renderRemoveConfirm = (name: string, index: number, onChoose: (i: number) => void): RNode =>
        h(box, { flexGrow: 1, justifyContent: "center", alignItems: "center" },
            h(box, { border: true, borderStyle: "rounded", borderColor: COL.red, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 },
                txt(`Remove account '${name}' and delete its config dir?`, { fg: COL.red, attributes: BOLD }),
                h(box, { flexDirection: "column", marginTop: 1 },
                    ...["Remove", "Cancel"].map((o, i) => txt(` ${o} `, { ...selStyle(i === index), onMouseDown: () => onChoose(i) })))));

    // Name-input overlay for creating an account. The <input> is focused so the
    // renderer routes keystrokes to it; onSubmit fires on Enter. The global key
    // handler short-circuits while this is open so typing does not trigger nav.
    const renderAddInput = (s: { toolLabel: string; error?: string; onSubmit: (value: string) => void }): RNode =>
        h(box, { flexGrow: 1, justifyContent: "center", alignItems: "center" },
            h(box, { border: true, borderStyle: "rounded", borderColor: COL.cyan, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, width: 52 },
                txt(`New ${s.toolLabel} account name`, { fg: COL.cyan, attributes: BOLD }),
                h(box, { border: true, borderStyle: "rounded", borderColor: COL.gray, marginTop: 1 },
                    h(input, { focused: true, placeholder: "e.g. work", maxLength: 64, onSubmit: s.onSubmit })),
                s.error
                    ? txt(s.error, { fg: COL.red, marginTop: 1, truncate: true })
                    : txt("enter create   esc cancel", { fg: COL.gray, marginTop: 1 })));

    const renderConnectPrompt = (name: string, index: number, onChoose: (i: number) => void): RNode =>
        h(box, { flexGrow: 1, justifyContent: "center", alignItems: "center" },
            h(box, { border: true, borderStyle: "rounded", borderColor: COL.green, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 },
                txt(`Account '${name}' created. Connect (log in) now?`, { fg: COL.green, attributes: BOLD }),
                h(box, { flexDirection: "column", marginTop: 1 },
                    ...["Connect now", "Later"].map((o, i) => txt(` ${o} `, { ...selStyle(i === index), onMouseDown: () => onChoose(i) })))));

    const renderCategoryPanel = (s: {
        category: { title: string; blurb: string; settings: Setting[] };
        scope: Scope; focusRight: boolean; setIndex: number;
        valueOf: (setting: Setting, sc: Scope) => boolean;
        displayValue: (setting: Setting, sc: Scope) => string;
        isModified: (setting: Setting, sc: Scope) => boolean;
        onSelect: (i: number) => void;
    }): RNode => {
        const focusedHint = s.category.settings[s.setIndex]!.hint;
        return panelBox(s.focusRight ? COL.cyan : COL.gray, [
            txt(s.category.title, { fg: COL.cyan, attributes: BOLD }),
            txt(s.category.blurb, { fg: COL.gray }),
            h(box, { flexDirection: "column", marginTop: 1 },
                ...s.category.settings.map((setting, i) => {
                    const on = s.valueOf(setting, s.scope);
                    const shown = s.displayValue(setting, s.scope);
                    const modified = s.isModified(setting, s.scope);
                    const selected = s.focusRight && i === s.setIndex;
                    return h(box, { flexDirection: "row", justifyContent: "space-between", onMouseDown: () => s.onSelect(i) },
                        txt(` ${setting.label}${setting.globalOnly ? "  (global)" : ""} `, selStyle(selected)),
                        txt(`${shown}${modified ? " *" : ""} `, { attributes: BOLD, fg: modified ? COL.yellow : on ? COL.green : COL.gray }));
                })),
            h(box, { flexGrow: 1 }),
            txt(focusedHint, { fg: COL.gray, marginTop: 1, truncate: true }),
        ]);
    };

    const renderConfirm = (index: number, onChoose: (i: number) => void): RNode =>
        h(box, { flexGrow: 1, justifyContent: "center", alignItems: "center" },
            h(box, { border: true, borderStyle: "rounded", borderColor: COL.yellow, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 },
                txt("You have unsaved changes", { fg: COL.yellow, attributes: BOLD }),
                h(box, { flexDirection: "column", marginTop: 1 },
                    ...EXIT_OPTIONS.map((o, i) => txt(` ${o} `, { ...selStyle(i === index), onMouseDown: () => onChoose(i) })))));

    const renderRunning = (title: string): RNode =>
        panelBox(COL.cyan, [
            txt(title || "Working", { fg: COL.cyan, attributes: BOLD }),
            txt("Working...", { fg: COL.gray, marginTop: 1 }),
            h(box, { flexGrow: 1 }),
        ]);

    const renderResult = (res: ActionResult, scroll: number, maxRows: number, onScroll: (dir?: "up" | "down" | "left" | "right") => void): RNode => {
        const windowed = maxRows > 0 && res.lines.length > maxRows;
        const start = windowed ? Math.max(0, Math.min(scroll, res.lines.length - maxRows)) : 0;
        const slice = windowed ? res.lines.slice(start, start + maxRows) : res.lines;
        const above = windowed && start > 0;
        const below = windowed && start + maxRows < res.lines.length;
        const rows = slice.length
            ? slice.map((line, i) => txt(` ${line} `, { key: String(start + i), truncate: true }))
            : [txt(" (no output) ", { fg: COL.gray })];
        return panelBox(res.ok ? COL.green : COL.red, [
            txt(res.title, { fg: res.ok ? COL.green : COL.red, attributes: BOLD }),
            txt(above ? ` ... ${start} more above ` : " ", { fg: COL.gray }),
            h(box, { flexDirection: "column" }, ...rows),
            txt(below ? ` ... ${res.lines.length - start - maxRows} more below ` : " ", { fg: COL.gray }),
            h(box, { flexGrow: 1 }),
        ], { onMouseScroll: (e: MouseEvt) => onScroll(e.scroll?.direction) });
    };

    // ---- the component (state machine mirrors ./settings.ts) ----

    type Mode = "menu" | "running" | "result";
    type SideItem =
        | { kind: "category"; catIndex: number; title: string }
        | { kind: "action"; action: "skills" | "security"; title: string; blurb: string }
        | { kind: "accounts"; title: string };
    const sideItems: SideItem[] = [
        ...CATEGORIES.map((c, i) => ({ kind: "category" as const, catIndex: i, title: c.title })),
        ...(showActions ? ACTION_ITEMS.map((a) => ({ kind: "action" as const, ...a })) : []),
        ...(hasAccounts ? [{ kind: "accounts" as const, title: "Accounts" }] : []),
    ];
    const actionItemKeys = (action: "skills" | "security"): string[] =>
        action === "security" ? protections.map((p) => p.value) : agents.map((a) => a.name);
    // On a first run the install action starts selected, so setup is enter + enter.
    const initialSideIndex = firstRun
        ? Math.max(0, sideItems.findIndex((it) => it.kind === "action" && it.action === "skills"))
        : 0;

    function App({ onExit }: { onExit: (action?: HubExitAction) => void }) {
        const dims = useTerminalDimensions();
        const size = { columns: dims.width || 80, rows: dims.height || 24 };
        const [mode, setMode] = useState<Mode>("menu");
        const [scope, setScope] = useState<Scope>("global");
        const [sideIndex, setSideIndex] = useState(initialSideIndex);
        const [focusRight, setFocusRight] = useState(false);
        const [setIndex, setSetIndex] = useState(0);
        const [pending, setPending] = useState<Record<string, boolean | string>>({});
        const [confirm, setConfirm] = useState<{ index: number } | null>(null);
        const [actCursor, setActCursor] = useState(0);
        const [actChecked, setActChecked] = useState<Record<string, boolean>>({});
        const [busyTitle, setBusyTitle] = useState("");
        const [result, setResult] = useState<ActionResult | null>(null);
        const [resultScroll, setResultScroll] = useState(0);
        // Hides the first-run banner once a skills install succeeded in this session.
        const [setupDone, setSetupDone] = useState(false);
        const [accounts, setAccounts] = useState<HubAccount[]>(initialAccounts);
        const [accCursor, setAccCursor] = useState(0);
        const [removeConfirm, setRemoveConfirm] = useState<{ tool: string; name: string; index: number } | null>(null);
        const [adding, setAdding] = useState<{ tool: string; error?: string } | null>(null);
        const [connectPrompt, setConnectPrompt] = useState<{ tool: string; account: string; index: number } | null>(null);

        const current = sideItems[sideIndex]!;
        const category = current.kind === "category" ? CATEGORIES[current.catIndex]! : null;
        const action = current.kind === "action" ? current.action : null;
        const accountsMode = current.kind === "accounts";

        // Settings render instantly from caches; when gh's background revalidation
        // finds a different real value, bust the read cache and re-render.
        const [, setGhTick] = useState(0);
        useEffect(() => onGhTelemetryChange(() => { invalidateSettingReads(); setGhTick((t) => t + 1); }), []);

        useEffect(() => {
            if (!action) return;
            setActCursor(0);
            if (action === "security") {
                setActChecked(Object.fromEntries(protections.map((p) => [p.value, true])));
            } else {
                const detected = agents.filter((a) => a.installed);
                const preselect = detected.length ? detected : agents;
                setActChecked(Object.fromEntries(agents.map((a) => [a.name, preselect.some((d) => d.name === a.name)])));
            }
        }, [action]);

        const resultRows = Math.max(3, size.rows - 7);
        const maxResultScroll = Math.max(0, (result?.lines.length ?? 0) - resultRows);

        // A staged value is a boolean for on/off toggles or a string (the level) for
        // choice settings. These helpers interpret both kinds uniformly.
        const stagedOf = (setting: Setting, sc: Scope): boolean | string | undefined => {
            const k = stageKey(setting.key, sc);
            return k in pending ? pending[k] : undefined;
        };
        /** Saved (.enigma.json) value to diff staged changes against. */
        const savedOf = (setting: Setting, sc: Scope): boolean | string =>
            setting.choices && setting.readChoice ? setting.readChoice(sc) : setting.read(sc);
        /** Current level of a choice setting (staged or saved). */
        const choiceOf = (setting: Setting, sc: Scope): string => {
            const st = stagedOf(setting, sc);
            return st !== undefined ? String(st) : (setting.readChoice ? setting.readChoice(sc) : "");
        };
        /** On/off face: drives row color and the boolean settings. */
        const valueOf = (setting: Setting, sc: Scope): boolean => {
            const st = stagedOf(setting, sc);
            if (st === undefined) return setting.read(sc);
            return setting.choices ? st !== (setting.offChoice ?? "off") : Boolean(st);
        };
        /** Text shown in the row: the level for choice settings, on/off otherwise. */
        const displayValue = (setting: Setting, sc: Scope): string =>
            setting.choices ? choiceOf(setting, sc) : valueLabel(valueOf(setting, sc));
        const isModified = (setting: Setting, sc: Scope): boolean => {
            const st = stagedOf(setting, sc);
            return st !== undefined && st !== savedOf(setting, sc);
        };
        const dirty = Object.entries(pending).some(([k, v]) => {
            const { key, scope: sc } = parseStageKey(k);
            const setting = SETTING_BY_KEY.get(key);
            return setting ? savedOf(setting, sc) !== v : false;
        });
        // Next value when a row is activated: cycle through choices, or flip a boolean.
        const nextStaged = (setting: Setting, sc: Scope): boolean | string => {
            if (!setting.choices) return !valueOf(setting, sc);
            const i = setting.choices.indexOf(choiceOf(setting, sc));
            return setting.choices[(i + 1) % setting.choices.length]!;
        };
        const stageNext = (setting: Setting, sc: Scope): void =>
            setPending((p) => ({ ...p, [stageKey(setting.key, sc)]: nextStaged(setting, sc) }));
        const persistPending = (): void => {
            const memoryScopes = new Set<Scope>();
            for (const [k, v] of Object.entries(pending)) {
                const { key, scope: sc } = parseStageKey(k);
                const setting = SETTING_BY_KEY.get(key);
                if (!setting || savedOf(setting, sc) === v) continue;
                if (setting.choices && typeof v === "string" && setting.writeChoice) setting.writeChoice(v, sc);
                else setting.write(Boolean(v), sc);
                if (setting.affectsMemory) memoryScopes.add(sc);
            }
            // Memory-affecting settings must re-render the deployed memory file; restart the
            // agent to pick it up (memory loads at startup).
            for (const sc of memoryScopes) applyMemoryToggles(sc);
        };

        const runChosen = (act: "skills" | "security"): void => {
            const chosen = actionItemKeys(act).filter((k) => actChecked[k]);
            const req: ActionRequest = act === "security"
                ? { action: act, protections: chosen }
                : { action: act, scope, agents: chosen };
            persistPending(); setPending({});
            setBusyTitle(actionTitle(act));
            setResult(null);
            setResultScroll(0);
            setMode("running");
            runAction(req)
                .then((res) => { if (act === "skills" && res.ok) setSetupDone(true); setResult(res); setMode("result"); })
                .catch((err) => { setResult({ ok: false, title: actionTitle(act), lines: [`Error: ${(err as Error).message}`] }); setMode("result"); });
        };

        // Mouse handlers - each mirrors the equivalent keyboard action, reusing the same
        // setters so there is a single source of truth for state transitions.
        const selectSide = (i: number): void => { setSideIndex(i); setSetIndex(0); setFocusRight(false); };
        const clickSetting = (i: number): void => {
            if (!category) return;
            if (focusRight && setIndex === i) {
                stageNext(category.settings[i]!, scope);
            } else { setFocusRight(true); setSetIndex(i); }
        };
        const clickActItem = (i: number): void => {
            if (!action) return;
            const k = actionItemKeys(action)[i]!;
            setFocusRight(true); setActCursor(i);
            setActChecked((c) => ({ ...c, [k]: !c[k] }));
        };
        const chooseConfirm = (i: number): void => {
            setConfirm(null);
            if (i === 2) return;
            if (i === 0) persistPending();
            setPending({});
            onExit();
        };
        // Account operations call back into the data layer (via the hub) and replace the
        // local list with the refreshed result, so the panel always reflects truth on disk.
        const activateSelected = (i: number): void => {
            const acc = accounts[i];
            if (!acc || acc.active || !activateAccount) return;
            setAccounts(activateAccount(acc.tool, acc.name));
        };
        const requestRemove = (i: number): void => {
            const acc = accounts[i];
            if (acc && acc.removable && removeAccountFn) setRemoveConfirm({ tool: acc.tool, name: acc.name, index: 0 });
        };
        const chooseRemove = (i: number): void => {
            const target = removeConfirm;
            setRemoveConfirm(null);
            if (i !== 0 || !target || !removeAccountFn) return;
            const next = removeAccountFn(target.tool, target.name);
            setAccounts(next);
            setAccCursor((c) => Math.max(0, Math.min(c, next.length - 1)));
        };
        // Connecting needs the tool's own login flow, which needs this terminal -
        // so exit the TUI with a connect action; cli.ts runs the login and reopens.
        const connectSelected = (i: number): void => {
            const acc = accounts[i];
            if (acc) onExit({ type: "connect", tool: acc.tool, account: acc.name });
        };
        // Create flow: open the name input, then (on success) ask whether to log in.
        const startAdd = (i: number): void => {
            if (!addAccountFn) return;
            setAdding({ tool: accounts[i]?.tool ?? "claude" });
        };
        const submitAdd = (value: string): void => {
            const name = value.trim();
            const tool = adding?.tool ?? "claude";
            if (!addAccountFn || !name) { setAdding(null); return; }
            const res = addAccountFn(tool, name);
            if (!res.ok) { setAdding({ tool, error: res.error }); return; }
            setAccounts(res.accounts);
            setAdding(null);
            const idx = res.accounts.findIndex((a) => a.tool === tool && a.name === name);
            setAccCursor(idx >= 0 ? idx : 0);
            setConnectPrompt({ tool, account: name, index: 0 });
        };
        const chooseConnectPrompt = (i: number): void => {
            const target = connectPrompt;
            setConnectPrompt(null);
            if (i === 0 && target) onExit({ type: "connect", tool: target.tool, account: target.account });
        };
        const clickAccount = (i: number): void => {
            if (focusRight && accCursor === i) activateSelected(i);
            else { setFocusRight(true); setAccCursor(i); }
        };
        const scrollResult = (dir?: "up" | "down" | "left" | "right"): void => {
            if (dir === "up") setResultScroll((s) => Math.max(0, s - 1));
            else if (dir === "down") setResultScroll((s) => Math.min(maxResultScroll, s + 1));
        };

        useKeyboard((key) => {
            const name = key.name;
            // Ctrl+C is an unconditional clean quit: route it through onExit (which
            // restores the terminal) instead of OpenTUI's exitOnCtrlC path, which would
            // destroy the renderer without resolving our run loop. See createCliRenderer.
            if (key.ctrl && name === "c") { onExit(); return; }
            const up = name === "up", down = name === "down", left = name === "left", right = name === "right";
            const enter = name === "return", esc = name === "escape", tab = name === "tab", space = name === "space";
            const ch = name && name.length === 1 ? name : "";

            // While the name input is open, the focused <input> consumes typing and
            // fires onSubmit on Enter; the global handler must stay out of the way
            // (only Escape cancels) or letters like q/s/x would trigger hub actions.
            if (adding) { if (esc) setAdding(null); return; }

            if (connectPrompt) {
                if (esc) { setConnectPrompt(null); return; }
                if (up || ch === "k") { setConnectPrompt((c) => c && { ...c, index: Math.max(0, c.index - 1) }); return; }
                if (down || ch === "j") { setConnectPrompt((c) => c && { ...c, index: Math.min(1, c.index + 1) }); return; }
                if (enter || space) { chooseConnectPrompt(connectPrompt.index); return; }
                return;
            }

            if (removeConfirm) {
                if (esc || ch === "n") { setRemoveConfirm(null); return; }
                if (up || ch === "k") { setRemoveConfirm((c) => c && { ...c, index: Math.max(0, c.index - 1) }); return; }
                if (down || ch === "j") { setRemoveConfirm((c) => c && { ...c, index: Math.min(1, c.index + 1) }); return; }
                if (ch === "y") { chooseRemove(0); return; }
                if (enter || space) { chooseRemove(removeConfirm.index); return; }
                return;
            }

            if (confirm) {
                if (esc) { setConfirm(null); return; }
                if (up || ch === "k") { setConfirm((c) => c && { index: Math.max(0, c.index - 1) }); return; }
                if (down || ch === "j") { setConfirm((c) => c && { index: Math.min(EXIT_OPTIONS.length - 1, c.index + 1) }); return; }
                if (enter || space) {
                    const index = confirm.index;
                    setConfirm(null);
                    if (index === 2) return;
                    if (index === 0) persistPending();
                    setPending({});
                    onExit();
                }
                return;
            }

            if (mode === "running") return;

            if (mode === "result") {
                if (enter || esc || space || ch === "q") { setMode("menu"); return; }
                if (up || ch === "k") { setResultScroll((s) => Math.max(0, s - 1)); return; }
                if (down || ch === "j") { setResultScroll((s) => Math.min(maxResultScroll, s + 1)); return; }
                return;
            }

            if (update && ch === "u") { onExit({ type: "update" }); return; }
            if (ch === "q" || esc) { dirty ? setConfirm({ index: 0 }) : onExit(); return; }
            if (ch === "s") { persistPending(); setPending({}); return; }
            if (ch === "x") { persistPending(); setPending({}); onExit(); return; }
            if (ch === "g") { setScope((s) => (s === "global" ? "local" : "global")); return; }
            if (tab) { setFocusRight((f) => !f); return; }
            if (left || ch === "h") { setFocusRight(false); return; }
            if (right || ch === "l") { setFocusRight(true); return; }
            if (focusRight && accountsMode && ch === "d") { requestRemove(accCursor); return; }
            if (focusRight && accountsMode && ch === "c") { connectSelected(accCursor); return; }
            if (focusRight && accountsMode && ch === "a") { startAdd(accCursor); return; }
            if (up || ch === "k") {
                if (focusRight && category) setSetIndex((i) => Math.max(0, i - 1));
                else if (focusRight && action) setActCursor((i) => Math.max(0, i - 1));
                else if (focusRight && accountsMode) setAccCursor((i) => Math.max(0, i - 1));
                else { setSideIndex((i) => Math.max(0, i - 1)); setSetIndex(0); setFocusRight(false); }
                return;
            }
            if (down || ch === "j") {
                if (focusRight && category) setSetIndex((i) => Math.min(category.settings.length - 1, i + 1));
                else if (focusRight && action) setActCursor((i) => Math.min(actionItemKeys(action).length - 1, i + 1));
                else if (focusRight && accountsMode) setAccCursor((i) => Math.min(accounts.length - 1, i + 1));
                else { setSideIndex((i) => Math.min(sideItems.length - 1, i + 1)); setSetIndex(0); setFocusRight(false); }
                return;
            }
            if (space && focusRight && action) {
                const k = actionItemKeys(action)[actCursor]!;
                setActChecked((c) => ({ ...c, [k]: !c[k] }));
                return;
            }
            if (enter || space) {
                if (!focusRight) { setFocusRight(true); return; }
                if (accountsMode) { activateSelected(accCursor); return; }
                if (action) { runChosen(action); return; }
                stageNext(category!.settings[setIndex]!, scope);
            }
        });

        // header
        const headerRight = adding
            ? txt("new account", { fg: COL.cyan })
            : connectPrompt
            ? txt("connect?", { fg: COL.green })
            : removeConfirm
            ? txt("remove account", { fg: COL.red })
            : confirm
            ? txt("unsaved changes", { fg: COL.yellow })
            : mode === "running"
                ? txt("working", { fg: COL.gray })
                : mode === "result"
                    ? txt("result", { fg: COL.gray })
                    : h(box, { flexDirection: "row" },
                        txt("scope ", { fg: COL.gray }),
                        txt(scope, { fg: scope === "global" ? COL.green : COL.yellow, attributes: BOLD }),
                        txt("  (g)", { fg: COL.gray }),
                        dirty ? txt("   * unsaved", { fg: COL.yellow }) : null);
        const titleBar = h(box, { width: size.columns, flexDirection: "row", paddingLeft: 1, paddingRight: 1, justifyContent: "space-between" },
            txt("enigma", { fg: COL.cyan, attributes: BOLD }), headerRight);

        // body
        let content: RNode;
        if (adding) {
            const toolLabel = accounts.find((a) => a.tool === adding.tool)?.toolLabel ?? adding.tool;
            content = renderAddInput({ toolLabel, error: adding.error, onSubmit: submitAdd });
        } else if (connectPrompt) {
            content = renderConnectPrompt(connectPrompt.account, connectPrompt.index, chooseConnectPrompt);
        } else if (removeConfirm) {
            content = renderRemoveConfirm(removeConfirm.name, removeConfirm.index, chooseRemove);
        } else if (confirm) {
            content = renderConfirm(confirm.index, chooseConfirm);
        } else if (mode === "running") {
            content = renderRunning(busyTitle);
        } else if (mode === "result" && result) {
            content = renderResult(result, Math.min(resultScroll, maxResultScroll), resultRows, scrollResult);
        } else {
            const sidebarWidth = Math.min(28, Math.max(20, Math.floor(size.columns * 0.3)));
            const panel = accountsMode
                ? renderAccounts({ accounts, focused: focusRight, cursor: accCursor, onSelect: clickAccount })
                : category
                ? renderCategoryPanel({ category, scope, focusRight, setIndex, valueOf, displayValue, isModified, onSelect: clickSetting })
                : renderChecklist({
                    title: actionTitle(action!),
                    blurb: action === "skills"
                        ? `Scope ${scope} (g to change). Choose agents, then enter to install.`
                        : "Choose what the commit guard enforces, then enter to apply.",
                    items: action === "security"
                        ? protections.map((p) => ({ key: p.value, label: p.label, hint: p.hint }))
                        : agents.map((a) => ({ key: a.name, label: a.label, hint: a.installed ? "detected" : "not detected" })),
                    cursor: actCursor, checked: actChecked, focused: focusRight, onToggle: clickActItem,
                });
            content = h(box, { flexGrow: 1, flexDirection: "row" }, renderSidebar(sideItems, sideIndex, focusRight, sidebarWidth, selectSide), panel);
        }

        // footer. A single full-width hint line for overlays/transient modes; in the
        // menu, context nav on the left and the always-available save/exit/quit on the
        // right (split with space-between) so those are visible even while editing.
        const footerLine = (s: string): RNode =>
            h(box, { width: size.columns, paddingLeft: 1, paddingRight: 1 }, txt(s, { fg: COL.gray, attributes: DIM }));
        const menuNav = focusRight && accountsMode
            ? "up/down move   enter set active   c connect   a add   d remove   tab back"
            : focusRight && action
            ? (action === "skills"
                ? "up/down move   space toggle   g scope   enter install   tab back"
                : "up/down move   space toggle   enter apply   tab back")
            : focusRight && category
                ? "up/down move   enter toggle/cycle   g scope   tab back"
                : `up/down move   tab switch   enter ${action || accountsMode ? "edit" : "focus"}`;
        let footer: RNode;
        if (adding) {
            footer = footerLine("type a name   enter create   esc cancel");
        } else if (connectPrompt) {
            footer = footerLine("up/down move   enter select   esc later");
        } else if (removeConfirm) {
            footer = footerLine("y remove   n / esc cancel");
        } else if (confirm) {
            footer = footerLine("up/down move   enter select   esc cancel");
        } else if (mode === "running") {
            footer = footerLine("working...");
        } else if (mode === "result") {
            footer = footerLine(`${maxResultScroll > 0 ? "up/down scroll   " : ""}enter / esc   back to menu`);
        } else {
            footer = h(box, { width: size.columns, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 },
                txt(menuNav, { fg: COL.gray, attributes: DIM }),
                txt(`${update ? "u update   " : ""}s save   x save & exit   q quit`, { fg: COL.gray, attributes: DIM }));
        }

        // A one-line "update available" banner under the title, shown only in the plain
        // menu view (not over an overlay or the result/running panels).
        const noOverlay = !adding && !connectPrompt && !removeConfirm && !confirm;
        const updateBanner = update && mode === "menu" && noOverlay
            ? h(box, { width: size.columns, flexDirection: "row", paddingLeft: 1, paddingRight: 1 },
                txt(`Update available  ${update.current} -> ${update.latest}   `, { fg: COL.yellow, attributes: BOLD }),
                txt("press u to update now", { fg: COL.gray }))
            : null;
        // First-run guidance: nothing deployed yet, so point at the preselected install
        // action. Disappears once a skills install succeeds in this session.
        const setupBanner = firstRun && !setupDone && mode === "menu" && noOverlay
            ? h(box, { width: size.columns, flexDirection: "row", paddingLeft: 1, paddingRight: 1 },
                txt("First run - no agent skills deployed yet.   ", { fg: COL.yellow, attributes: BOLD }),
                txt("'Install agent skills' is selected: press enter to pick agents, enter again to install", { fg: COL.gray }))
            : null;

        return h(box, { width: size.columns, height: size.rows, flexDirection: "column" }, titleBar, updateBanner, setupBanner, content, footer);
    }

    // Warp does not fully support the alternate screen buffer: leaving it on exit can
    // close the Warp tab. Render on the main screen there (other terminals keep the
    // cleaner full-screen enter/exit). OTUI_USE_ALTERNATE_SCREEN overrides either way.
    const isWarp = process.env.TERM_PROGRAM === "WarpTerminal";
    // exitOnCtrlC:false - we handle Ctrl+C (and q) ourselves so quitting always runs
    // the full teardown (unmount + destroy) and resolves cleanly. OpenTUI's built-in
    // exitOnCtrlC would destroy the renderer without resolving this run loop.
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        screenMode: isWarp ? "main-screen" : "alternate-screen",
    });
    return new Promise<HubExitAction | null>((resolve) => {
        const root = createRoot(renderer);
        const onExit = (action?: HubExitAction): void => {
            try { root.unmount(); } catch { /* ignore */ }
            try { renderer.destroy(); } catch { /* ignore */ }
            resolve(action ?? null);
        };
        root.render(h(App, { onExit }));
    });
}
