/**
 * The rows every context menu on a desktop already has: Copy, Cut and Paste.
 *
 * A menu opened over a selection or over a field is expected to offer them - the browser's own
 * does, and replacing that menu with a custom one takes them away without saying so. Which is
 * why they are ON by default here and turned off with a prop, rather than the other way round:
 * the defect is silent, so the default has to be the safe one.
 *
 * WHAT DECIDES THEY APPEAR is what was right-clicked, and it is read at the moment the menu
 * opens, not from React state - by then the selection is settled (a `contextmenu` event fires
 * after the press has adjusted it) and the caret is still where the visitor left it.
 *
 * - **Copy**, when there is selected text under the pointer.
 * - **Cut**, when that selection is also in something writable.
 * - **Paste**, in anything writable - and disabled when the clipboard is known to be empty.
 *
 * Not a React module: what a selection is, whether a field takes writes, and how text is put
 * back into one are DOM questions, so a menu drawn by anything else gets the same rows.
 */

import type { ContextMenuEntry } from "@/core/context-menu";

/** The ids these rows carry. Namespaced, so they can never collide with a caller's own. */
export const CLIPBOARD_PREFIX = "enigma:clipboard:";

export type ClipboardAction = "copy" | "cut" | "paste";

/**
 * Input types with a text selection.
 *
 * An allowlist rather than a guess: reading `selectionStart` on `number`, `date`, `color` or
 * `email` throws `InvalidStateError` in every browser, because the spec only defines the
 * selection API for these five. A try/catch would hide it; knowing which is which is better.
 */
const SELECTABLE_TYPES = new Set(["text", "search", "url", "tel", "password"]);

/** What the menu was opened over, as far as the clipboard is concerned. */
export interface ClipboardTarget {
    /** The field or contenteditable under the pointer, or null when it is neither. */
    editable: HTMLElement | null;
    /** Whether that element takes writes: not disabled, not read-only. */
    writable: boolean;
    /** The selected text, from the field's own selection or the document's. */
    selection: string;
    /**
     * Whether that text may be put on the clipboard.
     *
     * False for a password field. The clipboard is shared with every other application on the
     * machine and is not cleared, so a menu that copies a password out of a masked field
     * leaks it somewhere the visitor cannot see - and the browser's own menu refuses too.
     */
    copyable: boolean;
    /** Where the selection was, so it can be put back after the menu has taken focus. */
    range: { start: number; end: number; } | null;
}

export interface ClipboardMenuLabels {
    copy?: string;
    cut?: string;
    paste?: string;
}

export interface ClipboardMenuOptions {
    copy?: boolean;
    cut?: boolean;
    paste?: boolean;
    labels?: ClipboardMenuLabels;
    /** Whatever the renderer draws icons with. `unknown`, because a core cannot know. */
    icons?: { copy?: unknown; cut?: unknown; paste?: unknown; };
    /** The clipboard is known to be empty, so Paste is listed and greyed rather than missing. */
    clipboardEmpty?: boolean;
}

const EMPTY: ClipboardTarget = { editable: null, writable: false, selection: "", copyable: true, range: null };

function isEditableElement(node: Element | null): node is HTMLElement {
    return Boolean(node && (node as HTMLElement).isContentEditable);
}

/** The text selected in the document, but only where it touches the element clicked on. */
function documentSelection(element: Element | null): string {
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
    const range = selection.getRangeAt(0);
    // Selected text elsewhere on the page is not what this menu is over: a right-click away
    // from a selection offers to copy something the visitor is not pointing at.
    if (element && !range.intersectsNode(element)) return "";
    return selection.toString();
}

/** What was right-clicked, read the moment the menu opens. */
export function inspectClipboardTarget(node: EventTarget | null): ClipboardTarget {
    if (typeof document === "undefined") return EMPTY;
    const element = node instanceof Element ? node : null;

    const field = element?.closest?.("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
    if (field) {
        const password = field instanceof HTMLInputElement && field.type === "password";
        const selectable = field instanceof HTMLTextAreaElement || SELECTABLE_TYPES.has(field.type);
        const start = selectable ? field.selectionStart ?? 0 : 0;
        const end = selectable ? field.selectionEnd ?? 0 : 0;
        return {
            editable: field,
            writable: !field.disabled && !field.readOnly,
            selection: selectable ? field.value.slice(start, end) : "",
            copyable: !password,
            range: selectable ? { start, end } : null
        };
    }

    const editable = isEditableElement(element) ? (element.closest("[contenteditable]") as HTMLElement | null) ?? element : null;
    return {
        editable,
        writable: Boolean(editable),
        selection: documentSelection(element),
        copyable: true,
        // A contenteditable's selection is a live DOM Range the browser keeps for us; there is
        // no pair of offsets to restore, and re-focusing the element puts the caret back.
        range: null
    };
}

/**
 * Whether the clipboard has text in it, or null when that cannot be known.
 *
 * Null is the common answer and not a failure: reading the clipboard needs permission, and
 * asking for it puts a browser prompt on screen just to decide whether to grey out a row -
 * which is a worse trade than showing an enabled Paste that turns out to do nothing. So the
 * permission is only READ, never requested, and the clipboard is only opened where it has
 * already been granted.
 */
export async function clipboardHasText(): Promise<boolean | null> {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) return null;
    try {
        const status = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
        if (status?.state !== "granted") return null;
        return (await navigator.clipboard.readText()).length > 0;
    } catch {
        // Firefox has no `clipboard-read` in its permission registry, Safari refuses the
        // query outright. Both mean "unknown", which is what the caller already handles.
        return null;
    }
}

/** The rows for this target, in the order every desktop menu puts them. */
export function clipboardEntries(target: ClipboardTarget, options: ClipboardMenuOptions = {}): ContextMenuEntry[] {
    const { copy = true, cut = true, paste = true, labels = {}, icons = {}, clipboardEmpty = false } = options;
    const entries: ContextMenuEntry[] = [];
    const selected = target.selection.length > 0 && target.copyable;
    const canPaste = typeof navigator !== "undefined" && Boolean(navigator.clipboard?.readText);

    if (copy && selected) {
        entries.push({ id: `${CLIPBOARD_PREFIX}copy`, label: labels.copy ?? "Copy", shortcut: "Mod+C", icon: icons.copy });
    }
    if (cut && selected && target.writable) {
        entries.push({ id: `${CLIPBOARD_PREFIX}cut`, label: labels.cut ?? "Cut", shortcut: "Mod+X", icon: icons.cut });
    }
    if (paste && target.writable && canPaste) {
        entries.push({
            id: `${CLIPBOARD_PREFIX}paste`,
            label: labels.paste ?? "Paste",
            shortcut: "Mod+V",
            icon: icons.paste,
            // Listed and greyed rather than dropped: a row that disappears between two opens
            // is read as the menu being unreliable, and every desktop menu greys this one.
            disabled: clipboardEmpty
        });
    }
    return entries;
}

/** Which clipboard row an id belongs to, or null for anything that is not one of ours. */
export function clipboardAction(id: string): ClipboardAction | null {
    if (!id.startsWith(CLIPBOARD_PREFIX)) return null;
    const action = id.slice(CLIPBOARD_PREFIX.length);
    return action === "copy" || action === "cut" || action === "paste" ? action : null;
}

/**
 * Put the caret back where it was before the menu took focus.
 *
 * Choosing a row moves focus into the panel and then destroys it, so by the time the action
 * runs the field is not focused and its selection is gone. Both are restored first, or Cut
 * deletes nothing and Paste inserts at position zero.
 */
function restore(target: ClipboardTarget): void {
    const element = target.editable;
    if (!element) return;
    element.focus({ preventScroll: true });
    if (!target.range) return;
    const field = element as HTMLInputElement | HTMLTextAreaElement;
    try { field.setSelectionRange(target.range.start, target.range.end); } catch { /* not selectable */ }
}

/**
 * Write a value the way a keystroke would, for either kind of field.
 *
 * The same trick `<Input>` uses, and for the same reason: assigning `.value` is invisible to
 * React, which compares against the last value it rendered and skips the change event. The
 * setter has to come from the element's OWN prototype - a textarea's is not an input's.
 */
function writeFieldValue(field: HTMLInputElement | HTMLTextAreaElement, next: string): void {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(field, next);
    else field.value = next;
    field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Replace what is selected with `text` (or delete it, when `text` is empty).
 *
 * `execCommand("insertText")` first, deprecated as it is: it is the only insertion that joins
 * the browser's own UNDO stack, so Ctrl+Z after a paste behaves like a paste and not like a
 * value that appeared from nowhere. The fallback is exact and does everything but the undo.
 */
function replaceSelection(target: ClipboardTarget, text: string): void {
    const element = target.editable;
    if (!element) return;

    try {
        if (document.execCommand("insertText", false, text)) return;
    } catch {
        // Denied, or not implemented. The fallback below is the whole behaviour anyway.
    }

    const field = element as HTMLInputElement | HTMLTextAreaElement;
    if (typeof field.setSelectionRange !== "function" || target.range === null) return;
    const start = field.selectionStart ?? target.range.start;
    const end = field.selectionEnd ?? target.range.end;
    writeFieldValue(field, field.value.slice(0, start) + text + field.value.slice(end));
    const caret = start + text.length;
    try { field.setSelectionRange(caret, caret); } catch { /* not selectable */ }
}

/**
 * Do what the row says.
 *
 * Called straight from the press that chose it, so the browser still counts it as a user
 * gesture - which is what the clipboard API requires and what makes a paste possible at all.
 * Returns whether the action happened: a refused permission and an empty clipboard are both
 * "no", and neither is worth an exception the caller has to catch.
 */
export async function performClipboardAction(action: ClipboardAction, target: ClipboardTarget): Promise<boolean> {
    restore(target);

    if (action === "copy" || action === "cut") {
        if (!target.selection || !target.copyable) return false;
        try {
            await navigator.clipboard.writeText(target.selection);
        } catch {
            // An insecure context, or a browser that refuses without permission. The
            // deprecated command still works in both, and it is the only fallback there is.
            try { if (!document.execCommand("copy")) return false; } catch { return false; }
        }
        if (action === "cut" && target.writable) replaceSelection(target, "");
        return true;
    }

    if (!target.writable) return false;
    try {
        const text = await navigator.clipboard.readText();
        if (!text) return false;
        replaceSelection(target, text);
        return true;
    } catch {
        // Refused, dismissed, or empty. Nothing changed, so there is nothing to report.
        return false;
    }
}
