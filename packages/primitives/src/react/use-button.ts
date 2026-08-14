import { useRef, useMemo, useEffect, useState, useCallback } from "react";
import { createButton, type ButtonOptions, type ButtonState } from "@/core/button";

export interface UseButtonResult extends ButtonState {
    /** Spread onto the element named by `element`. */
    props: {
        onClick: (event: Event | { preventDefault(): void; }) => void;
        "aria-disabled": boolean;
        "aria-busy": boolean;
        "data-loading"?: "";
        "data-cooldown"?: "";
        /** Only on a real button: an anchor has no `disabled`. */
        disabled?: boolean;
        href?: string;
        title?: string;
    };
    press: () => void;
    reset: () => void;
}

/**
 * Button behaviour: disabled, loading, a cooldown and a keyboard shortcut collapsed into
 * one `available`, plus the attributes that follow from it.
 *
 * ```tsx
 * const { element: Tag, props, loading, cooldown } = useButton({
 *     cooldown: { ms: 30_000, key: "resend-code", storage: "local" },
 *     shortcut: "r",
 *     onPress: () => resendCode()
 * });
 *
 * return <Tag {...props}>{loading ? "Sending" : cooldown ? `Wait ${Math.ceil(cooldown / 1000)}s` : "Resend"}</Tag>;
 * ```
 */
export function useButton(options: ButtonOptions = {}): UseButtonResult {
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const instance = useMemo(() => createButton({
        ...optionsRef.current,
        onPress: (event) => optionsRef.current.onPress?.(event),
        onChange: (next) => optionsRef.current.onChange?.(next)
    // Built once: recreating it would drop a running cooldown on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);

    const [state, setState] = useState<ButtonState>(() => instance.state);

    useEffect(() => {
        const unsubscribe = instance.subscribe(setState);
        setState(instance.state);
        return () => {
            unsubscribe();
            instance.destroy();
        };
    }, [instance]);

    useEffect(() => {
        instance.update({
            href: options.href,
            disabled: options.disabled,
            loading: options.loading,
            cooldown: options.cooldown,
            shortcut: options.shortcut
        });
    }, [instance, options.href, options.disabled, options.loading, options.cooldown, options.shortcut]);

    const press = useCallback(() => { void instance.press(); }, [instance]);

    return {
        ...state,
        press,
        reset: () => instance.reset(),
        props: {
            onClick: (event) => {
                // An unavailable link still receives clicks - aria-disabled is advisory -
                // so the press is refused here rather than relying on the attribute.
                if (!state.available) { event.preventDefault(); return; }
                // Passed through: a handler that wants to stop propagation or read the
                // target had no way to get at it while press() was called bare.
                void instance.press(event as Event);
            },
            "aria-disabled": !state.available,
            "aria-busy": state.loading,
            ...(state.loading ? { "data-loading": "" as const } : {}),
            ...(state.cooldown > 0 ? { "data-cooldown": "" as const } : {}),
            ...(state.element === "button" ? { disabled: state.disabled } : { href: options.href }),
            ...(state.shortcut ? { title: `Shortcut: ${state.shortcut.toUpperCase()}` } : {})
        }
    };
}
