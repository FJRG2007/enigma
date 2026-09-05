"use client";

import { writeValue } from "@/react/input/write-value";
import { ColorSwatch } from "@/react/input/color-swatch";
import { COLOR_STYLES } from "@/react/input/color-styles";
import type { ColorLabels, ColorPanelPlacement } from "@/react/input/types";
import { parseColor, formatColor, rgbToHsv, hsvToRgb, toHex, colorEquals, type Hsv, type ColorFormat } from "@/core/color";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

/**
 * The colour picker for `<Input type="color">`: the swatch in the field, and the panel it
 * opens - a saturation/brightness square, a hue rail, an optional alpha rail, presets, and
 * the browser's eyedropper where there is one.
 *
 * Its own chunk, imported the moment a colour field is rendered, so a form of text and email
 * fields downloads none of it - the same arrangement the password meter and the search engine
 * are in.
 *
 * WHY NOT THE NATIVE ONE. `<input type="color">` opens a picker drawn by the OPERATING
 * SYSTEM: unstylable, different on every platform, with no presets, no alpha, and a value
 * that can only ever be `#rrggbb`. It also cannot be read or typed into, which is the fastest
 * way to enter a colour anyone already has. So the field stays a TEXT input holding the
 * canonical string - typed, pasted and submitted like any other value - and the swatch opens
 * this panel beside it.
 *
 * The value in the field is the single source of truth, with one exception that is the whole
 * reason this component keeps state: HSV. Hue is undefined at black, at white and at every
 * grey, so recomputing it from the field's RGB resets the rail to red the moment the square
 * is dragged into a corner. `core/color.ts` documents that trap; the state below is what
 * avoids it.
 */

/** What the browser's colour dropper resolves to. Typed here because the DOM lib has no entry. */
interface EyeDropperResult {
    sRGBHex: string;
}

interface EyeDropperApi {
    new(): { open(options?: { signal?: AbortSignal; }): Promise<EyeDropperResult>; };
}

/** Nothing chosen yet: black, and a hue of 0, which is what the rails open on. */
const INITIAL: Hsv = { h: 0, s: 0, v: 0, a: 1 };

/** An arrow key's step, and what Shift multiplies it by. */
const STEP = { fine: 0.01, coarse: 0.1, hue: 1, hueCoarse: 10 };

/** Kept clear of the window edge when deciding which side to open on. */
const MARGIN = 12;

/** The notations the readout cycles through, in the order the button steps over them. */
const FORMATS: ColorFormat[] = ["hex", "rgb", "hsl"];
const FORMAT_LABELS: Record<ColorFormat, string> = { hex: "HEX", rgb: "RGB", hsl: "HSL" };

let injected = false;

function injectStyles(): void {
    if (injected || typeof document === "undefined") return;
    injected = true;
    if (document.querySelector("[data-enigma-color-styles]")) return;
    const element = document.createElement("style");
    element.setAttribute("data-enigma-color-styles", "");
    element.textContent = COLOR_STYLES;
    document.head.prepend(element);
}

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

export interface ColorExtrasProps {
    /** The field the value lives in. Null for the one render before it mounts. */
    input: HTMLInputElement | null;
    /** What the field currently holds, parseable or not. */
    value: string;
    format?: ColorFormat;
    alpha?: boolean;
    swatches?: readonly string[];
    eyedropper?: boolean;
    placement?: ColorPanelPlacement;
    styles?: boolean;
    /** The field is disabled or read-only: the swatch is inert and the panel never opens. */
    locked?: boolean;
    /**
     * The swatch was already pressed, while this module was still being fetched. Opens the
     * panel on the first render rather than asking for the press a second time.
     */
    openOnMount?: boolean;
    labels?: ColorLabels;
}

export function ColorExtras({
    input,
    value,
    format = "hex",
    alpha = false,
    swatches,
    eyedropper = true,
    placement = "auto",
    styles = true,
    locked = false,
    openOnMount = false,
    labels
}: ColorExtrasProps): ReactNode {
    // Before paint: a sheet applied after the first frame shows the panel unstyled first.
    useLayoutEffect(() => { if (styles) injectStyles(); }, [styles]);

    const anchorRef = useRef<HTMLSpanElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const swatchRef = useRef<HTMLButtonElement | null>(null);
    const areaRef = useRef<HTMLDivElement | null>(null);

    const [open, setOpen] = useState(openOnMount && !locked);
    const [side, setSide] = useState<"top" | "bottom">(placement === "top" ? "top" : "bottom");

    const parsed = useMemo(() => parseColor(value), [value]);
    const [hsv, setHsv] = useState<Hsv>(() => (parsed ? rgbToHsv(parsed) : INITIAL));

    /**
     * The field changed under us - typed, pasted, reset by the form, set by the caller.
     *
     * Only when it says a DIFFERENT colour than the one the controls are already showing: a
     * value this component just wrote round-trips to the same RGB, and re-deriving HSV from
     * it would throw away the hue and saturation the square is standing on. `current.h` is
     * passed through for the greys, where the hue cannot be recovered from the bytes at all.
     */
    useEffect(() => {
        if (!parsed) return;
        setHsv((current) => (colorEquals(hsvToRgb(current), parsed) ? current : rgbToHsv(parsed, current.h)));
    }, [parsed]);

    const rgb = useMemo(() => hsvToRgb(hsv), [hsv]);

    const commit = useCallback((next: Hsv) => {
        setHsv(next);
        if (input) writeValue(input, formatColor(hsvToRgb(next), format, { alpha }));
    }, [input, format, alpha]);

    /**
     * What was typed, put into the canonical form - on BLUR and never before it.
     *
     * `#3b8` and `RGB(59 130 246)` are the same colour as what the picker writes, and storing
     * either alongside the other means two spellings of one value in the database. Rewriting
     * while the caret is still in the field would fight every keystroke, so it waits for the
     * field to be left, which is the rule the validation policy sets for normalizing.
     */
    useEffect(() => {
        if (!input) return;
        const onBlur = (): void => {
            const colour = parseColor(input.value);
            if (!colour) return;
            const canonical = formatColor(colour, format, { alpha });
            if (canonical !== input.value) writeValue(input, canonical);
        };
        input.addEventListener("blur", onBlur);
        return () => input.removeEventListener("blur", onBlur);
    }, [input, format, alpha]);

    const setOpenState = useCallback((next: boolean) => {
        setOpen((current) => (current === next ? current : next));
    }, []);

    const close = useCallback((focusSwatch: boolean) => {
        setOpenState(false);
        // Only when focus is still inside the panel that is going away. Taking it back after
        // the visitor has clicked somewhere else would drag them out of what they just chose.
        if (focusSwatch) swatchRef.current?.focus();
    }, [setOpenState]);

    /* -------- where the panel goes, and what dismisses it -------- */

    const place = useCallback(() => {
        if (placement !== "auto") return setSide(placement);
        const anchor = anchorRef.current?.getBoundingClientRect();
        const panel = panelRef.current?.getBoundingClientRect();
        if (!anchor || !panel) return;
        const below = window.innerHeight - anchor.bottom;
        // Flipped only when there is genuinely more room the other way: near the bottom of the
        // window an unflipped panel hangs off the screen and its rails cannot be reached.
        setSide(below < panel.height + MARGIN && anchor.top > below ? "top" : "bottom");
    }, [placement]);

    useLayoutEffect(() => {
        if (!open) return;
        place();
    }, [open, place]);

    useEffect(() => {
        if (!open) return;
        // Focus goes into the panel, because the press that opened it was on a control the
        // keyboard has to be able to keep using. The square is what the arrows drive.
        areaRef.current?.focus();

        const inside = (target: EventTarget | null): boolean => Boolean(anchorRef.current?.contains(target as Node | null));
        const onPointerDown = (event: globalThis.PointerEvent): void => { if (!inside(event.target)) setOpenState(false); };
        /**
         * Tabbing out closes it. `document.body` is skipped on purpose: pressing the panel's
         * own padding moves focus there, and treating that as leaving would shut the panel
         * every time somebody clicks a gap between two controls.
         */
        const onFocusIn = (event: FocusEvent): void => {
            if (event.target === document.body || inside(event.target)) return;
            setOpenState(false);
        };
        const onResize = (): void => place();

        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("focusin", onFocusIn, true);
        window.addEventListener("resize", onResize);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("focusin", onFocusIn, true);
            window.removeEventListener("resize", onResize);
        };
    }, [open, place, setOpenState]);

    /* -------- dragging -------- */

    /**
     * A press, and everything that follows it until the finger comes up.
     *
     * The pointer is CAPTURED, so a drag that leaves the square keeps steering it instead of
     * stopping at the edge - which is what makes the last 5% of saturation reachable. The
     * marquee's warning about capture does not apply here: it retargets the compatibility
     * mouse events, and there is nothing clickable inside these surfaces to lose them (the
     * handle is `pointer-events: none` for exactly this reason).
     */
    const track = useCallback((event: PointerEvent<HTMLElement>, onMove: (x: number, y: number) => void) => {
        if (event.button !== 0) return;
        const element = event.currentTarget;
        // Stops the press selecting the panel's text on the way, and the drag becoming a
        // browser image drag. Focus is then taken by hand, since preventDefault denies it.
        event.preventDefault();
        element.focus();

        const apply = (clientX: number, clientY: number): void => {
            const rect = element.getBoundingClientRect();
            onMove(
                rect.width ? clamp01((clientX - rect.left) / rect.width) : 0,
                rect.height ? clamp01((clientY - rect.top) / rect.height) : 0
            );
        };

        const move = (moved: globalThis.PointerEvent): void => apply(moved.clientX, moved.clientY);
        const stop = (): void => {
            element.removeEventListener("pointermove", move);
            element.removeEventListener("pointerup", stop);
            element.removeEventListener("pointercancel", stop);
        };
        element.addEventListener("pointermove", move);
        element.addEventListener("pointerup", stop);
        element.addEventListener("pointercancel", stop);
        try { element.setPointerCapture(event.pointerId); } catch { /* a pointer already gone */ }

        apply(event.clientX, event.clientY);
    }, []);

    /* -------- the keyboard, which is the same control by other means -------- */

    const areaKeys = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? STEP.coarse : STEP.fine;
        const moves: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step]
        };
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        commit({ ...hsv, s: clamp01(hsv.s + move[0]), v: clamp01(hsv.v + move[1]) });
    }, [commit, hsv]);

    const railKeys = useCallback((event: KeyboardEvent<HTMLDivElement>, kind: "hue" | "alpha") => {
        const step = kind === "hue"
            ? (event.shiftKey ? STEP.hueCoarse : STEP.hue)
            : (event.shiftKey ? STEP.coarse : STEP.fine);
        const max = kind === "hue" ? 360 : 1;
        const at = kind === "hue" ? hsv.h : hsv.a;

        let next = at;
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = at - step;
        else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = at + step;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = max;
        else return;

        event.preventDefault();
        // The hue rail WRAPS, because the spectrum does: stopping at red on one side and
        // magenta on the other makes half the wheel a long walk back.
        const value = kind === "hue" ? ((next % 360) + 360) % 360 : clamp01(next);
        commit(kind === "hue" ? { ...hsv, h: value } : { ...hsv, a: value });
    }, [commit, hsv]);

    /* -------- the eyedropper, when the browser has one -------- */

    const dropper = eyedropper && typeof window !== "undefined" && "EyeDropper" in window;

    const pick = useCallback(async () => {
        const api = (window as unknown as { EyeDropper?: EyeDropperApi; }).EyeDropper;
        if (!api) return;
        try {
            const result = await new api().open();
            const colour = parseColor(result.sRGBHex);
            // The dropper reads an opaque pixel, so the alpha in hand is kept rather than
            // reset: someone picking a colour for a 40% overlay wants the colour, not the 100%.
            if (colour) commit(rgbToHsv({ ...colour, a: hsv.a }, hsv.h));
        } catch {
            // Dismissed with Escape, or refused. Neither is worth reporting: nothing changed.
        }
    }, [commit, hsv]);

    /* -------- the readout, which is the value in whichever notation you want to read it -------- */

    /**
     * Which notation the panel PRINTS the colour in, and only that.
     *
     * `format` is the caller's contract - the spelling their column, their API or their CSS
     * expects - so cycling this button never changes what is written into the field. It
     * changes what you can read out of the panel and paste elsewhere, which is what the
     * browser's own picker offers and what a picker showing no code at all cannot.
     */
    const [shown, setShown] = useState<ColorFormat>(format);
    useEffect(() => setShown(format), [format]);

    /** What is being typed, while it is being typed. Null means "show the current colour". */
    const [draft, setDraft] = useState<string | null>(null);

    const readout = useMemo(() => formatColor(rgb, shown, { alpha }), [rgb, shown, alpha]);
    const nextFormat = FORMATS[(FORMATS.indexOf(shown) + 1) % FORMATS.length] as ColorFormat;

    const typed = useCallback((next: string) => {
        setDraft(next);
        const colour = parseColor(next);
        // Applied as it becomes a colour, so the square and the rails follow a pasted value
        // rather than waiting for a blur. Half-typed text simply is not one yet.
        if (colour) commit(rgbToHsv(alpha ? colour : { ...colour, a: 1 }, hsv.h));
    }, [commit, alpha, hsv.h]);

    /* -------- rendering -------- */

    const css = useMemo(() => formatColor(rgb, "hex", { alpha: true }), [rgb]);
    const opaque = useMemo(() => toHex({ ...rgb, a: 1 }), [rgb]);
    const text = labels ?? {};
    const valueText = `${text.color ?? "Colour"} ${css}`;

    const panelStyle = { "--enigma-color-hue": Math.round(hsv.h), "--enigma-color-opaque": opaque } as CSSProperties;

    return (
        <ColorSwatch
            anchorRef={anchorRef}
            buttonRef={swatchRef}
            value={css}
            invalid={!parsed}
            open={open}
            locked={locked}
            label={text.open ?? "Pick a colour"}
            onPress={() => (open ? close(true) : setOpenState(true))}
        >
            {open && !locked && (
                <div
                    ref={panelRef}
                    data-enigma-color-panel=""
                    data-side={side}
                    role="dialog"
                    aria-label={text.panel ?? "Colour picker"}
                    style={panelStyle}
                    onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.stopPropagation();
                        close(true);
                    }}
                >
                    {/*
                        There is no ARIA role for a two-dimensional slider, and inventing one
                        announces nothing. `slider` with saturation as the number is the closest
                        honest fit - the arrows drive both axes and `aria-valuetext` says what
                        the number alone cannot, including the colour it lands on.
                    */}
                    <div
                        ref={areaRef}
                        data-enigma-color-area=""
                        role="slider"
                        tabIndex={0}
                        aria-label={text.area ?? "Saturation and brightness"}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(hsv.s * 100)}
                        aria-valuetext={`${Math.round(hsv.s * 100)}% saturation, ${Math.round(hsv.v * 100)}% brightness, ${valueText}`}
                        onKeyDown={areaKeys}
                        onPointerDown={(event) => track(event, (x, y) => commit({ ...hsv, s: x, v: 1 - y }))}
                    >
                        <span data-enigma-color-thumb="" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
                    </div>

                    <div data-enigma-color-controls="">
                        {/* The chosen colour, over the chequerboard, so an alpha of 40% reads
                            as transparent rather than as a paler colour. */}
                        <span data-enigma-color-preview="" data-enigma-color-checkers="">
                            <span data-enigma-color-fill="" style={{ background: css }} />
                        </span>

                        {/* Feature-detected rather than assumed: `EyeDropper` is Chromium-only,
                            and a button that throws on Safari is worse than no button. */}
                        {dropper && (
                            <button
                                type="button"
                                data-enigma-color-eyedropper=""
                                aria-label={text.eyedropper ?? "Pick a colour from the screen"}
                                title={text.eyedropper ?? "Pick a colour from the screen"}
                                onClick={() => { void pick(); }}
                            >
                                <EyedropperIcon />
                            </button>
                        )}

                        <div data-enigma-color-rails="">
                            <div
                                data-enigma-color-rail="hue"
                                role="slider"
                                tabIndex={0}
                                aria-label={text.hue ?? "Hue"}
                                aria-valuemin={0}
                                aria-valuemax={360}
                                aria-valuenow={Math.round(hsv.h)}
                                aria-valuetext={`${Math.round(hsv.h)} degrees`}
                                onKeyDown={(event) => railKeys(event, "hue")}
                                onPointerDown={(event) => track(event, (x) => commit({ ...hsv, h: x * 360 }))}
                            >
                                <span data-enigma-color-thumb="" style={{ left: `${(hsv.h / 360) * 100}%` }} />
                            </div>

                            {alpha && (
                                <div
                                    data-enigma-color-rail="alpha"
                                    data-enigma-color-checkers=""
                                    role="slider"
                                    tabIndex={0}
                                    aria-label={text.alpha ?? "Opacity"}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round(hsv.a * 100)}
                                    aria-valuetext={`${Math.round(hsv.a * 100)}% opacity`}
                                    onKeyDown={(event) => railKeys(event, "alpha")}
                                    onPointerDown={(event) => track(event, (x) => commit({ ...hsv, a: x }))}
                                >
                                    <span data-enigma-color-gradient="" />
                                    <span data-enigma-color-thumb="" style={{ left: `${hsv.a * 100}%` }} />
                                </div>
                            )}
                        </div>
                    </div>

                    {/* The colour as text, editable, with the notation next to it. A picker
                        that shows no code is one you cannot read a value out of, cannot paste
                        one into, and cannot check against the hex somebody sent you. */}
                    <div data-enigma-color-value="">
                        <button
                            type="button"
                            data-enigma-color-format=""
                            aria-label={`${text.formatAs ?? "Show as"} ${FORMAT_LABELS[nextFormat]}`}
                            title={`${text.formatAs ?? "Show as"} ${FORMAT_LABELS[nextFormat]}`}
                            onClick={() => { setShown(nextFormat); setDraft(null); }}
                        >
                            {FORMAT_LABELS[shown]}
                        </button>
                        <input
                            type="text"
                            data-enigma-color-input=""
                            value={draft ?? readout}
                            aria-label={text.value ?? "Colour value"}
                            spellCheck={false}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            onChange={(event) => typed(event.target.value)}
                            // What was typed goes back to the canonical spelling the moment the
                            // field is left, the way the input itself normalizes on blur.
                            onBlur={() => setDraft(null)}
                            onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                setDraft(null);
                            }}
                        />
                    </div>

                    {swatches && swatches.length > 0 && (
                        <div data-enigma-color-swatches="" role="group" aria-label={text.swatches ?? "Preset colours"}>
                            {swatches.map((preset) => {
                                const colour = parseColor(preset);
                                return (
                                    <button
                                        key={preset}
                                        type="button"
                                        data-enigma-color-preset=""
                                        data-enigma-color-checkers=""
                                        style={{ background: preset }}
                                        // The value IS the name. A guessed one ("dark blue")
                                        // would be a label nobody wrote and half of them wrong.
                                        aria-label={preset}
                                        title={preset}
                                        aria-pressed={colourEqualsPreset(colour, css)}
                                        onClick={() => { if (colour) commit(rgbToHsv(alpha ? colour : { ...colour, a: 1 }, hsv.h)); }}
                                    />
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </ColorSwatch>
    );
}

/** Whether a preset is the colour currently chosen, compared as colours and not as strings. */
function colourEqualsPreset(preset: ReturnType<typeof parseColor>, current: string): boolean {
    return colorEquals(preset, parseColor(current));
}

/** Drawn rather than loaded, like every other icon here: an SVG file would be a request. */
function EyedropperIcon(): ReactNode {
    return (
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m2 22 1-1h3l9-9" />
            <path d="M3 21v-3l9-9" />
            <path d="m15 6 3-3a2.83 2.83 0 0 1 4 4l-3 3-1-1-4 4-3-3 4-4Z" />
        </svg>
    );
}
