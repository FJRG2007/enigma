/**
 * Input affordances: the buttons that live inside a field, with no styling of their own.
 *
 * A password field gets its reveal toggle automatically, because a field the visitor
 * cannot read back is the single most common cause of a failed sign-in. Everything about
 * it is replaceable - the icon, the label, the position, the container, whether it exists
 * at all - and the same mechanism takes any other action you want in there.
 *
 * The details below are the ones the hand-rolled version gets wrong; each is commented
 * with the failure it prevents.
 */

/** What an action renders. A string is parsed as HTML, so an inline SVG works. */
export type InputIcon = string | Node;

export interface InputActionState {
    /** The field the action belongs to. */
    input: HTMLInputElement;
    /** True while the password is readable. Always false for a non-password field. */
    revealed: boolean;
    /** The field cannot be acted on: disabled or read-only. */
    locked: boolean;
}

export interface InputAction {
    /** Stable id. Used for `data-action` and to replace a built-in (e.g. "reveal"). */
    name: string;
    /** Accessible name. Becomes both `aria-label` and `title`. */
    label: string | ((state: InputActionState) => string);
    icon: InputIcon | ((state: InputActionState) => InputIcon);
    /** Runs on click and on Enter/Space, because it is a real button. */
    onSelect: (state: InputActionState) => void;
    /** Renders `aria-pressed`. Omit for actions that are not a toggle. */
    pressed?: (state: InputActionState) => boolean;
    /** Hide the action without removing it, e.g. a clear button on an empty field. */
    visible?: (state: InputActionState) => boolean;
}

export interface InputOptions {
    /**
     * The password reveal. `false` removes it. An object overrides parts of it - the
     * icons, the labels - without giving up the caret and focus handling.
     */
    reveal?: boolean | {
        /** Shown while the password is hidden; selecting it reveals. */
        showIcon?: InputIcon;
        /** Shown while the password is readable. */
        hideIcon?: InputIcon;
        showLabel?: string;
        hideLabel?: string;
    };
    /** Extra actions, or a replacement for a built-in when `name` matches. */
    actions?: InputAction[];
    /** Which side the actions mount on. Position them yourself with CSS. */
    position?: "start" | "end";
    /**
     * Mount the actions here instead of in a container created next to the input.
     * Use it when your markup already has a slot for them.
     */
    container?: HTMLElement;
    /** Called whenever the password's visibility changes. */
    onRevealChange?: (revealed: boolean) => void;
}

export interface InputInstance {
    readonly revealed: boolean;
    /** Show or hide the password. Toggles when the argument is omitted. */
    reveal(next?: boolean): void;
    /** Re-read the field and re-render the actions. Call after changing it yourself. */
    refresh(): void;
    update(options: Partial<InputOptions>): void;
    destroy(): void;
}

/**
 * The built-in glyphs, as path data.
 *
 * Path data rather than markup because there are two renderers: this file writes an SVG
 * string into a button it created, and the React component builds elements. Keeping the
 * shapes here means one definition, and a theme that replaces an icon replaces it in both.
 * Everything is stroked with `currentColor` at 1em, so an icon inherits the field's text.
 */
export const INPUT_ICON_PATHS = {
    eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"],
    eyeOff: [
        "M10.6 5.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.2 6.2A17.7 17.7 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.2-.9",
        "m2 2 20 20",
        "M9.9 9.9a3 3 0 0 0 4.2 4.2"
    ],
    generate: ["m12 3 1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9Z", "M19 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"]
} as const;

/** The same shapes as a standalone SVG string, for the DOM renderer below. */
export function iconMarkup(paths: readonly string[]): string {
    const body = paths.map((path) => `<path d="${path}"/>`).join("");
    return `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const EYE = iconMarkup(INPUT_ICON_PATHS.eye);
const EYE_OFF = iconMarkup(INPUT_ICON_PATHS.eyeOff);

function resolve<T>(value: T | ((state: InputActionState) => T), state: InputActionState): T {
    return typeof value === "function" ? (value as (state: InputActionState) => T)(state) : value;
}

function paint(target: HTMLElement, icon: InputIcon): void {
    if (typeof icon === "string") target.innerHTML = icon;
    else {
        target.replaceChildren(icon);
    }
}

/**
 * Wire a field's in-field actions.
 *
 * @param input The field itself. A `type="password"` field gets the reveal for free.
 */
export function createInput(input: HTMLInputElement, options: InputOptions = {}): InputInstance {
    let opts: InputOptions = { ...options };
    let revealed = false;
    let destroyed = false;
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;

    const owned = !opts.container;
    const container = opts.container ?? document.createElement("span");
    const buttons = new Map<string, HTMLButtonElement>();

    function state(): InputActionState {
        return { input, revealed, locked: input.disabled || input.readOnly };
    }

    function revealConfig() {
        return typeof opts.reveal === "object" ? opts.reveal : {};
    }

    /** The built-in, presented as an ordinary action so it can be replaced by name. */
    function revealAction(): InputAction {
        const config = revealConfig();
        return {
            name: "reveal",
            label: (current) => (current.revealed ? config.hideLabel ?? "Hide password" : config.showLabel ?? "Show password"),
            icon: (current) => (current.revealed ? config.hideIcon ?? EYE_OFF : config.showIcon ?? EYE),
            pressed: (current) => current.revealed,
            onSelect: () => setRevealed(!revealed)
        };
    }

    /** A password field is one whose type is password OR one already revealed by us. */
    function isPasswordField(): boolean {
        return input.type === "password" || (revealed && input.dataset.enigmaInputReveal === "on");
    }

    function activeActions(): InputAction[] {
        const custom = opts.actions ?? [];
        const wantsReveal = opts.reveal !== false && isPasswordField();
        const builtIn = wantsReveal && !custom.some((action) => action.name === "reveal") ? [revealAction()] : [];
        return [...builtIn, ...custom];
    }

    function setRevealed(next: boolean): void {
        if (!isPasswordField() && next) return;
        // Captured BEFORE the switch. Assigning `type` inside a click handler resets the
        // caret to 0 in Chromium - reproduced in twenty lines with no library, and it does
        // NOT happen when the same assignment runs outside an event - so anything read
        // afterwards is already the clobbered value.
        const selection = readSelection();

        revealed = next;
        input.type = next ? "text" : "password";
        input.dataset.enigmaInputReveal = next ? "on" : "off";

        render();

        // After the render, because rewriting the buttons moves it again.
        if (selection) {
            applySelection(selection);
            // And once more on the next MACROTASK. Chromium clobbers the caret exactly
            // there - not synchronously and not in a microtask, both of which still read
            // the right value - so a restore that only runs inline silently loses. The
            // field is re-checked for focus first, so a visitor who clicked elsewhere in
            // the meantime is not dragged back.
            if (restoreTimer !== null) clearTimeout(restoreTimer);
            restoreTimer = setTimeout(() => {
                restoreTimer = null;
                if (!destroyed && document.activeElement === input) applySelection(selection);
            }, 0);
        }
        opts.onRevealChange?.(next);
    }

    /** Read the field's caret, if it has one and owns the focus. */
    function readSelection(): [number, number] | null {
        if (document.activeElement !== input) return null;
        try {
            const { selectionStart, selectionEnd } = input;
            return selectionStart === null || selectionEnd === null ? null : [selectionStart, selectionEnd];
        } catch {
            return null;   // selection is not supported on this input type
        }
    }

    function applySelection(selection: [number, number]): void {
        try { input.setSelectionRange(selection[0], selection[1]); } catch { /* unsupported */ }
    }

    function render(): void {
        if (destroyed) return;
        // Rewriting the buttons resets the caret of a focused field - measured, and it
        // happens asynchronously too, because the MutationObserver below re-renders after
        // the type switch. Preserving it HERE covers every trigger: the observer, an
        // update(), a caller's refresh(). Doing it only in setRevealed left the reveal
        // sending the cursor to position 0 one task later.
        const selection = readSelection();
        const current = state();
        const actions = activeActions();
        const seen = new Set<string>();

        for (const action of actions) {
            seen.add(action.name);
            const visible = action.visible ? action.visible(current) : true;
            let button = buttons.get(action.name);

            if (!button) {
                button = document.createElement("button");
                // Without this a button inside a form SUBMITS it, so revealing a password
                // posts the half-filled form. It is the single most common bug here.
                button.type = "button";
                button.dataset.enigmaInputAction = action.name;
                buttons.set(action.name, button);
                container.append(button);
            }

            if (!visible) {
                // Removed rather than `hidden`: the hidden attribute works through a UA
                // `display: none`, and ANY author rule that sets `display` on the button
                // beats it - which a theme styling these buttons always does.
                button.remove();
                buttons.delete(action.name);
                continue;
            }
            if (!button.isConnected) container.append(button);

            const label = resolve(action.label, current);
            button.setAttribute("aria-label", label);
            button.title = label;
            button.disabled = current.locked;
            if (action.pressed) button.setAttribute("aria-pressed", String(action.pressed(current)));
            else button.removeAttribute("aria-pressed");
            paint(button, resolve(action.icon, current));
        }

        for (const [name, button] of [...buttons]) {
            if (seen.has(name)) continue;
            button.remove();
            buttons.delete(name);
        }

        container.hidden = buttons.size === 0;

        if (selection) {
            try { input.setSelectionRange(selection[0], selection[1]); } catch { /* unsupported */ }
        }
    }

    /**
     * A press on an action must not pull focus out of the field: the visitor is mid-word
     * and expects to keep typing. Preventing the default on mousedown keeps focus where
     * it is, which also means the caret survives on its own. Keyboard users still reach
     * the button with Tab and activate it with Space, and focus correctly stays there.
     */
    function onMouseDown(event: MouseEvent): void {
        if (!(event.target as HTMLElement | null)?.closest("[data-enigma-input-action]")) return;
        event.preventDefault();
    }

    function onClick(event: MouseEvent): void {
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-enigma-input-action]");
        if (!target) return;
        const action = activeActions().find((candidate) => candidate.name === target.dataset.enigmaInputAction);
        if (!action) return;
        event.preventDefault();
        action.onSelect(state());
    }

    /** The field's own type can change from outside; the reveal has to follow. */
    const observer = typeof MutationObserver === "function"
        ? new MutationObserver(() => {
            if (!isPasswordField() && revealed) revealed = false;
            render();
        })
        : null;

    function mount(): void {
        input.dataset.enigmaInput = "";
        container.dataset.enigmaInputActions = "";
        container.dataset.position = opts.position ?? "end";
        if (owned && !container.isConnected) {
            if ((opts.position ?? "end") === "start") input.before(container);
            else input.after(container);
        }
        container.addEventListener("mousedown", onMouseDown);
        container.addEventListener("click", onClick);
        observer?.observe(input, { attributes: true, attributeFilter: ["type", "disabled", "readonly"] });
        render();
    }

    mount();

    return {
        get revealed() { return revealed; },
        reveal(next?: boolean) { setRevealed(next ?? !revealed); },
        refresh: render,
        update(next: Partial<InputOptions>) {
            const moved = next.position !== undefined && next.position !== opts.position;
            opts = { ...opts, ...next };
            if (moved && owned) {
                container.dataset.position = opts.position ?? "end";
                if (opts.position === "start") input.before(container);
                else input.after(container);
            }
            render();
        },
        destroy() {
            destroyed = true;
            if (restoreTimer !== null) clearTimeout(restoreTimer);
            observer?.disconnect();
            container.removeEventListener("mousedown", onMouseDown);
            container.removeEventListener("click", onClick);
            for (const button of buttons.values()) button.remove();
            buttons.clear();
            if (owned) container.remove();
            delete input.dataset.enigmaInput;
            delete input.dataset.enigmaInputReveal;
            // A field left as text would leak the password on the next render.
            if (revealed) input.type = "password";
        }
    };
}
