/**
 * The colour picker's baseline look.
 *
 * The rest of `<Input>` ships no styles, and this one does, for the reason the select's sheet
 * gives: an unstyled POPUP is not a plain-looking control, it is transparent boxes lying on
 * top of the page. A saturation square with no size is nothing at all - there is no useful
 * "unstyled" version of a gradient someone drags a handle across - so the panel arrives with
 * a look, and `styles={false}` takes it away for anyone who wants to draw their own.
 *
 * A string rather than a stylesheet because the picker injects it. `scripts/sync-recipes.mjs`
 * generates `recipes/color/styles.css` from here and CI fails when the two drift, so this
 * module is the source and the `.css` is the copy for anyone who prefers an import.
 *
 * Everything below is a custom property or an attribute selector: override the properties on
 * `:root` for a different-looking picker without writing a single selector. The sheet is
 * PREPENDED to `<head>`, so anything the document already has wins on source order at equal
 * specificity.
 */

export const COLOR_STYLES = `
:root {
    --enigma-color-panel-bg: #1c1c1c;
    --enigma-color-panel-border: #333333;
    --enigma-color-panel-radius: 0.625rem;
    --enigma-color-panel-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    --enigma-color-panel-width: 13.5rem;
    --enigma-color-text: #f5f5f5;
    --enigma-color-muted: #a3a3a3;
    --enigma-color-border: #404040;
    --enigma-color-focus: #a3a3a3;
    --enigma-color-area-height: 8rem;
    --enigma-color-rail-height: 0.625rem;
    --enigma-color-thumb: #ffffff;
    --enigma-color-thumb-ring: rgba(0, 0, 0, 0.55);
    /* The light square of the transparency chequerboard. The dark one is the surface it sits
       on, which is why only one colour is a property. */
    --enigma-color-checker: rgba(255, 255, 255, 0.22);
    --enigma-color-checker-size: 0.5rem;
}

@media (prefers-color-scheme: light) {
    :root {
        --enigma-color-panel-bg: #ffffff;
        --enigma-color-panel-border: #e5e5e5;
        --enigma-color-panel-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
        --enigma-color-text: #171717;
        --enigma-color-muted: #737373;
        --enigma-color-border: #d4d4d4;
        --enigma-color-focus: #737373;
        --enigma-color-thumb-ring: rgba(0, 0, 0, 0.35);
        --enigma-color-checker: rgba(0, 0, 0, 0.14);
    }
}

/* The anchor the panel hangs from. Inline so it sits in the field's own row, and the
   positioning context so the panel needs no portal and no scroll listener: it moves with
   the field because it is INSIDE it. */
[data-enigma-color] { position: relative; display: inline-flex; flex: none; }

[data-enigma-color-swatch] {
    display: block; width: 1.25rem; height: 1.25rem; padding: 0;
    background: none; border: 1px solid var(--enigma-color-border); border-radius: 0.3125rem;
    cursor: pointer; overflow: hidden;
}
[data-enigma-color-swatch]:focus-visible { outline: 2px solid var(--enigma-color-focus); outline-offset: 2px; }
[data-enigma-color-swatch]:disabled { opacity: 0.5; cursor: not-allowed; }

/* The chequerboard, so a colour with alpha reads as transparent rather than as a lighter
   colour - which is the whole difference between #ff000080 and #ff8080. */
[data-enigma-color-checkers] {
    background-image:
        conic-gradient(var(--enigma-color-checker) 0 25%, transparent 0 50%, var(--enigma-color-checker) 0 75%, transparent 0);
    background-size: var(--enigma-color-checker-size) var(--enigma-color-checker-size);
}

[data-enigma-color-fill] { display: block; width: 100%; height: 100%; }
/* An unparseable field has no colour to show, so the swatch shows the chequerboard alone
   rather than the last good colour: a stale swatch says the value is fine when it is not. */
[data-enigma-color-swatch][data-invalid] [data-enigma-color-fill] { background: none; }

[data-enigma-color-panel] {
    position: absolute; z-index: 60; top: calc(100% + 0.375rem); left: 0;
    display: grid; gap: 0.625rem;
    box-sizing: border-box; width: var(--enigma-color-panel-width); padding: 0.625rem;
    color: var(--enigma-color-text); background: var(--enigma-color-panel-bg);
    border: 1px solid var(--enigma-color-panel-border);
    border-radius: var(--enigma-color-panel-radius);
    box-shadow: var(--enigma-color-panel-shadow);
}
/* Flipped when the field sits near the bottom of the window. Without it the panel opens off
   the screen and the controls are unreachable, which is the same defect the select fixes. */
[data-enigma-color-panel][data-side="top"] { top: auto; bottom: calc(100% + 0.375rem); }

[data-enigma-color-area] {
    position: relative; height: var(--enigma-color-area-height);
    border-radius: 0.375rem; cursor: crosshair;
    /* The drag IS the control here, so the page must not scroll under it. The marquee's
       warning about touch-action is the opposite case: a full-width row still has to let the
       page move. */
    touch-action: none;
    background:
        linear-gradient(to top, #000000, rgba(0, 0, 0, 0)),
        linear-gradient(to right, #ffffff, rgba(255, 255, 255, 0)),
        hsl(var(--enigma-color-hue, 0), 100%, 50%);
}
[data-enigma-color-area]:focus-visible,
[data-enigma-color-rail]:focus-visible { outline: 2px solid var(--enigma-color-focus); outline-offset: 2px; }

[data-enigma-color-controls] { display: flex; align-items: center; gap: 0.5rem; }
[data-enigma-color-rails] { display: grid; gap: 0.5rem; flex: 1; min-width: 0; }

[data-enigma-color-rail] {
    position: relative; height: var(--enigma-color-rail-height);
    border-radius: 999px; cursor: pointer; touch-action: none;
}
[data-enigma-color-rail="hue"] {
    background: linear-gradient(to right, #ff0000, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000);
}
[data-enigma-color-rail="alpha"] { background-image: none; }
[data-enigma-color-rail="alpha"] [data-enigma-color-gradient] {
    position: absolute; inset: 0; border-radius: inherit;
    background: linear-gradient(to right, transparent, var(--enigma-color-opaque, #000000));
}

/* One handle for the square and the rails. It must never take the pointer: a press that
   lands on the handle instead of the surface under it would start no drag at all. */
[data-enigma-color-thumb] {
    position: absolute; pointer-events: none;
    width: 0.75rem; height: 0.75rem; margin: -0.375rem 0 0 -0.375rem;
    border: 2px solid var(--enigma-color-thumb); border-radius: 999px;
    box-shadow: 0 0 0 1px var(--enigma-color-thumb-ring), inset 0 0 0 1px var(--enigma-color-thumb-ring);
}
[data-enigma-color-rail] [data-enigma-color-thumb] { top: 50%; }

[data-enigma-color-preview] {
    position: relative; flex: none; width: 1.75rem; height: 1.75rem;
    border: 1px solid var(--enigma-color-border); border-radius: 999px; overflow: hidden;
}

[data-enigma-color-eyedropper] {
    display: grid; place-items: center; flex: none;
    width: 1.75rem; height: 1.75rem; padding: 0;
    color: var(--enigma-color-muted); background: none;
    border: 1px solid var(--enigma-color-border); border-radius: 0.375rem; cursor: pointer;
}
[data-enigma-color-eyedropper]:hover { color: var(--enigma-color-text); }
[data-enigma-color-eyedropper]:focus-visible { outline: 2px solid var(--enigma-color-focus); outline-offset: 2px; }

/* The value as text, with the notation beside it. Monospace on purpose: a hex whose digits
   shift width as you drag is a value nobody can read at a glance. */
[data-enigma-color-value] { display: flex; align-items: center; gap: 0.375rem; }
[data-enigma-color-format] {
    flex: none; padding: 0.3125rem 0.375rem;
    font: inherit; font-size: 0.625rem; line-height: 1; letter-spacing: 0.06em;
    color: var(--enigma-color-muted); background: none;
    border: 1px solid var(--enigma-color-border); border-radius: 0.25rem; cursor: pointer;
}
[data-enigma-color-format]:hover { color: var(--enigma-color-text); }
[data-enigma-color-input] {
    flex: 1; min-width: 0; padding: 0.25rem 0.375rem;
    font: inherit; font-family: var(--enigma-color-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 0.75rem; line-height: 1.4;
    color: var(--enigma-color-text); background: none;
    border: 1px solid var(--enigma-color-border); border-radius: 0.25rem;
}
[data-enigma-color-format]:focus-visible,
[data-enigma-color-input]:focus-visible { outline: 2px solid var(--enigma-color-focus); outline-offset: 1px; }

[data-enigma-color-swatches] { display: flex; flex-wrap: wrap; gap: 0.25rem; }
[data-enigma-color-preset] {
    width: 1.125rem; height: 1.125rem; padding: 0;
    border: 1px solid var(--enigma-color-border); border-radius: 0.25rem; cursor: pointer;
}
[data-enigma-color-preset]:focus-visible { outline: 2px solid var(--enigma-color-focus); outline-offset: 2px; }
[data-enigma-color-preset][aria-pressed="true"] { box-shadow: 0 0 0 2px var(--enigma-color-focus); }
`;
