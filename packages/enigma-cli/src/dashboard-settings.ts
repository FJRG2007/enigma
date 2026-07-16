/**
 * Bridge that exposes the SAME settings registry the TUI uses (settings-registry.ts) to
 * the local dashboard's HTTP API, so a user can configure everything configurable in
 * enigma from the browser instead of the terminal. Pure data + apply layer: it serializes
 * each setting's current value for rendering and writes one setting back, mirroring the
 * CLI's `enigma config` semantics (global scope by default; choice vs. boolean values;
 * memory-affecting toggles re-render the deployed memory file).
 *
 * dashboard.ts imports this DYNAMICALLY (only when the settings panel is used), so there
 * is no static import cycle with settings-registry -> dashboard (applyDashboardMode).
 */

import { CATEGORIES, ALL_SETTINGS, parseBool, type ApplyResult, type Scope } from "./settings-registry";

/** One setting flattened for the browser: its value plus how to render the control. */
export interface UiSetting {
    key: string;
    label: string;
    hint: string;
    globalOnly: boolean;
    affectsMemory: boolean;
    affectsSkills: boolean;
    /** On/off face of the setting (a choice setting is "on" when its value is not offChoice). */
    value: boolean;
    /** Full value set for a choice setting, else null (render a toggle). */
    choices: string[] | null;
    /** Current exact value for a choice setting, else null. */
    choice: string | null;
    /** The choice value that counts as "off". */
    offChoice: string;
    /** "list" for a managed string list (chips editor), else null (toggle/select). */
    kind: "list" | null;
    /** Current items for a list setting, else null. */
    items: string[] | null;
    /** Placeholder/help for a list setting's add input, else null. */
    itemHint: string | null;
}

export interface UiCategory { title: string; blurb: string; settings: UiSetting[]; }

/** The scope each setting is read/written at: globalOnly settings ignore the requested scope. */
function scopeFor(globalOnly: boolean | undefined, scope: Scope): Scope {
    return globalOnly ? "global" : scope;
}

/** Snapshot every registry setting's current value for the given scope (default global). */
export function serializeSettings(scope: Scope = "global"): UiCategory[] {
    return CATEGORIES.map((c) => ({
        title: c.title,
        blurb: c.blurb,
        settings: c.settings.map((s) => {
            const eff = scopeFor(s.globalOnly, scope);
            return {
                key: s.key,
                label: s.label,
                hint: s.hint,
                globalOnly: !!s.globalOnly,
                affectsMemory: !!s.affectsMemory,
                affectsSkills: !!s.affectsSkills,
                value: s.read(eff),
                choices: s.choices ? [...s.choices] : null,
                choice: s.readChoice ? s.readChoice(eff) : null,
                offChoice: s.offChoice ?? "off",
                kind: s.kind === "list" ? "list" : null,
                items: s.kind === "list" && s.listValues ? s.listValues(eff) : null,
                itemHint: s.kind === "list" ? (s.itemHint ?? null) : null,
            };
        }),
    }));
}

export interface ApplyOutcome {
    ok: boolean;
    error?: string;
    key?: string;
    /** The setting re-read after the write, so the UI reflects side effects. */
    setting?: UiSetting;
    /** Present when the write changed a deployed memory file: the agent must restart. */
    restartNote?: string;
}

/**
 * Write one setting, accepting either a choice value (e.g. "ultra") or an on/off boolean,
 * exactly like `enigma config <key> <value>`. Memory-affecting toggles re-render the
 * deployed memory file (loaded lazily so the read path stays cheap). Returns the updated
 * value for the UI, never throws.
 */
export async function applySetting(key: string, value: unknown, scope: Scope = "global"): Promise<ApplyOutcome> {
    const setting = ALL_SETTINGS.find((s) => s.key === key);
    if (!setting) return { ok: false, error: `unknown setting: ${key}` };
    const target = scopeFor(setting.globalOnly, scope);

    // List settings: value is { op: "add" | "remove", item: string }.
    if (setting.kind === "list") {
        const op = value && typeof value === "object" ? value as { op?: string; item?: unknown } : null;
        const item = typeof op?.item === "string" ? op.item.trim() : "";
        if (!op || (op.op !== "add" && op.op !== "remove")) return { ok: false, error: `list setting ${key} needs { op: "add"|"remove", item }` };
        if (!item) return { ok: false, error: "empty item" };
        if (op.op === "add" && setting.addItem) setting.addItem(item, target);
        else if (op.op === "remove" && setting.removeItem) setting.removeItem(item, target);
        const updatedList = serializeSettings(target).flatMap((c) => c.settings).find((s) => s.key === key);
        return { ok: true, key, setting: updatedList };
    }

    // Keep the write's own verdict: a setting backed by another tool's config (gh) can
    // refuse, and re-reading alone cannot tell "refused" from "already that value" - so
    // dropping this reported a write that never happened as saved.
    let result: ApplyResult;
    if (setting.choices && setting.writeChoice && typeof value === "string" && setting.choices.includes(value)) {
        result = setting.writeChoice(value, target);
    } else {
        const b = typeof value === "boolean" ? value : (typeof value === "string" ? parseBool(value) : null);
        if (b === null) return { ok: false, error: `invalid value for ${key}` };
        result = setting.write(b, target);
    }
    if (result?.error) return { ok: false, key, error: result.error };

    let restartNote: string | undefined;
    if (setting.affectsMemory) {
        try {
            const { applyMemoryToggles } = await import("./skills");
            const changed = applyMemoryToggles(target);
            if (changed.length) restartNote = `Updated memory for ${changed.map((a) => a.label).join(", ")} - restart the agent to apply.`;
        } catch { /* best-effort: memory re-render must not fail the write */ }
    }
    if (setting.affectsSkills) {
        try {
            const { applySkillConfig } = await import("./skills");
            const changed = applySkillConfig(target);
            if (changed.length) restartNote = `Updated the skill for ${changed.map((a) => a.label).join(", ")} - restart the agent to apply.`;
        } catch { /* best-effort: skill re-render must not fail the write */ }
    }

    const updated = serializeSettings(target).flatMap((c) => c.settings).find((s) => s.key === key);
    return { ok: true, key, setting: updated, restartNote };
}
