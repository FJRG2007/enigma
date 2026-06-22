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
 * Mouse support: rows carry onMouseDown handlers, and every scrollable list (sidebar,
 * panels, overlays, result view) carries an onMouseScroll handler via wheel(), all
 * reusing the same state setters as the key map (no duplicated logic). OpenTUI
 * enables mouse capture by default (useMouse).
 */

import { CATEGORIES, ALL_SETTINGS, valueLabel, invalidateSettingReads } from "../settings-registry";
import { applyMemoryToggles } from "../skills";
import { onGhTelemetryChange } from "../github";
import { readUsageCached } from "../usage";
import { readConfig } from "../config";
import type { UsageReport } from "../usage";
import type { Scope, Setting } from "../settings-registry";
import type { HubContext, HubAccount, HubExitAction, HubProfile, HubSkill, HubTool, ActionRequest, ActionResult } from "./types";

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
    const renameAccountFn = opts.hub?.renameAccount;
    const update = opts.hub?.update ?? null;
    const firstRun = showActions && Boolean(opts.hub?.firstRun);
    const initialSkills = opts.hub?.skills ?? [];
    const setSkillDiscardedFn = opts.hub?.setSkillDiscarded;
    const tools: HubTool[] = opts.hub?.tools ?? [];
    const initialProfiles = opts.hub?.profiles ?? [];
    const activateProfileFn = opts.hub?.activateProfile;
    const addProfileFn = opts.hub?.addProfile;
    const renameProfileFn = opts.hub?.renameProfile;
    const removeProfileFn = opts.hub?.removeProfile;
    const setProfileAccountFn = opts.hub?.setProfileAccount;
    // The unified Accounts & profiles panel appears when the hub wired either side
    // in; each section renders only when its operations are available.
    const hasAccounts = showActions && Boolean(activateAccount) && initialAccounts.length > 0;
    const hasProfiles = showActions && Boolean(activateProfileFn);
    const hasIdentity = hasAccounts || hasProfiles;

    // Generic searchable-list items (the opencode-model-picker pattern): prefix
    // matches first, then substring matches over value+label+hint.
    interface PickItem { value: string; label: string; hint: string; }
    const filterItems = (items: PickItem[], query: string): PickItem[] => {
        const q = query.trim().toLowerCase();
        if (!q) return items;
        const starts = items.filter((it) => it.value.toLowerCase().startsWith(q) || it.label.toLowerCase().startsWith(q));
        const rest = items.filter((it) => !starts.includes(it) && `${it.value} ${it.label} ${it.hint}`.toLowerCase().includes(q));
        return [...starts, ...rest];
    };
    const toolItems = (): PickItem[] => tools.map((t) => ({ value: t.name, label: t.label, hint: t.name }));
    // No-op fallback for the settings-only TUI, where no action can be invoked.
    const runAction = opts.hub?.runAction
        ?? (async (): Promise<ActionResult> => ({ ok: false, title: "", lines: [] }));

    // ---- render helpers (closures over the primitives) ----

    const txt = (content: string, props: Record<string, unknown> = {}): RNode =>
        h(text, props, content);

    /** Selection-bar style for a highlighted row; `normal` styles the unselected state. */
    const selStyle = (selected: boolean, normal: Record<string, unknown> = {}): Record<string, unknown> =>
        selected ? { bg: SEL_BG, fg: SEL_FG, attributes: BOLD } : normal;

    /**
     * Mouse-wheel props for a list container: route scroll up/down to the same
     * movement handler the arrow keys use (events bubble up from child rows).
     */
    const wheel = (move: (delta: 1 | -1) => void): Record<string, unknown> => ({
        onMouseScroll: (e: MouseEvt) => {
            const dir = e.scroll?.direction;
            if (dir === "up") move(-1);
            else if (dir === "down") move(1);
        },
    });

    const panelBox = (borderColor: string, children: RNode[], extra: Record<string, unknown> = {}): RNode =>
        h(box, { border: true, borderStyle: "rounded", borderColor, flexDirection: "column", paddingLeft: 1, paddingRight: 1, flexGrow: 1, ...extra }, ...children);

    const renderSidebar = (items: Array<{ title: string }>, index: number, focusRight: boolean, width: number, onSelect: (i: number) => void, onMove: (delta: 1 | -1) => void): RNode =>
        h(box, { border: true, borderStyle: "rounded", borderColor: focusRight ? COL.gray : COL.cyan, flexDirection: "column", paddingLeft: 1, paddingRight: 1, width, marginRight: 1, ...wheel(onMove) },
            txt("MENU", { fg: COL.gray, attributes: BOLD }),
            ...items.map((it, i) => txt(` ${it.title} `, {
                ...(!focusRight && i === index
                    ? { bg: SEL_BG, fg: SEL_FG, attributes: BOLD }
                    : { fg: i === index ? COL.cyan : undefined }),
                truncate: true,
                onMouseDown: () => onSelect(i),
            })));

    const renderChecklist = (s: {
        title: string; blurb: string; focused: boolean;
        items: Array<{ key: string; label: string; hint: string; section?: string; hintColor?: string }>;
        cursor: number; checked: Record<string, boolean>;
        onToggle: (i: number) => void; onMove: (delta: 1 | -1) => void;
    }): RNode => {
        // Optional section headers (the identity-panel pattern): emitted whenever a
        // row's `section` differs from the previous row's, so a flat cursor still works.
        const rows: RNode[] = [];
        let lastSection: string | undefined;
        s.items.forEach((it, i) => {
            if (it.section && it.section !== lastSection) {
                rows.push(txt(it.section, { fg: COL.gray, attributes: BOLD, marginTop: lastSection ? 1 : 0 }));
                lastSection = it.section;
            }
            const on = !!s.checked[it.key];
            const selected = s.focused && i === s.cursor;
            rows.push(h(box, { flexDirection: "row", justifyContent: "space-between", onMouseDown: () => s.onToggle(i) },
                txt(` ${on ? "[x]" : "[ ]"} ${it.label} `, selStyle(selected)),
                txt(`${it.hint}  `, { fg: it.hintColor ?? COL.gray })));
        });
        return panelBox(s.focused ? COL.cyan : COL.gray, [
            txt(s.title, { fg: COL.cyan, attributes: BOLD }),
            txt(s.blurb, { fg: COL.gray }),
            h(box, { flexDirection: "column", marginTop: 1 }, ...rows),
        ], wheel(s.onMove));
    };

    // Unified Accounts & profiles panel: both lists share one panel, split by
    // visual section headers, and a single cursor walks the flat row list.
    // Profiles keep their synthetic "(none)" first row (no active profile = each
    // tool uses its own active account); keys act on the row kind under the cursor.
    type IdRow =
        | { kind: "account"; index: number; account: HubAccount }
        | { kind: "profile"; index: number; name: string; label: string; active: boolean; summary: string };
    const renderIdentity = (s: {
        rows: IdRow[]; focused: boolean; cursor: number;
        onSelect: (i: number) => void; onMove: (delta: 1 | -1) => void;
    }): RNode => {
        const items: RNode[] = [];
        let lastKind: IdRow["kind"] | null = null;
        s.rows.forEach((row, i) => {
            if (row.kind !== lastKind) {
                items.push(txt(row.kind === "account" ? "ACCOUNTS" : "PROFILES", { fg: COL.gray, attributes: BOLD, marginTop: lastKind ? 1 : 0 }));
                lastKind = row.kind;
            }
            const selected = s.focused && i === s.cursor;
            if (row.kind === "account") {
                const a = row.account;
                items.push(h(box, { flexDirection: "row", justifyContent: "space-between", onMouseDown: () => s.onSelect(i) },
                    txt(` ${a.active ? "*" : " "} ${a.name} `, selStyle(selected, { fg: a.active ? COL.green : undefined, attributes: a.active ? BOLD : undefined })),
                    txt(`${a.email ?? "not logged in"}   ${a.toolLabel}  `, { fg: a.email ? COL.gray : COL.yellow, truncate: true })));
            } else {
                items.push(h(box, { flexDirection: "row", justifyContent: "space-between", onMouseDown: () => s.onSelect(i) },
                    txt(` ${row.active ? "*" : " "} ${row.label} `, selStyle(selected, { fg: row.active ? COL.green : undefined, attributes: row.active ? BOLD : undefined })),
                    txt(`${row.summary}  `, { fg: COL.gray, truncate: true })));
            }
        });
        const cur = s.rows[s.cursor];
        return panelBox(s.focused ? COL.cyan : COL.gray, [
            txt("Accounts & profiles", { fg: COL.cyan, attributes: BOLD }),
            txt("Per-tool logins; a profile pins one account per tool and drives launches", { fg: COL.gray }),
            h(box, { flexDirection: "column", marginTop: 1 }, ...items),
            h(box, { flexGrow: 1 }),
            txt(cur?.kind === "account" ? ` ${cur.account.dir}` : " ", { fg: COL.gray, truncate: true }),
            txt(cur?.kind === "profile"
                ? "enter set active   a add   e edit accounts   r rename   d remove"
                : "enter set active   c connect/login   a add   r rename   d remove", { fg: COL.gray, marginTop: 1, truncate: true }),
        ], wheel(s.onMove));
    };

    const renderRemoveConfirm = (message: string, index: number, onChoose: (i: number) => void, onMove: (delta: 1 | -1) => void, confirmLabel = "Remove"): RNode =>
        h(box, { flexGrow: 1, justifyContent: "center", alignItems: "center" },
            h(box, { border: true, borderStyle: "rounded", borderColor: COL.red, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, ...wheel(onMove) },
                txt(message, { fg: COL.red, attributes: BOLD }),
                h(box, { flexDirection: "column", marginTop: 1 },
                    ...[confirmLabel, "Cancel"].map((o, i) => txt(` ${o} `, { ...selStyle(i === index), onMouseDown: () => onChoose(i) })))));

    // Name-input overlay for creating an account. The <input> is focused so the
    // renderer routes keystrokes to it; onSubmit fires on Enter. The global key
    // handler short-circuits while this is open so typing does not trigger nav.
    const renderAddInput = (s: { title: string; placeholder: string; error?: string; onSubmit: (value: string) => void }): RNode =>
        h(box, { flexGrow: 1, justifyContent: "center", alignItems: "center" },
            h(box, { border: true, borderStyle: "rounded", borderColor: COL.cyan, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, width: 52 },
                txt(s.title, { fg: COL.cyan, attributes: BOLD }),
                h(box, { border: true, borderStyle: "rounded", borderColor: COL.gray, marginTop: 1 },
                    h(input, { focused: true, placeholder: s.placeholder, maxLength: 64, onSubmit: s.onSubmit })),
                s.error
                    ? txt(s.error, { fg: COL.red, marginTop: 1, truncate: true })
                    : txt("enter confirm   esc cancel", { fg: COL.gray, marginTop: 1 })));

    // Searchable selector (the opencode model-picker pattern): a focused filter
    // input on top, the filtered list below. Typing filters via onInput;
    // navigation/selection stays in the global key handler (up/down/enter), so
    // the input never needs an onSubmit here.
    const renderSearchSelect = (s: {
        title: string; items: PickItem[]; cursor: number; error?: string;
        onQuery: (value: string) => void; onPick: (i: number) => void; onMove: (delta: 1 | -1) => void;
    }): RNode =>
        h(box, { flexGrow: 1, justifyContent: "center", alignItems: "center" },
            h(box, { border: true, borderStyle: "rounded", borderColor: COL.cyan, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, width: 56, ...wheel(s.onMove) },
                txt(s.title, { fg: COL.cyan, attributes: BOLD }),
                h(box, { border: true, borderStyle: "rounded", borderColor: COL.gray, marginTop: 1 },
                    h(input, { focused: true, placeholder: "type to search...", maxLength: 64, onInput: s.onQuery })),
                h(box, { flexDirection: "column", marginTop: 1 },
                    ...(s.items.length
                        ? s.items.map((it, i) => h(box, { flexDirection: "row", justifyContent: "space-between", onMouseDown: () => s.onPick(i) },
                            txt(` ${it.label} `, selStyle(i === s.cursor)),
                            txt(`${it.hint}  `, { fg: COL.gray, truncate: true })))
                        : [txt(" (no matches) ", { fg: COL.yellow })])),
                s.error
                    ? txt(s.error, { fg: COL.red, marginTop: 1, truncate: true })
                    : txt("type to search   up/down move   enter select   esc cancel", { fg: COL.gray, marginTop: 1 })));

    const renderConnectPrompt = (name: string, index: number, onChoose: (i: number) => void, onMove: (delta: 1 | -1) => void): RNode =>
        h(box, { flexGrow: 1, justifyContent: "center", alignItems: "center" },
            h(box, { border: true, borderStyle: "rounded", borderColor: COL.green, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, ...wheel(onMove) },
                txt(`Account '${name}' created. Connect (log in) now?`, { fg: COL.green, attributes: BOLD }),
                h(box, { flexDirection: "column", marginTop: 1 },
                    ...["Connect now", "Later"].map((o, i) => txt(` ${o} `, { ...selStyle(i === index), onMouseDown: () => onChoose(i) })))));

    // List-setting editor overlay (guard block/allow globs, custom secret patterns).
    // A plain list view (no focused input) so single-letter keys work: 'a' opens the
    // add-input overlay, 'd' removes the selected entry. Items also remove on click.
    const renderListEditor = (s: {
        title: string; hint: string; items: string[]; cursor: number;
        onRemove: (i: number) => void; onMove: (delta: 1 | -1) => void;
    }): RNode =>
        h(box, { flexGrow: 1, justifyContent: "center", alignItems: "center" },
            h(box, { border: true, borderStyle: "rounded", borderColor: COL.cyan, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, width: 66, ...wheel(s.onMove) },
                txt(s.title, { fg: COL.cyan, attributes: BOLD }),
                txt(s.hint, { fg: COL.gray, truncate: true }),
                h(box, { flexDirection: "column", marginTop: 1 },
                    ...(s.items.length
                        ? s.items.map((it, i) => h(box, { flexDirection: "row", onMouseDown: () => s.onRemove(i) },
                            txt(` ${it} `, selStyle(i === s.cursor))))
                        : [txt(" (none - using the built-in defaults) ", { fg: COL.gray })])),
                txt("a add   d remove   enter / esc done", { fg: COL.gray, marginTop: 1 })));

    const renderCategoryPanel = (s: {
        category: { title: string; blurb: string; settings: Setting[] };
        scope: Scope; focusRight: boolean; setIndex: number;
        valueOf: (setting: Setting, sc: Scope) => boolean;
        displayValue: (setting: Setting, sc: Scope) => string;
        isModified: (setting: Setting, sc: Scope) => boolean;
        onSelect: (i: number) => void; onMove: (delta: 1 | -1) => void;
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
        ], wheel(s.onMove));
    };

    const renderConfirm = (index: number, onChoose: (i: number) => void, onMove: (delta: 1 | -1) => void): RNode =>
        h(box, { flexGrow: 1, justifyContent: "center", alignItems: "center" },
            h(box, { border: true, borderStyle: "rounded", borderColor: COL.yellow, flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, ...wheel(onMove) },
                txt("You have unsaved changes", { fg: COL.yellow, attributes: BOLD }),
                h(box, { flexDirection: "column", marginTop: 1 },
                    ...EXIT_OPTIONS.map((o, i) => txt(` ${o} `, { ...selStyle(i === index), onMouseDown: () => onChoose(i) })))));

    const renderRunning = (title: string): RNode =>
        panelBox(COL.cyan, [
            txt(title || "Working", { fg: COL.cyan, attributes: BOLD }),
            txt("Working...", { fg: COL.gray, marginTop: 1 }),
            h(box, { flexGrow: 1 }),
        ]);

    // Compact token formatter for the usage panel (e.g. 12.3M, 4.5K).
    const fmtTok = (n: number): string => {
        n = n || 0;
        if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
        if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
        if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
        return String(Math.round(n));
    };
    const usd = (n: number): string => "$" + (n || 0).toFixed(2);

    /** Read-only Claude usage panel: cost + tokens + the 5h block + top models/sessions. */
    const renderUsagePanel = (s: { usageOn: boolean; report: (UsageReport & { pending: boolean }) | null }): RNode => {
        if (!s.usageOn) return panelBox(COL.gray, [
            txt("Claude usage", { fg: COL.cyan, attributes: BOLD }),
            txt("Real tool-usage stats are off.", { fg: COL.yellow, marginTop: 1 }),
            txt("Turn it on to read your Claude Code sessions here:", { fg: COL.gray, marginTop: 1 }),
            txt("  enigma config usage-stats on", { fg: COL.cyan }),
            txt("Only your local session transcripts are read; nothing is sent anywhere.", { fg: COL.gray, marginTop: 1 }),
            h(box, { flexGrow: 1 }),
        ]);
        const u = s.report;
        if (!u || (u.pending && u.messages === 0)) return panelBox(COL.cyan, [
            txt("Claude usage", { fg: COL.cyan, attributes: BOLD }),
            txt(u?.pending ? "Scanning session transcripts..." : "No usage recorded yet.", { fg: COL.gray, marginTop: 1 }),
            h(box, { flexGrow: 1 }),
        ]);
        const models = Object.entries(u.byModel).sort((a, b) => b[1].cost - a[1].cost).slice(0, 6);
        // Reset labels: relative for the session, weekday+time for the weekly windows.
        const relMin = (ms: number): string => {
            const d = ms - Date.now();
            if (d <= 0) return "now";
            const hh = Math.floor(d / 3600000), mm = Math.round((d % 3600000) / 60000);
            return hh ? `in ${hh}h ${mm}m` : `in ${mm}m`;
        };
        const atLabel = (ms: number): string => {
            const dt = new Date(ms);
            const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
            return `${wd} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
        };
        const winLine = (w: UsageReport["windows"]["session"], sonnet: boolean): RNode => {
            const reset = w.kind === "session" ? (w.resetsAt ? `resets ${relMin(w.resetsAt)}` : "no active session") : (w.resetsAt ? `resets ${atLabel(w.resetsAt)}` : "");
            const val = w.pct != null ? `${Math.round(w.pct)}% used`
                : sonnet && (w.used || 0) === 0 ? "not used yet"
                : `${fmtTok(w.used)} tok`;
            return h(box, { flexDirection: "row", justifyContent: "space-between" },
                txt(` ${w.label}${w.live ? " (live)" : ""} `, {}),
                txt(`${val}   ${reset} `, { fg: w.pct != null && w.pct >= 90 ? COL.red : COL.gray }));
        };
        const rows: RNode[] = [
            h(box, { flexDirection: "row", marginTop: 1 },
                txt(`Est. cost ${usd(u.cost)}`, { fg: COL.green, attributes: BOLD }),
                txt(`   in ${fmtTok(u.input)}`, { fg: COL.gray }),
                txt(`   out ${fmtTok(u.output)}`, { fg: COL.gray }),
                txt(`   cache ${fmtTok(u.cacheRead)}`, { fg: COL.gray }),
                txt(`   ${u.sessions} sessions`, { fg: COL.gray })),
            txt("Usage windows (Claude limits)", { fg: COL.gray, attributes: BOLD, marginTop: 1 }),
            winLine(u.windows.session, false),
            winLine(u.windows.weeklyAll, false),
            winLine(u.windows.weeklySonnet, true),
        ];
        if (u.block) {
            const b = u.block;
            const remMin = Math.max(0, Math.round((b.endsAt - Date.now()) / 60000));
            rows.push(txt(
                `5h block: ${fmtTok(b.tokens)} tok  ${usd(b.cost)}  burn ${fmtTok(b.burnRatePerMin)}/min  -> proj ${fmtTok(b.projectedTokens)}  ${b.active ? `(${remMin} min left)` : "(ended)"}`,
                { fg: b.active ? COL.yellow : COL.gray, marginTop: 1 }));
        }
        const accounts = Object.entries(u.byAccount || {}).sort((a, b) => b[1].cost - a[1].cost);
        if (accounts.length) {
            rows.push(txt("By account", { fg: COL.gray, attributes: BOLD, marginTop: 1 }));
            for (const [acct, v] of accounts) {
                rows.push(h(box, { flexDirection: "row", justifyContent: "space-between" },
                    txt(` ${acct} `, { truncate: true }),
                    txt(`${fmtTok(v.input + v.output)} tok   ${usd(v.cost)} `, { fg: COL.gray })));
            }
        }
        rows.push(txt("By model", { fg: COL.gray, attributes: BOLD, marginTop: 1 }));
        for (const [m, v] of models) {
            rows.push(h(box, { flexDirection: "row", justifyContent: "space-between" },
                txt(` ${m} `, { truncate: true }),
                txt(`${fmtTok(v.input + v.output)} tok   ${usd(v.cost)} `, { fg: COL.gray })));
        }
        rows.push(txt("Recent sessions", { fg: COL.gray, attributes: BOLD, marginTop: 1 }));
        for (const r of u.recentSessions.slice(0, 6)) {
            rows.push(h(box, { flexDirection: "row", justifyContent: "space-between" },
                txt(` ${r.project} `, { truncate: true }),
                txt(`${r.model}   ${usd(r.cost)} `, { fg: COL.gray, truncate: true })));
        }
        const provNote = (u.providers || []).map((p) => `${p.label}${p.available ? "" : " (no local usage)"}`).join("  ");
        return panelBox(COL.cyan, [
            txt("Claude usage", { fg: COL.cyan, attributes: BOLD }),
            txt(`Estimated cost from local transcripts${u.pending ? " (refreshing...)" : ""}`, { fg: COL.gray }),
            h(box, { flexDirection: "column" }, ...rows),
            h(box, { flexGrow: 1 }),
            provNote ? txt(provNote, { fg: COL.gray, truncate: true }) : null,
        ]);
    };

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
        | { kind: "identity"; title: string }
        | { kind: "usage"; title: string };
    const sideItems: SideItem[] = [
        ...CATEGORIES.map((c, i) => ({ kind: "category" as const, catIndex: i, title: c.title })),
        // The usage view only makes sense in the full hub (it reads session transcripts).
        ...(showActions ? [{ kind: "usage" as const, title: "Claude usage" }] : []),
        ...(showActions ? ACTION_ITEMS.map((a) => ({ kind: "action" as const, ...a })) : []),
        ...(hasIdentity ? [{ kind: "identity" as const, title: "Accounts & profiles" }] : []),
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
        // Skills rows of the install panel; discarding asks for confirmation because
        // it deletes the deployed copies and opts the skill out of installs/updates.
        const [skills, setSkills] = useState<HubSkill[]>(initialSkills);
        const [skillConfirm, setSkillConfirm] = useState<{ name: string; index: number } | null>(null);
        const [accounts, setAccounts] = useState<HubAccount[]>(initialAccounts);
        // Single cursor over the unified Accounts & profiles rows (accounts first).
        const [idCursor, setIdCursor] = useState(0);
        const [removeConfirm, setRemoveConfirm] = useState<{ tool: string; name: string; index: number } | null>(null);
        // Two-step add flow: pick the tool in a searchable selector, then type the
        // account name. `query`/`cursor` drive the tool step only.
        const [adding, setAdding] = useState<{ step: "tool" | "name"; tool: string; toolLabel: string; query: string; cursor: number; error?: string } | null>(null);
        // Rename overlays: the same name-input dialog as the add flows, pre-targeted
        // at the selected account/profile; errors come back inline from the callback.
        const [renaming, setRenaming] = useState<{ tool: string; toolLabel: string; name: string; error?: string } | null>(null);
        const [profRename, setProfRename] = useState<{ name: string; error?: string } | null>(null);
        const [connectPrompt, setConnectPrompt] = useState<{ tool: string; account: string; index: number } | null>(null);
        const [profiles, setProfiles] = useState<HubProfile[]>(initialProfiles);
        // Profile management overlays: name input, two-step mapping editor
        // (searchable tool -> searchable account incl. "(unpin)"), remove confirm.
        const [profAdd, setProfAdd] = useState<{ error?: string } | null>(null);
        const [profEdit, setProfEdit] = useState<{ profile: string; step: "tool" | "account"; tool: string; toolLabel: string; query: string; cursor: number; error?: string } | null>(null);
        const [profRemove, setProfRemove] = useState<{ name: string; index: number } | null>(null);
        // List-setting editor (guard globs / custom secret patterns): the list view, plus
        // a nested add-input overlay (listAdd) that takes precedence while open.
        const [listEdit, setListEdit] = useState<{ key: string; cursor: number } | null>(null);
        const [listAdd, setListAdd] = useState<{ key: string; error?: string } | null>(null);

        const current = sideItems[sideIndex]!;
        const category = current.kind === "category" ? CATEGORIES[current.catIndex]! : null;
        const action = current.kind === "action" ? current.action : null;
        const identityMode = current.kind === "identity";
        const usageMode = current.kind === "usage";
        const [usage, setUsage] = useState<(UsageReport & { pending: boolean }) | null>(null);
        const usageOn = usageMode ? readConfig().config.usageStats : false;
        // The install panel appends a SKILLS section under the agent checklist; one
        // flat cursor walks both, so the action row count covers agents + skills.
        const skillRows = action === "skills" && setSkillDiscardedFn ? skills : [];
        const actCount = action ? actionItemKeys(action).length + skillRows.length : 0;
        // Profile rows: "(none)" deactivates (each tool falls back to its own active account).
        const profRows = [
            { name: "", label: "(none)", active: !profiles.some((p) => p.active), summary: "each tool uses its own active account" },
            ...profiles.map((p) => ({ name: p.name, label: p.name, active: p.active, summary: p.summary })),
        ];
        // Flat rows of the unified panel: accounts first, then profile rows. The
        // flat index of account i is i; of profile row i it is profFlat(i).
        const idRows: IdRow[] = [
            ...(hasAccounts ? accounts.map((account, index) => ({ kind: "account" as const, index, account })) : []),
            ...(hasProfiles ? profRows.map((r, index) => ({ kind: "profile" as const, index, ...r })) : []),
        ];
        const profFlat = (profIndex: number): number => (hasAccounts ? accounts.length : 0) + profIndex;
        const idRow = idRows[idCursor];

        // Settings render instantly from caches; when gh's background revalidation
        // finds a different real value, bust the read cache and re-render.
        const [, setGhTick] = useState(0);
        useEffect(() => onGhTelemetryChange(() => { invalidateSettingReads(); setGhTick((t) => t + 1); }), []);

        // Load the usage report when the usage view is open (SWR: re-read while it builds).
        useEffect(() => {
            if (!usageMode || !usageOn) { setUsage(null); return; }
            let cancelled = false;
            const tick = (): void => {
                const u = readUsageCached();
                if (cancelled) return;
                setUsage(u);
                if (u.pending) setTimeout(tick, 800);
            };
            tick();
            return () => { cancelled = true; };
        }, [usageMode, usageOn]);

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
            if (setting.kind === "list") return setting.listValues ? setting.listValues(sc).length > 0 : false;
            const st = stagedOf(setting, sc);
            if (st === undefined) return setting.read(sc);
            return setting.choices ? st !== (setting.offChoice ?? "off") : Boolean(st);
        };
        /** Text shown in the row: the count for list settings, the level for choice settings, on/off otherwise. */
        const displayValue = (setting: Setting, sc: Scope): string => {
            if (setting.kind === "list") { const n = setting.listValues ? setting.listValues(sc).length : 0; return n === 0 ? "edit" : `${n} set`; }
            return setting.choices ? choiceOf(setting, sc) : valueLabel(valueOf(setting, sc));
        };
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
            const setting = category.settings[i]!;
            if (focusRight && setIndex === i) {
                if (setting.kind === "list") { setListEdit({ key: setting.key, cursor: 0 }); return; }
                stageNext(setting, scope);
            } else { setFocusRight(true); setSetIndex(i); }
        };
        // List editor: items read fresh (cache busted on write) so the view always
        // reflects disk. Global scope - every list setting is globalOnly.
        const listItemsOf = (key: string): string[] => {
            const s = SETTING_BY_KEY.get(key);
            return s?.listValues ? s.listValues("global") : [];
        };
        const removeListItem = (key: string, i: number): void => {
            const s = SETTING_BY_KEY.get(key);
            const items = listItemsOf(key);
            const it = items[i];
            if (it && s?.removeItem) { s.removeItem(it, "global"); invalidateSettingReads(); }
            setListEdit((e) => e && { ...e, cursor: Math.max(0, Math.min(e.cursor, Math.max(0, items.length - 2))) });
        };
        const submitListAdd = (value: string): void => {
            const item = value.trim();
            const target = listAdd;
            if (!target || !item) { setListAdd(null); return; }
            const s = SETTING_BY_KEY.get(target.key);
            if (s?.addItem) { s.addItem(item, "global"); invalidateSettingReads(); }
            setListAdd(null); // back to the still-open list editor, now showing the new item
        };
        // Toggle the action row at `i`: an agent/protection checkbox, or a skill row.
        // Unchecking a skill discards it (confirmed first - it deletes deployed copies);
        // checking a discarded one restores it immediately (re-deployed by the sync).
        const toggleActRow = (i: number): void => {
            if (!action) return;
            const keys = actionItemKeys(action);
            if (i < keys.length) {
                const k = keys[i]!;
                setActChecked((c) => ({ ...c, [k]: !c[k] }));
                return;
            }
            const skill = skillRows[i - keys.length];
            if (!skill || !setSkillDiscardedFn) return;
            if (skill.discarded) setSkills(setSkillDiscardedFn(skill.name, false));
            else setSkillConfirm({ name: skill.name, index: 0 });
        };
        const chooseSkillDiscard = (i: number): void => {
            const target = skillConfirm;
            setSkillConfirm(null);
            if (i !== 0 || !target || !setSkillDiscardedFn) return;
            setSkills(setSkillDiscardedFn(target.name, true));
        };
        const clickActItem = (i: number): void => {
            if (!action) return;
            setFocusRight(true); setActCursor(i);
            toggleActRow(i);
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
            const total = next.length + (hasProfiles ? profRows.length : 0);
            setIdCursor((c) => Math.max(0, Math.min(c, total - 1)));
        };
        // Connecting needs the tool's own login flow, which needs this terminal -
        // so exit the TUI with a connect action; cli.ts runs the login and reopens.
        const connectSelected = (i: number): void => {
            const acc = accounts[i];
            if (acc) onExit({ type: "connect", tool: acc.tool, account: acc.name });
        };
        // Create flow: searchable tool selector first, then the name input, then
        // (on success) ask whether to log in.
        const startAdd = (): void => {
            if (!addAccountFn || tools.length === 0) return;
            setAdding({ step: "tool", tool: "", toolLabel: "", query: "", cursor: 0 });
        };
        const pickTool = (i: number): void => {
            if (!adding) return;
            const filtered = filterItems(toolItems(), adding.query);
            const sel = filtered[Math.min(i, filtered.length - 1)];
            if (sel) setAdding({ step: "name", tool: sel.value, toolLabel: sel.label, query: "", cursor: 0 });
        };
        const submitAdd = (value: string): void => {
            const name = value.trim();
            if (!addAccountFn || !adding || !name) { setAdding(null); return; }
            const { tool, toolLabel } = adding;
            const res = addAccountFn(tool, name);
            if (!res.ok) { setAdding({ step: "name", tool, toolLabel, query: "", cursor: 0, error: res.error }); return; }
            setAccounts(res.accounts);
            setAdding(null);
            const idx = res.accounts.findIndex((a) => a.tool === tool && a.name === name);
            setIdCursor(idx >= 0 ? idx : 0);
            setConnectPrompt({ tool, account: name, index: 0 });
        };
        // Rename flow: only managed accounts (never a tool's built-in "default").
        const startRename = (i: number): void => {
            const acc = accounts[i];
            if (acc && acc.removable && renameAccountFn) setRenaming({ tool: acc.tool, toolLabel: acc.toolLabel, name: acc.name });
        };
        const submitRename = (value: string): void => {
            const newName = value.trim();
            if (!renameAccountFn || !renaming || !newName) { setRenaming(null); return; }
            const res = renameAccountFn(renaming.tool, renaming.name, newName);
            if (!res.ok) { setRenaming({ ...renaming, error: res.error }); return; }
            setAccounts(res.accounts);
            setRenaming(null);
            const idx = res.accounts.findIndex((a) => a.tool === renaming.tool && a.name === newName);
            setIdCursor(idx >= 0 ? idx : 0);
        };
        const activateProfileRow = (i: number): void => {
            const row = profRows[i];
            if (!row || !activateProfileFn || row.active) return;
            setProfiles(activateProfileFn(row.name));
        };
        // Activate whatever the unified row under the cursor is (enter / second click).
        const activateIdRow = (row: IdRow | undefined): void => {
            if (!row) return;
            if (row.kind === "account") activateSelected(row.index);
            else activateProfileRow(row.index);
        };
        // Profile management: add (name input), edit (tool -> account selectors),
        // remove (confirm). Row 0 is the synthetic "(none)" and is never editable.
        const submitProfAdd = (value: string): void => {
            const name = value.trim();
            if (!addProfileFn || !name) { setProfAdd(null); return; }
            const res = addProfileFn(name);
            if (!res.ok) { setProfAdd({ error: res.error }); return; }
            setProfiles(res.profiles);
            setProfAdd(null);
            const idx = res.profiles.findIndex((p) => p.name === name);
            setIdCursor(profFlat(idx >= 0 ? idx + 1 : 0)); // +1 for the "(none)" row
        };
        const startProfEdit = (i: number): void => {
            const row = profRows[i];
            if (!row || !row.name || !setProfileAccountFn) return;
            setProfEdit({ profile: row.name, step: "tool", tool: "", toolLabel: "", query: "", cursor: 0 });
        };
        const profAccountItems = (tool: string): PickItem[] => [
            { value: "", label: "(unpin)", hint: "remove this tool from the profile" },
            ...accounts.filter((a) => a.tool === tool).map((a) => ({ value: a.name, label: a.name, hint: a.email ?? "" })),
        ];
        const pickProfEdit = (i: number): void => {
            if (!profEdit || !setProfileAccountFn) return;
            if (profEdit.step === "tool") {
                const filtered = filterItems(toolItems(), profEdit.query);
                const sel = filtered[Math.min(i, filtered.length - 1)];
                if (sel) setProfEdit({ profile: profEdit.profile, step: "account", tool: sel.value, toolLabel: sel.label, query: "", cursor: 0 });
                return;
            }
            const filtered = filterItems(profAccountItems(profEdit.tool), profEdit.query);
            const sel = filtered[Math.min(i, filtered.length - 1)];
            if (!sel) return;
            const res = setProfileAccountFn(profEdit.profile, profEdit.tool, sel.value === "" ? null : sel.value);
            if (!res.ok) { setProfEdit({ ...profEdit, error: res.error }); return; }
            setProfiles(res.profiles);
            setProfEdit(null);
        };
        // Profile rename: row 0 is the synthetic "(none)" and can never be renamed.
        const startProfRename = (i: number): void => {
            const row = profRows[i];
            if (row && row.name && renameProfileFn) setProfRename({ name: row.name });
        };
        const submitProfRename = (value: string): void => {
            const newName = value.trim();
            if (!renameProfileFn || !profRename || !newName) { setProfRename(null); return; }
            const res = renameProfileFn(profRename.name, newName);
            if (!res.ok) { setProfRename({ ...profRename, error: res.error }); return; }
            setProfiles(res.profiles);
            setProfRename(null);
            const idx = res.profiles.findIndex((p) => p.name === newName);
            setIdCursor(profFlat(idx >= 0 ? idx + 1 : 0)); // +1 for the "(none)" row
        };
        const requestProfRemove = (i: number): void => {
            const row = profRows[i];
            if (row && row.name && removeProfileFn) setProfRemove({ name: row.name, index: 0 });
        };
        const chooseProfRemove = (i: number): void => {
            const target = profRemove;
            setProfRemove(null);
            if (i !== 0 || !target || !removeProfileFn) return;
            const next = removeProfileFn(target.name);
            setProfiles(next);
            setIdCursor((c) => Math.max(0, Math.min(c, profFlat(next.length)))); // prof rows = profiles + "(none)"
        };
        const chooseConnectPrompt = (i: number): void => {
            const target = connectPrompt;
            setConnectPrompt(null);
            if (i === 0 && target) onExit({ type: "connect", tool: target.tool, account: target.account });
        };
        const clickIdentity = (i: number): void => {
            if (focusRight && idCursor === i) activateIdRow(idRows[i]);
            else { setFocusRight(true); setIdCursor(i); }
        };
        const scrollResult = (dir?: "up" | "down" | "left" | "right"): void => {
            if (dir === "up") setResultScroll((s) => Math.max(0, s - 1));
            else if (dir === "down") setResultScroll((s) => Math.min(maxResultScroll, s + 1));
        };
        // Wheel movers - one per scrollable list, mirroring the arrow-key moves so the
        // wheel and the arrows share the exact same state transitions.
        const moveSide = (delta: 1 | -1): void => {
            setSideIndex((i) => Math.max(0, Math.min(sideItems.length - 1, i + delta)));
            setSetIndex(0); setFocusRight(false);
        };
        const moveSetting = (delta: 1 | -1): void => {
            if (!category) return;
            setFocusRight(true);
            setSetIndex((i) => Math.max(0, Math.min(category.settings.length - 1, i + delta)));
        };
        const moveAct = (delta: 1 | -1): void => {
            if (!action) return;
            setFocusRight(true);
            setActCursor((i) => Math.max(0, Math.min(actCount - 1, i + delta)));
        };
        const moveIdentity = (delta: 1 | -1): void => {
            setFocusRight(true);
            setIdCursor((i) => Math.max(0, Math.min(Math.max(0, idRows.length - 1), i + delta)));
        };
        const moveAddCursor = (delta: 1 | -1): void =>
            setAdding((a) => {
                if (!a || a.step !== "tool") return a;
                const max = Math.max(0, filterItems(toolItems(), a.query).length - 1);
                return { ...a, cursor: Math.max(0, Math.min(max, a.cursor + delta)) };
            });
        const moveProfEditCursor = (delta: 1 | -1): void =>
            setProfEdit((s) => {
                if (!s) return s;
                const items = filterItems(s.step === "tool" ? toolItems() : profAccountItems(s.tool), s.query);
                return { ...s, cursor: Math.max(0, Math.min(Math.max(0, items.length - 1), s.cursor + delta)) };
            });

        useKeyboard((key) => {
            const name = key.name;
            // Ctrl+C is an unconditional clean quit: route it through onExit (which
            // restores the terminal) instead of OpenTUI's exitOnCtrlC path, which would
            // destroy the renderer without resolving our run loop. See createCliRenderer.
            if (key.ctrl && name === "c") { onExit(); return; }
            const up = name === "up", down = name === "down", left = name === "left", right = name === "right";
            const enter = name === "return", esc = name === "escape", tab = name === "tab", space = name === "space";
            const ch = name && name.length === 1 ? name : "";

            // While the add overlay is open, the focused <input> consumes typing
            // (filter query or account name); the global handler only navigates the
            // tool list and cancels - any other key must not trigger hub actions.
            if (adding) {
                if (esc) { setAdding(null); return; }
                if (adding.step === "tool") {
                    const filtered = filterItems(toolItems(), adding.query);
                    if (up) { setAdding({ ...adding, cursor: Math.max(0, adding.cursor - 1) }); return; }
                    if (down) { setAdding({ ...adding, cursor: Math.min(Math.max(0, filtered.length - 1), adding.cursor + 1) }); return; }
                    if (enter) { pickTool(adding.cursor); return; }
                }
                return;
            }

            // Rename overlays: the focused input owns typing; only Escape cancels.
            if (renaming) { if (esc) setRenaming(null); return; }
            if (profRename) { if (esc) setProfRename(null); return; }

            // List add-input overlay (precedes the list editor): focused input owns typing.
            if (listAdd) { if (esc) setListAdd(null); return; }
            // List editor: no focused input, so single-letter keys work directly.
            if (listEdit) {
                const items = listItemsOf(listEdit.key);
                if (esc || enter) { setListEdit(null); return; }
                if (up || ch === "k") { setListEdit({ ...listEdit, cursor: Math.max(0, listEdit.cursor - 1) }); return; }
                if (down || ch === "j") { setListEdit({ ...listEdit, cursor: Math.min(Math.max(0, items.length - 1), listEdit.cursor + 1) }); return; }
                if (ch === "a") { setListAdd({ key: listEdit.key }); return; }
                if (ch === "d" || name === "delete" || name === "backspace") { removeListItem(listEdit.key, listEdit.cursor); return; }
                return;
            }

            // Profile overlays mirror the add-account flow: the focused input owns
            // typing; the global handler only navigates, selects and cancels.
            if (profAdd) { if (esc) setProfAdd(null); return; }
            if (profEdit) {
                if (esc) { setProfEdit(null); return; }
                const items = filterItems(profEdit.step === "tool" ? toolItems() : profAccountItems(profEdit.tool), profEdit.query);
                if (up) { setProfEdit({ ...profEdit, cursor: Math.max(0, profEdit.cursor - 1) }); return; }
                if (down) { setProfEdit({ ...profEdit, cursor: Math.min(Math.max(0, items.length - 1), profEdit.cursor + 1) }); return; }
                if (enter) { pickProfEdit(profEdit.cursor); return; }
                return;
            }
            if (profRemove) {
                if (esc || ch === "n") { setProfRemove(null); return; }
                if (up || ch === "k") { setProfRemove((c) => c && { ...c, index: Math.max(0, c.index - 1) }); return; }
                if (down || ch === "j") { setProfRemove((c) => c && { ...c, index: Math.min(1, c.index + 1) }); return; }
                if (ch === "y") { chooseProfRemove(0); return; }
                if (enter || space) { chooseProfRemove(profRemove.index); return; }
                return;
            }

            if (connectPrompt) {
                if (esc) { setConnectPrompt(null); return; }
                if (up || ch === "k") { setConnectPrompt((c) => c && { ...c, index: Math.max(0, c.index - 1) }); return; }
                if (down || ch === "j") { setConnectPrompt((c) => c && { ...c, index: Math.min(1, c.index + 1) }); return; }
                if (enter || space) { chooseConnectPrompt(connectPrompt.index); return; }
                return;
            }

            if (skillConfirm) {
                if (esc || ch === "n") { setSkillConfirm(null); return; }
                if (up || ch === "k") { setSkillConfirm((c) => c && { ...c, index: Math.max(0, c.index - 1) }); return; }
                if (down || ch === "j") { setSkillConfirm((c) => c && { ...c, index: Math.min(1, c.index + 1) }); return; }
                if (ch === "y") { chooseSkillDiscard(0); return; }
                if (enter || space) { chooseSkillDiscard(skillConfirm.index); return; }
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
            // Unified panel keys act on the row kind under the cursor: section-specific
            // keys (c connect, e edit) are ignored on the other section's rows.
            if (focusRight && identityMode && ch === "a") {
                if (idRow?.kind === "profile") { if (addProfileFn) setProfAdd({}); }
                else startAdd();
                return;
            }
            if (focusRight && identityMode && ch === "c") { if (idRow?.kind === "account") connectSelected(idRow.index); return; }
            if (focusRight && identityMode && ch === "e") { if (idRow?.kind === "profile") startProfEdit(idRow.index); return; }
            if (focusRight && identityMode && ch === "r") {
                if (idRow?.kind === "account") startRename(idRow.index);
                else if (idRow?.kind === "profile") startProfRename(idRow.index);
                return;
            }
            if (focusRight && identityMode && ch === "d") {
                if (idRow?.kind === "account") requestRemove(idRow.index);
                else if (idRow?.kind === "profile") requestProfRemove(idRow.index);
                return;
            }
            if (up || ch === "k") {
                if (focusRight && category) setSetIndex((i) => Math.max(0, i - 1));
                else if (focusRight && action) setActCursor((i) => Math.max(0, i - 1));
                else if (focusRight && identityMode) setIdCursor((i) => Math.max(0, i - 1));
                else { setSideIndex((i) => Math.max(0, i - 1)); setSetIndex(0); setFocusRight(false); }
                return;
            }
            if (down || ch === "j") {
                if (focusRight && category) setSetIndex((i) => Math.min(category.settings.length - 1, i + 1));
                else if (focusRight && action) setActCursor((i) => Math.min(actCount - 1, i + 1));
                else if (focusRight && identityMode) setIdCursor((i) => Math.min(Math.max(0, idRows.length - 1), i + 1));
                else { setSideIndex((i) => Math.min(sideItems.length - 1, i + 1)); setSetIndex(0); setFocusRight(false); }
                return;
            }
            if (space && focusRight && action) { toggleActRow(actCursor); return; }
            if (enter || space) {
                if (!focusRight) { setFocusRight(true); return; }
                if (identityMode) { activateIdRow(idRow); return; }
                if (action) { runChosen(action); return; }
                const setting = category!.settings[setIndex]!;
                if (setting.kind === "list") { setListEdit({ key: setting.key, cursor: 0 }); return; }
                stageNext(setting, scope);
            }
        });

        // header
        const headerRight = adding
            ? txt("new account", { fg: COL.cyan })
            : renaming
            ? txt("rename account", { fg: COL.cyan })
            : profRename
            ? txt("rename profile", { fg: COL.cyan })
            : profAdd
            ? txt("new profile", { fg: COL.cyan })
            : profEdit
            ? txt("edit profile", { fg: COL.cyan })
            : profRemove
            ? txt("remove profile", { fg: COL.red })
            : connectPrompt
            ? txt("connect?", { fg: COL.green })
            : listAdd
            ? txt("add entry", { fg: COL.cyan })
            : listEdit
            ? txt("edit list", { fg: COL.cyan })
            : removeConfirm
            ? txt("remove account", { fg: COL.red })
            : skillConfirm
            ? txt("discard skill", { fg: COL.red })
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
        if (adding && adding.step === "tool") {
            const filtered = filterItems(toolItems(), adding.query);
            content = renderSearchSelect({
                title: "New account - which tool?",
                items: filtered,
                cursor: Math.min(adding.cursor, Math.max(0, filtered.length - 1)),
                onQuery: (value: string) => setAdding((a) => a && { ...a, query: value, cursor: 0 }),
                onPick: pickTool,
                onMove: moveAddCursor,
            });
        } else if (adding) {
            content = renderAddInput({ title: `New ${adding.toolLabel} account name`, placeholder: "e.g. work", error: adding.error, onSubmit: submitAdd });
        } else if (renaming) {
            content = renderAddInput({ title: `Rename ${renaming.toolLabel} account '${renaming.name}'`, placeholder: "new name", error: renaming.error, onSubmit: submitRename });
        } else if (profRename) {
            content = renderAddInput({ title: `Rename profile '${profRename.name}'`, placeholder: "new name", error: profRename.error, onSubmit: submitProfRename });
        } else if (profAdd) {
            content = renderAddInput({ title: "New profile name", placeholder: "e.g. work", error: profAdd.error, onSubmit: submitProfAdd });
        } else if (profEdit) {
            const items = filterItems(profEdit.step === "tool" ? toolItems() : profAccountItems(profEdit.tool), profEdit.query);
            content = renderSearchSelect({
                title: profEdit.step === "tool"
                    ? `Profile '${profEdit.profile}' - which tool?`
                    : `Profile '${profEdit.profile}' - ${profEdit.toolLabel} account`,
                items,
                cursor: Math.min(profEdit.cursor, Math.max(0, items.length - 1)),
                error: profEdit.error,
                onQuery: (value: string) => setProfEdit((s) => s && { ...s, query: value, cursor: 0 }),
                onPick: pickProfEdit,
                onMove: moveProfEditCursor,
            });
        } else if (profRemove) {
            content = renderRemoveConfirm(`Remove profile '${profRemove.name}'? (its accounts are kept)`, profRemove.index, chooseProfRemove,
                (d) => setProfRemove((c) => c && { ...c, index: Math.max(0, Math.min(1, c.index + d)) }));
        } else if (connectPrompt) {
            content = renderConnectPrompt(connectPrompt.account, connectPrompt.index, chooseConnectPrompt,
                (d) => setConnectPrompt((c) => c && { ...c, index: Math.max(0, Math.min(1, c.index + d)) }));
        } else if (removeConfirm) {
            content = renderRemoveConfirm(`Remove account '${removeConfirm.name}' and delete its config dir?`, removeConfirm.index, chooseRemove,
                (d) => setRemoveConfirm((c) => c && { ...c, index: Math.max(0, Math.min(1, c.index + d)) }));
        } else if (skillConfirm) {
            content = renderRemoveConfirm(`Discard skill '${skillConfirm.name}'? It will be removed from all agents and skipped by future installs and updates.`,
                skillConfirm.index, chooseSkillDiscard,
                (d) => setSkillConfirm((c) => c && { ...c, index: Math.max(0, Math.min(1, c.index + d)) }), "Discard");
        } else if (listAdd) {
            const s = SETTING_BY_KEY.get(listAdd.key);
            content = renderAddInput({ title: `Add to ${s?.label ?? listAdd.key}`, placeholder: s?.itemHint ?? "new entry", error: listAdd.error, onSubmit: submitListAdd });
        } else if (listEdit) {
            const s = SETTING_BY_KEY.get(listEdit.key);
            const items = listItemsOf(listEdit.key);
            content = renderListEditor({
                title: s?.label ?? listEdit.key,
                hint: s?.hint ?? "",
                items,
                cursor: Math.min(listEdit.cursor, Math.max(0, items.length - 1)),
                onRemove: (i) => removeListItem(listEdit.key, i),
                onMove: (d) => setListEdit((e) => e && { ...e, cursor: Math.max(0, Math.min(Math.max(0, items.length - 1), e.cursor + d)) }),
            });
        } else if (confirm) {
            content = renderConfirm(confirm.index, chooseConfirm,
                (d) => setConfirm((c) => c && { index: Math.max(0, Math.min(EXIT_OPTIONS.length - 1, c.index + d)) }));
        } else if (mode === "running") {
            content = renderRunning(busyTitle);
        } else if (mode === "result" && result) {
            content = renderResult(result, Math.min(resultScroll, maxResultScroll), resultRows, scrollResult);
        } else {
            const sidebarWidth = Math.min(28, Math.max(20, Math.floor(size.columns * 0.3)));
            const panel = usageMode
                ? renderUsagePanel({ usageOn, report: usage })
                : identityMode
                ? renderIdentity({ rows: idRows, focused: focusRight, cursor: idCursor, onSelect: clickIdentity, onMove: moveIdentity })
                : category
                ? renderCategoryPanel({ category, scope, focusRight, setIndex, valueOf, displayValue, isModified, onSelect: clickSetting, onMove: moveSetting })
                : renderChecklist({
                    title: actionTitle(action!),
                    blurb: action === "skills"
                        ? `Scope ${scope} (g to change). Choose agents, then enter to install; unchecking a skill discards it.`
                        : "Choose what the commit guard enforces, then enter to apply.",
                    items: action === "security"
                        ? protections.map((p) => ({ key: p.value, label: p.label, hint: p.hint }))
                        : [
                            ...agents.map((a) => ({ key: a.name, label: a.label, hint: a.installed ? "detected" : "not detected", section: skillRows.length ? "AGENTS" : undefined })),
                            ...skillRows.map((s) => ({
                                key: `skill:${s.name}`, label: s.name, section: "SKILLS",
                                hint: s.discarded ? "discarded" : s.version ? `v${s.version}` : "",
                                hintColor: s.discarded ? COL.yellow : undefined,
                            })),
                        ],
                    cursor: actCursor,
                    // Skill rows are not staged: checked mirrors the persisted discard state.
                    checked: { ...actChecked, ...Object.fromEntries(skillRows.map((s) => [`skill:${s.name}`, !s.discarded])) },
                    focused: focusRight, onToggle: clickActItem, onMove: moveAct,
                });
            content = h(box, { flexGrow: 1, flexDirection: "row" }, renderSidebar(sideItems, sideIndex, focusRight, sidebarWidth, selectSide, moveSide), panel);
        }

        // footer. A single full-width hint line for overlays/transient modes; in the
        // menu, context nav on the left and the always-available save/exit/quit on the
        // right (split with space-between) so those are visible even while editing.
        const footerLine = (s: string): RNode =>
            h(box, { width: size.columns, paddingLeft: 1, paddingRight: 1 }, txt(s, { fg: COL.gray, attributes: DIM }));
        const menuNav = focusRight && identityMode
            ? (idRow?.kind === "profile"
                ? "up/down move   enter set active   a add   e edit   r rename   d remove   tab back"
                : "up/down move   enter set active   c connect   a add   r rename   d remove   tab back")
            : focusRight && action
            ? (action !== "skills"
                ? "up/down move   space toggle   enter apply   tab back"
                : actCursor >= agents.length && skillRows.length
                ? "up/down move   space discard/restore   enter install   tab back"
                : "up/down move   space toggle   g scope   enter install   tab back")
            : focusRight && category
                ? "up/down move   enter toggle/cycle   g scope   tab back"
                : `up/down move   tab switch   enter ${action || identityMode ? "edit" : "focus"}`;
        let footer: RNode;
        if ((adding && adding.step === "tool") || profEdit) {
            footer = footerLine("type to search   up/down move   enter select   esc cancel");
        } else if (adding || profAdd) {
            footer = footerLine("type a name   enter create   esc cancel");
        } else if (renaming || profRename) {
            footer = footerLine("type the new name   enter rename   esc cancel");
        } else if (listAdd) {
            footer = footerLine("type an entry   enter add   esc cancel");
        } else if (listEdit) {
            footer = footerLine("up/down move   a add   d remove   enter / esc done");
        } else if (profRemove) {
            footer = footerLine("y remove   n / esc cancel");
        } else if (connectPrompt) {
            footer = footerLine("up/down move   enter select   esc later");
        } else if (removeConfirm) {
            footer = footerLine("y remove   n / esc cancel");
        } else if (skillConfirm) {
            footer = footerLine("y discard   n / esc cancel");
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
        const noOverlay = !adding && !renaming && !profRename && !profAdd && !profEdit && !profRemove && !connectPrompt && !removeConfirm && !skillConfirm && !confirm && !listAdd && !listEdit;
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
