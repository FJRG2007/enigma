"use client";

import { useButton } from "@/react/use-button";
import { getLinkComponent } from "@/react/link";
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
    ...rest
}, ref) {
    const button = useButton({ href, disabled, loading, cooldown, shortcut, onPress: onPress ?? onClick, onChange });
    const state: ButtonState = button;

    // An href renders the registered link - next/link, react-router's, whatever was passed
    // to setLinkComponent - and a plain <a> when nothing was. The package cannot import a
    // router itself, so registering one is what turns every href into a client navigation
    // without a word at the call site.
    const Tag: ElementType = as ?? (state.element === "a" ? getLinkComponent() : "button");

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
