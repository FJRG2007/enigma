import "./input.css";
import type { InputHTMLAttributes } from "react";
import { useInput } from "@enigmax/primitives/react";

/**
 * A styled field, yours to edit.
 *
 * The reveal toggle, its accessible name, its pressed state and the caret handling all
 * come from the primitive. input.css beside this file is a starting point.
 */
export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    /** Remove the automatic password reveal. */
    reveal?: boolean;
}

export function Field({ label, reveal = true, className = "", ...props }: FieldProps) {
    const { inputRef } = useInput({ reveal });

    return (
        <label className="enigma-field">
            {label && <span className="enigma-field__label">{label}</span>}
            <span className="enigma-field__box">
                <input ref={inputRef} className={`enigma-field__input ${className}`.trim()} {...props} />
            </span>
        </label>
    );
}
