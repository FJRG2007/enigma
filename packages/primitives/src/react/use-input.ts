import { createInput, type InputOptions, type InputInstance } from "@/core/input";
import { useRef, useState, useEffect, useLayoutEffect, type RefObject } from "react";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface UseInputResult {
    /** Attach to the `<input>`. */
    inputRef: RefObject<HTMLInputElement | null>;
    /** Attach to your own actions container, or leave it and one is created for you. */
    actionsRef: RefObject<HTMLElement | null>;
    /** True while a password is readable. */
    revealed: boolean;
    reveal: (next?: boolean) => void;
    /** Re-render the actions after you change the field yourself. */
    refresh: () => void;
}

/**
 * In-field actions for an input, with the password reveal wired for free.
 *
 * ```tsx
 * const { inputRef, revealed } = useInput();
 * return <input ref={inputRef} type="password" autoComplete="current-password" />;
 * ```
 *
 * The toggle is a real `<button type="button">`, so it never submits the form, and the
 * caret survives the type switch.
 */
export function useInput(options: InputOptions = {}): UseInputResult {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const actionsRef = useRef<HTMLElement | null>(null);
    const instanceRef = useRef<InputInstance | null>(null);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const [revealed, setRevealed] = useState(false);

    useIsomorphicLayoutEffect(() => {
        const input = inputRef.current;
        if (!input) return;

        const instance = createInput(input, {
            ...optionsRef.current,
            container: actionsRef.current ?? optionsRef.current.container,
            onRevealChange: (next) => {
                setRevealed(next);
                optionsRef.current.onRevealChange?.(next);
            }
        });
        instanceRef.current = instance;
        return () => {
            instance.destroy();
            instanceRef.current = null;
        };
        // Created once; option changes go through update() so the field is not rebuilt
        // on every render, which would drop the caret mid-typing.
    }, []);

    useIsomorphicLayoutEffect(() => {
        instanceRef.current?.update(options);
    }, [options.reveal, options.actions, options.position]);

    return {
        inputRef,
        actionsRef,
        revealed,
        reveal: (next?: boolean) => instanceRef.current?.reveal(next),
        refresh: () => instanceRef.current?.refresh()
    };
}
