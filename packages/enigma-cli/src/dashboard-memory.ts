/**
 * Bridge exposing the agent memory files (CLAUDE.md / AGENTS.md) to the dashboard so a user
 * can customize them in the browser, globally or per project. The domain logic (grouping by
 * deployed path, reading the deployed-or-rendered content, writing an edit, restoring the
 * managed version, and the overwrite/keep sync policy) lives in skills.ts; this is the thin
 * shaping + action layer the loopback server calls.
 *
 * dashboard.ts imports this DYNAMICALLY (only when the memory editor is used), so there is no
 * static import cycle with skills.ts -> dashboard.ts (applyDashboardMode).
 *
 * Security: writes only ever target a memory path enigma itself resolves from the (scope,
 * group-id) pair - a client never supplies a filesystem path. For a project, the path must
 * be a registered project (the caller checks this before delegating here).
 */

import { listMemoryGroups, readMemoryGroup, saveMemoryGroup, resetMemoryGroup, type MemoryGroup } from "./skills";

export interface MemoryActionResult {
    ok: boolean;
    error?: string;
    note?: string;
    /** Present for the "read" action: the file content for the editor. */
    content?: string;
    /** The refreshed group list after a mutating action, so the UI reflects the change. */
    groups?: MemoryGroup[];
}

/** Snapshot the memory files for a scope: global (project undefined) or a project path. */
export function listMemoryForDashboard(project?: string): MemoryGroup[] {
    return listMemoryGroups(project);
}

/**
 * Dispatch a memory-editor action. Never throws.
 *  - read  : return the file content (deployed copy, else the rendered template).
 *  - save  : write custom content to the group's file (marks it edited; keep/overwrite on sync).
 *  - reset : restore the managed (rendered) version, clearing the edit.
 */
export function applyMemoryAction(id: string, action: string, content?: unknown, project?: string): MemoryActionResult {
    if (typeof id !== "string" || !id) return { ok: false, error: "missing memory id" };

    if (action === "read") {
        const c = readMemoryGroup(id, project);
        return c === null ? { ok: false, error: "memory file not found" } : { ok: true, content: c };
    }
    if (action === "save") {
        if (typeof content !== "string") return { ok: false, error: "missing content" };
        const { ok, labels } = saveMemoryGroup(id, content, project);
        return ok
            ? { ok: true, note: `Saved ${labels.join(", ")} memory.`, groups: listMemoryGroups(project) }
            : { ok: false, error: "could not write the memory file" };
    }
    if (action === "reset") {
        const { ok, labels } = resetMemoryGroup(id, project);
        return ok
            ? { ok: true, note: `Restored ${labels.join(", ")} to the managed version.`, groups: listMemoryGroups(project) }
            : { ok: false, error: "no managed version to restore" };
    }
    return { ok: false, error: `unknown action: ${action}` };
}
