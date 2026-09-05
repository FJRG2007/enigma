"use client";

import type { CSSProperties, ReactNode, Ref } from "react";

/**
 * The swatch in the field, and the box the panel hangs from.
 *
 * Its own module, and deliberately NOT part of the picker's chunk. The picker is imported on
 * demand, so a swatch that lived in there would not exist for as long as that request takes -
 * the field renders as a bare text box, the affordance appears late and shifts the row, and a
 * press in that window reaches nothing at all. On a fast connection that is a blink; on a
 * cold cache it is the second or two somebody spends clicking a swatch that is not there yet.
 *
 * So the swatch ships with the field and the panel arrives behind it. It costs the markup
 * below in the base chunk and no colour maths at all: the fill is handed to the browser, which
 * is the only parser that already knows every notation a value could be written in.
 */

/**
 * Enough of a look to be a swatch, for the frames before the panel's stylesheet exists.
 *
 * The sheet ships with the picker, so the swatch rendered ahead of it would otherwise be a
 * default browser button for as long as that request takes - which trades a missing control
 * for an ugly one. Written against the same custom properties, so a project that themed the
 * picker themes this too, and dropped entirely the moment the real swatch replaces it.
 */
const BASELINE: CSSProperties = {
    display: "block",
    boxSizing: "border-box",
    width: "1.25rem",
    height: "1.25rem",
    padding: 0,
    background: "none",
    border: "1px solid var(--enigma-color-border, #404040)",
    borderRadius: "0.3125rem",
    overflow: "hidden",
    cursor: "pointer"
};

export interface ColorSwatchProps {
    /** The value to paint, exactly as the field holds it. Anything unparseable paints nothing. */
    value?: string;
    /** Whether the panel is up, for `aria-expanded`. */
    open?: boolean;
    /** The value is not a colour: the swatch shows the chequerboard rather than a stale fill. */
    invalid?: boolean;
    /** The field is disabled or read-only. */
    locked?: boolean;
    label: string;
    anchorRef?: Ref<HTMLSpanElement>;
    buttonRef?: Ref<HTMLButtonElement>;
    onPress?: () => void;
    /** The picker's stylesheet has not arrived yet, so carry the few declarations it needs. */
    baseline?: boolean;
    /** The panel, once its code is here. */
    children?: ReactNode;
}

export function ColorSwatch({ value, open = false, invalid = false, locked = false, label, anchorRef, buttonRef, onPress, baseline = false, children }: ColorSwatchProps): ReactNode {
    return (
        <span
            ref={anchorRef}
            data-enigma-color=""
            data-open={open ? "" : undefined}
            style={baseline ? { position: "relative", display: "inline-flex", flex: "none" } : undefined}
        >
            <button
                ref={buttonRef}
                // Never a bare `<button>`: inside a form it would default to submit, so opening
                // the picker would post the half-filled form. The same trap the reveal has.
                type="button"
                data-enigma-color-swatch=""
                data-enigma-color-checkers=""
                data-invalid={invalid ? "" : undefined}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={label}
                title={label}
                disabled={locked}
                style={baseline ? BASELINE : undefined}
                onClick={onPress}
            >
                {/* The browser parses the value for us: an unparseable string simply applies
                    nothing, which is why the swatch needs no colour maths to fall back on. */}
                <span
                    data-enigma-color-fill=""
                    style={{
                        background: invalid ? undefined : value,
                        ...(baseline ? { display: "block", width: "100%", height: "100%" } : null)
                    }}
                />
            </button>
            {children}
        </span>
    );
}
