/**
 * The toast theme, as a string, because `<Toaster />` injects it.
 *
 * A toast is the one component where "bring your own CSS" is the wrong default: it is
 * rendered into a portal at the edge of the screen, it stacks, and it animates - so a
 * consumer who forgets the stylesheet does not get an unstyled toast, they get a pile of
 * text in the corner. `<Toaster styles={false} />` turns it off for anyone who wants their
 * own, and the injected sheet is PREPENDED to `<head>` so any stylesheet in the document
 * outranks it by source order without needing a single `!important`.
 *
 * This module is the source of truth for `recipes/toast/styles.css` too, which
 * `scripts/sync-recipes.mjs` writes from it - one look, whether it is injected or copied.
 *
 * The geometry is the stacked-card pattern: the newest toast is the front one, older ones
 * sit behind it scaled down and clipped to the front one's height, and hovering the stack
 * fans them out by the summed height of the ones in front. Every number below is one of
 * those two states.
 */
export const TOAST_STYLES = `
[data-enigma-toaster] {
    --enigma-toast-width: 356px;
    --enigma-toast-edge: 24px;
    --enigma-toast-gap: 14px;
    --enigma-toast-peek: 14px;
    --enigma-toast-scale-step: 0.06;
    --enigma-toast-radius: 12px;
    --enigma-toast-enter: 420ms;
    --enigma-toast-exit: 350ms;

    --enigma-toast-bg: #101010;
    --enigma-toast-border: #2a2a2a;
    --enigma-toast-text: #f5f5f5;
    --enigma-toast-muted: #a3a3a3;
    --enigma-toast-shadow: 0 6px 22px rgb(0 0 0 / 34%);

    --enigma-toast-success: hsl(150 80% 72%);
    --enigma-toast-success-bg: hsl(150 38% 9%);
    --enigma-toast-success-border: hsl(147 55% 18%);
    --enigma-toast-error: hsl(358 100% 82%);
    --enigma-toast-error-bg: hsl(358 42% 12%);
    --enigma-toast-error-border: hsl(357 55% 24%);
    --enigma-toast-info: hsl(216 87% 74%);
    --enigma-toast-info-bg: hsl(215 45% 11%);
    --enigma-toast-info-border: hsl(223 50% 24%);
    --enigma-toast-warning: hsl(46 87% 70%);
    --enigma-toast-warning-bg: hsl(40 55% 9%);
    --enigma-toast-warning-border: hsl(40 55% 20%);

    position: fixed;
    z-index: 999999;
    width: var(--enigma-toast-width);
    margin: 0;
    padding: 0;
    list-style: none;
    outline: none;
    font-family: inherit;
    font-size: 13px;
    /* The stack is a positioning context: every toast is absolute inside it, which is what
       lets the ones behind be clipped to the front one's height. */
    transition: transform 350ms ease;
}

@media (prefers-color-scheme: light) {
    [data-enigma-toaster] {
        --enigma-toast-bg: #ffffff;
        --enigma-toast-border: #e5e5e5;
        --enigma-toast-text: #171717;
        --enigma-toast-muted: #737373;
        --enigma-toast-shadow: 0 6px 22px rgb(0 0 0 / 12%);
        --enigma-toast-success-bg: hsl(143 85% 96%);
        --enigma-toast-success-border: hsl(145 92% 87%);
        --enigma-toast-success: hsl(140 100% 27%);
        --enigma-toast-error-bg: hsl(359 100% 97%);
        --enigma-toast-error-border: hsl(359 100% 94%);
        --enigma-toast-error: hsl(360 100% 45%);
        --enigma-toast-info-bg: hsl(208 100% 97%);
        --enigma-toast-info-border: hsl(221 91% 93%);
        --enigma-toast-info: hsl(210 92% 45%);
        --enigma-toast-warning-bg: hsl(49 100% 97%);
        --enigma-toast-warning-border: hsl(49 91% 84%);
        --enigma-toast-warning: hsl(31 92% 45%);
    }
}

[data-enigma-toaster][data-position^="top"] { top: var(--enigma-toast-edge); }
[data-enigma-toaster][data-position^="bottom"] { bottom: var(--enigma-toast-edge); }
[data-enigma-toaster][data-position$="-right"] { right: var(--enigma-toast-edge); }
[data-enigma-toaster][data-position$="-left"] { left: var(--enigma-toast-edge); }
[data-enigma-toaster][data-position$="-center"] { left: 50%; transform: translateX(-50%); }
/* The whole stack lifts a little when it fans out, so the front toast does not sit on the
   exact pixel it did a moment ago. */
[data-enigma-toaster][data-expanded][data-position^="bottom"] { transform: translateY(-6px); }
[data-enigma-toaster][data-expanded][data-position^="top"] { transform: translateY(6px); }
[data-enigma-toaster][data-expanded][data-position="bottom-center"] { transform: translateX(-50%) translateY(-6px); }
[data-enigma-toaster][data-expanded][data-position="top-center"] { transform: translateX(-50%) translateY(6px); }

[data-enigma-toast] {
    position: absolute;
    left: 0;
    right: 0;
    width: 100%;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 15px 16px;
    color: var(--enigma-toast-text);
    background: var(--enigma-toast-bg);
    border: 1px solid var(--enigma-toast-border);
    border-radius: var(--enigma-toast-radius);
    box-shadow: var(--enigma-toast-shadow);
    overflow-wrap: anywhere;
    touch-action: none;
    outline: none;
    z-index: var(--enigma-toast-z, 1);
    transition:
        transform var(--enigma-toast-enter) cubic-bezier(0.21, 1.02, 0.73, 1),
        opacity var(--enigma-toast-exit),
        height 350ms;
}

[data-enigma-toaster][data-position^="bottom"] [data-enigma-toast] { bottom: 0; transform-origin: bottom center; }
[data-enigma-toaster][data-position^="top"] [data-enigma-toast] { top: 0; transform-origin: top center; }

/* Enter from off screen, in the direction the stack is pinned to. */
[data-enigma-toaster][data-position^="bottom"] [data-enigma-toast] { transform: translateY(110%); opacity: 0; }
[data-enigma-toaster][data-position^="top"] [data-enigma-toast] { transform: translateY(-110%); opacity: 0; }
/* Scoped to the toaster so it OUTRANKS the enter rules above, which are scoped the same
   way: at equal specificity the later rule wins, and a mounted toast that lost this one sat
   at its entry offset forever - visible, and 110% of its own height off the bottom. */
[data-enigma-toaster] [data-enigma-toast][data-mounted] { opacity: 1; transform: translateY(0); }

/* Collapsed: the ones behind are clipped to the FRONT toast's height and scaled back, so
   the stack reads as depth rather than as a list. Their content is hidden but present -
   removing it would make the box jump when the stack expands. */
[data-enigma-toaster]:not([data-expanded]) [data-enigma-toast][data-mounted]:not([data-front]) {
    height: var(--enigma-toast-front-height);
    transform: translateY(calc(var(--enigma-toast-before) * var(--enigma-toast-peek) * -1))
        scale(calc(1 - var(--enigma-toast-before) * var(--enigma-toast-scale-step)));
}
[data-enigma-toaster][data-position^="top"]:not([data-expanded]) [data-enigma-toast][data-mounted]:not([data-front]) {
    transform: translateY(calc(var(--enigma-toast-before) * var(--enigma-toast-peek)))
        scale(calc(1 - var(--enigma-toast-before) * var(--enigma-toast-scale-step)));
}
[data-enigma-toaster]:not([data-expanded]) [data-enigma-toast]:not([data-front]) > * { opacity: 0; }
[data-enigma-toast] > * { transition: opacity 350ms; }

/* Expanded: each toast is lifted by the summed height of the ones in front of it. */
[data-enigma-toaster][data-expanded][data-position^="bottom"] [data-enigma-toast][data-mounted] {
    transform: translateY(calc(var(--enigma-toast-offset) * -1));
}
[data-enigma-toaster][data-expanded][data-position^="top"] [data-enigma-toast][data-mounted] {
    transform: translateY(var(--enigma-toast-offset));
}

/* Past the visible count it is still in the DOM, still counted, and not on screen. */
[data-enigma-toast][data-hidden] { opacity: 0; pointer-events: none; }

[data-enigma-toast][data-state="leaving"] { opacity: 0; }
[data-enigma-toaster]:not([data-expanded]) [data-enigma-toast][data-state="leaving"] { transform: translateY(150%) scale(0.9); }
[data-enigma-toaster][data-expanded][data-position^="bottom"] [data-enigma-toast][data-state="leaving"] {
    transform: translateY(calc(var(--enigma-toast-offset) * -1 + 110%));
}

/* While a finger is down the toast tracks it exactly: a transition here would lag behind the
   pointer, which reads as a broken gesture rather than a smooth one. */
[data-enigma-toast][data-swiping] {
    transition: opacity 200ms;
    transform: translateX(var(--enigma-toast-swipe, 0px));
}

[data-enigma-toast]:focus-visible { box-shadow: var(--enigma-toast-shadow), 0 0 0 2px var(--enigma-toast-info); }

[data-enigma-toast][data-tone="success"] {
    color: var(--enigma-toast-success);
    background: var(--enigma-toast-success-bg);
    border-color: var(--enigma-toast-success-border);
}
[data-enigma-toast][data-tone="error"] {
    color: var(--enigma-toast-error);
    background: var(--enigma-toast-error-bg);
    border-color: var(--enigma-toast-error-border);
}
[data-enigma-toast][data-tone="info"] {
    color: var(--enigma-toast-info);
    background: var(--enigma-toast-info-bg);
    border-color: var(--enigma-toast-info-border);
}
[data-enigma-toast][data-tone="warning"] {
    color: var(--enigma-toast-warning);
    background: var(--enigma-toast-warning-bg);
    border-color: var(--enigma-toast-warning-border);
}

[data-enigma-toast-icon] { display: flex; flex-shrink: 0; width: 20px; height: 20px; }
[data-enigma-toast-icon] svg { width: 20px; height: 20px; display: block; }
[data-enigma-toast-icon][data-tone="loading"] svg { animation: enigma-toast-spin 900ms linear infinite; }
@keyframes enigma-toast-spin { to { transform: rotate(360deg); } }

[data-enigma-toast-content] { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
[data-enigma-toast-title] { margin: 0; font-weight: 600; line-height: 1.4; }
[data-enigma-toast-body] { margin: 0; font-size: 12px; line-height: 1.45; opacity: 0.75; }

[data-enigma-toast-action] {
    flex-shrink: 0;
    padding: 5px 10px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--enigma-toast-bg);
    background: currentColor;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
}

[data-enigma-toast-close] {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    color: inherit;
    background: none;
    border: 0;
    border-radius: 5px;
    cursor: pointer;
    /* Shown on hover or focus, so it never covers the message while it is being read - but
       always reachable by keyboard, which display:none would take away. */
    opacity: 0;
    transition: opacity 120ms ease-out;
}
[data-enigma-toast]:hover [data-enigma-toast-close],
[data-enigma-toast-close]:focus-visible { opacity: 0.7; }
[data-enigma-toast-close]:hover { opacity: 1; }

@media (max-width: 600px) {
    [data-enigma-toaster] { right: 14px; left: 14px; width: auto; }
}

@media (prefers-reduced-motion: reduce) {
    /* The movement goes, the state change stays: a toast still appears and still leaves. */
    [data-enigma-toast], [data-enigma-toast] > * { transition: opacity 200ms !important; }
    [data-enigma-toast][data-mounted] { transform: none !important; }
}
`;
