"use client";

import { useButton } from "@/react/use-button";
import type { ButtonOptions, ButtonState } from "@/core/button";
import { createElement, forwardRef, type ComponentPropsWithoutRef, type ElementType, type ReactNode } from "react";

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
export interface ButtonProps extends ButtonOptions, Omit<ComponentPropsWithoutRef<"button">, "onClick" | "onChange" | "children" | "type"> {
    /**
     * What to render. Defaults to `a` when there is an href and `button` otherwise, which
     * is what you want until a router is involved - then pass its Link and keep the rest.
     *
     * ```tsx
     * <Button as={Link} href="/settings">Settings</Button>
     * ```
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
    onChange,
    type = "button",
    ...rest
}, ref) {
    const button = useButton({ href, disabled, loading, cooldown, shortcut, onPress, onChange });
    const state: ButtonState = button;

    // Reported, not chosen: an href makes it an anchor, and a package that cannot import
    // next/link must not be the thing deciding. `as` overrides both.
    const Tag: ElementType = as ?? state.element;

    // `type="button"` is the default on purpose. A bare <button> inside a form submits it,
    // so an action button that forgot it posts the form instead of doing its job.
    const native = Tag === "button" ? { type } : {};

    const label = typeof children === "function" ? children(state) : children;

    return createElement(
        Tag,
        { ref, ...button.props, ...native, ...rest },
        state.loading && pending !== undefined ? pending : label
    );
});
