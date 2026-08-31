"use client";

import { Slot } from "@/react/slot";
import { useButton } from "@/react/use-button";
import { getLinkComponent } from "@/react/link";
import type { ButtonOptions, ButtonState } from "@/core/button";
import { createElement, forwardRef, isValidElement, type ComponentPropsWithoutRef, type ElementType, type ReactNode } from "react";

/**
 * `<Button>` - the component, for the ninety percent.
 *
 * ```tsx
 * <Button onPress={save}>Save</Button>
 * ```
 *
 * That is the whole thing: disabled while the work runs, `aria-busy`, `data-loading`, and a
 * cooldown afterwards if you asked for one. `useButton` is still there for a button whose
 * markup is nothing like a button - a card, a table row - but reaching for it to render an
 * ordinary one means writing the same six lines at every call site, which is how they drift.
 */

// `onChange` is omitted from the DOM side because the primitive's own onChange - which
// reports the button's state - would otherwise clash with the form event of the same name.
// `onClick` is omitted and re-declared below, as an alias rather than a second handler.
export interface ButtonProps extends ButtonOptions, Omit<ComponentPropsWithoutRef<"button">, "onClick" | "onChange" | "children" | "type"> {
    /**
     * What to run when it is pressed. The same thing as `onPress`, under the name React
     * already uses - write whichever reads better.
     *
     * It is an ALIAS, not a second handler: the component owns the element's real onClick,
     * because that is where a press is refused while the button is loading, disabled or
     * cooling down. Passing one through would replace that and silently take the behaviour
     * with it. Returning a promise drives `loading` for its duration, same as `onPress`.
     */
    onClick?: ButtonOptions["onPress"];
    /**
     * Override what to render. You rarely need it: an href already renders whatever
     * `setLinkComponent` registered - your router's Link - and a button otherwise.
     */
    as?: ElementType;
    /**
     * The label, or a function of the state for one that changes with it.
     *
     * ```tsx
     * <Button onPress={send} cooldown={30_000}>
     *     {({ loading, cooldown }) => loading ? "Sending" : cooldown ? `Wait ${Math.ceil(cooldown / 1000)}s` : "Resend"}
     * </Button>
     * ```
     */
    children?: ReactNode | ((state: ButtonState) => ReactNode);
    /** Replaces the label while async work runs - a spinner, or just different words. */
    pending?: ReactNode;
    /** `type` on a real button. Ignored on a link, which has none. */
    type?: "button" | "submit" | "reset";
    /**
     * Show the shortcut as a key badge after the label, the way Stripe writes
     * "Create invoice n".
     *
     * `"auto"` (the default) shows it when there is a shortcut AND the label renders text:
     * beside a lone glyph on an icon-only button the badge is noise, and it would double the
     * width of the smallest control on the screen. `true` and `false` decide it outright.
     */
    shortcutHint?: boolean | "auto";
    /** Render the badge yourself. Return null to drop it for one button. */
    renderShortcut?: (key: string) => ReactNode;
    /**
     * Put the behaviour on YOUR element instead of ours - a `motion.button`, your design
     * system's button, a router Link, anything.
     *
     * ```tsx
     * <Button asChild cooldown={30_000} onPress={resend}>
     *     <motion.button whileTap={{ scale: 0.98 }}>Resend</motion.button>
     * </Button>
     * ```
     *
     * The child owns its own markup, so the shortcut badge is not injected - the child is
     * rendered exactly as written. Read `state.shortcut` from `useButton` to place your own.
     */
    asChild?: boolean;
}

/**
 * Whether a label renders any TEXT.
 *
 * Walked rather than assumed: `<Button shortcut="s"><Icon /></Button>` and
 * `<Button shortcut="s"><Icon /> Save</Button>` differ only in a string buried in the tree,
 * and that string is the whole difference between a hint and a decoration. An element whose
 * text arrives from somewhere this cannot see reports false, so `auto` errs towards the
 * quieter button; `shortcutHint` overrides it in one word.
 */
function hasText(node: ReactNode): boolean {
    if (node === null || node === undefined || typeof node === "boolean") return false;
    if (typeof node === "string") return node.trim().length > 0;
    if (typeof node === "number") return true;
    if (Array.isArray(node)) return node.some(hasText);
    if (isValidElement(node)) return hasText((node.props as { children?: ReactNode; }).children);
    return false;
}

export const Button = forwardRef<HTMLElement, ButtonProps>(function Button({
    as,
    children,
    pending,
    href,
    disabled,
    loading,
    cooldown,
    shortcut,
    onPress,
    onClick,
    onChange,
    type = "button",
    shortcutHint = "auto",
    renderShortcut,
    asChild = false,
    ...rest
}, ref) {
    const button = useButton({ href, disabled, loading, cooldown, shortcut, onPress: onPress ?? onClick, onChange });
    const state: ButtonState = button;

    // An href renders the registered link - next/link, react-router's, whatever was passed
    // to setLinkComponent - and a plain <a> when nothing was. The package cannot import a
    // router itself, so registering one is what turns every href into a client navigation
    // without a word at the call site.
    const Tag: ElementType = asChild ? Slot : as ?? (state.element === "a" ? getLinkComponent() : "button");

    // `type="button"` is the default on purpose. A bare <button> inside a form submits it,
    // so an action button that forgot it posts the form instead of doing its job. Never
    // injected through a slot: the child may be an anchor or a div, where `type` is either
    // invalid or means something else entirely.
    const native = Tag === "button" ? { type } : {};

    const label = typeof children === "function" ? children(state) : children;
    const content = state.loading && pending !== undefined ? pending : label;

    // Not while it is working: the label has already been replaced by whatever `pending`
    // says, and a key that does nothing right now is not a hint.
    // Never through a slot: it takes exactly one child, and a second one would throw.
    const showHint = !asChild && Boolean(state.shortcut) && !state.loading &&
        (shortcutHint === "auto" ? hasText(content) : shortcutHint);
    const hint = showHint && state.shortcut
        ? renderShortcut?.(state.shortcut) ?? createElement(
            "kbd",
            // Hidden from the accessible name - the button already carries
            // `aria-keyshortcuts`, and "Save n" is not what anyone wants read out.
            { "data-enigma-button-key": "", "aria-hidden": true },
            state.shortcut
        )
        : null;

    return createElement(
        Tag,
        { ref, ...button.props, ...native, ...rest },
        content,
        hint
    );
});
