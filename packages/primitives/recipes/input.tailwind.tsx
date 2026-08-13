import type { InputHTMLAttributes } from "react";
import { useInput } from "@enigmax/primitives/react";

/**
 * A styled field, yours to edit.
 *
 * The reveal toggle, its accessible name, its pressed state and the caret handling all
 * come from the primitive. Every class below is a suggestion.
 *
 * The action buttons are created by the engine, so they are styled through the
 * data-* hooks rather than a className prop - hence the arbitrary-variant selectors.
 */
export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    /** Remove the automatic password reveal. */
    reveal?: boolean;
}

export function Field({ label, reveal = true, className = "", ...props }: FieldProps) {
    const { inputRef } = useInput({ reveal });

    return (
        <label className="grid gap-1.5">
            {label && <span className="text-xs text-neutral-400">{label}</span>}
            <span
                className="
                    flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-900 px-3
                    focus-within:border-neutral-400
                    [&_[data-enigma-input-actions]]:inline-flex
                    [&_[data-enigma-input-action]]:grid [&_[data-enigma-input-action]]:size-7 [&_[data-enigma-input-action]]:place-items-center
                    [&_[data-enigma-input-action]]:rounded-md [&_[data-enigma-input-action]]:text-neutral-400
                    [&_[data-enigma-input-action]:hover]:bg-neutral-800 [&_[data-enigma-input-action]:hover]:text-neutral-100
                    [&_[data-enigma-input-action][aria-pressed=true]]:text-amber-400
                "
            >
                <input
                    ref={inputRef}
                    className={`min-w-0 flex-1 bg-transparent py-2.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 ${className}`}
                    {...props}
                />
            </span>
        </label>
    );
}
