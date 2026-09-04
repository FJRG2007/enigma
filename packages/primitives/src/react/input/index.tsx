"use client";

import { Icon } from "@/react/input/icon";
import { INPUT_ICON_PATHS } from "@/core/input-icons";
import { writeValue } from "@/react/input/write-value";
import type { AnyInputProps, InputProps, FieldAction, BreachState } from "@/react/input/types";
import { forwardRef, lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";

/**
 * `<Input>` - one field for every `type`, with the affordances each type needs and none of
 * the styling.
 *
 * ```tsx
 * <Input type="email" required />
 * <Input type="password" generate strength breach={checkPasswordBreach} />
 * <Input type="search" items={docs} keys={["title"]} renderResults={...} />
 * <Input type="color" alpha swatches={brand} />
 * ```
 *
 * ONE component keyed on `type`, because that is what HTML is: `type` is an attribute of a
 * single element. What differs per type is which PROPS exist, and that is a discriminated
 * union - `strength` on a text field is a compile error rather than a prop that silently
 * does nothing. Widgets that are not one `<input>` stay their own components; the search
 * PALETTE is a dialog, so it lives in `SearchPalette` rather than behind a prop here.
 *
 * WHAT LOADS. The field, its buttons and the reveal are this module and nothing else. The
 * password estimator, the breach watcher, the search engine and the colour picker each live
 * in their own chunk and are imported the moment the type that needs them is used - so a form
 * of text and email fields ships none of them, and a page with one password field pays for
 * neither search nor a colour wheel.
 * The generator is loaded on the first press of its button, because until then it is a
 * function nobody has called.
 */

/**
 * What a colour field is given that a text field is not.
 *
 * Spread BEFORE `{...rest}`, so every one of them is still the caller's to override. A hex
 * string is not a word, not a saved form value, and not something to capitalize - and an
 * autocomplete menu over a colour field covers the panel that just opened.
 */
const COLOR_FIELD_PROPS = {
    autoComplete: "off",
    autoCorrect: "off",
    autoCapitalize: "off",
    spellCheck: false
} as const;

const PasswordExtras = lazy(() => import("@/react/input/password").then((module) => ({ default: module.PasswordExtras })));
const SearchExtras = lazy(() => import("@/react/input/search").then((module) => ({ default: module.SearchExtras })));
const ColorExtras = lazy(() => import("@/react/input/color").then((module) => ({ default: module.ColorExtras })));

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, forwardedRef) {
    const {
        reveal,
        revealLabels,
        generate = false,
        generateLabel = "Generate a password",
        revealOnGenerate = true,
        copyOnGenerate = false,
        onGenerate,
        actions = [],
        position = "end",
        strength = false,
        onStrengthChange,
        breach,
        breachDelay = 500,
        onBreachChange,
        items,
        keys,
        delay,
        limit,
        fuse,
        fuseOptions,
        matcher,
        onResults,
        renderResults,
        clearable,
        clearLabel = "Clear",
        format,
        alpha,
        swatches,
        eyedropper,
        placement,
        styles,
        colorLabels,
        wrapperProps,
        fieldProps,
        classNames,
        children,
        type = "text",
        onChange,
        ...rest
    } = props as AnyInputProps;

    const innerRef = useRef<HTMLInputElement | null>(null);
    const [element, setElement] = useState<HTMLInputElement | null>(null);
    const [revealed, setRevealed] = useState(false);
    const describedBy = useId();

    const isPassword = type === "password";
    const isSearch = type === "search";
    const isColor = type === "color";
    const showReveal = reveal ?? isPassword;
    const showGenerate = generate !== false && isPassword;
    const showClear = (clearable ?? isSearch) && isSearch;

    // Tracked whether the field is controlled or not, because the meter, the breach check
    // and the clear button need the current value, and an uncontrolled field never reports
    // it as a prop.
    const controlled = rest.value !== undefined;
    const [ownValue, setOwnValue] = useState(String(rest.defaultValue ?? ""));
    const value = controlled ? String(rest.value ?? "") : ownValue;

    const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
        if (!controlled) setOwnValue(event.target.value);
        onChange?.(event);
    }, [controlled, onChange]);

    /* -------- the reveal, and the caret it would otherwise eat -------- */

    // Captured BEFORE the type switch. Assigning `type` while an input is focused resets
    // the caret to 0 in Chromium, and it does it one MACROTASK later - so anything read
    // after the switch is already the clobbered value.
    const caret = useRef<[number, number] | null>(null);

    const toggleReveal = useCallback(() => {
        const input = innerRef.current;
        if (input && typeof document !== "undefined" && document.activeElement === input) {
            try {
                const { selectionStart, selectionEnd } = input;
                caret.current = selectionStart === null || selectionEnd === null ? null : [selectionStart, selectionEnd];
            } catch {
                caret.current = null;   // selection is not supported on every input type
            }
        }
        setRevealed((current) => !current);
    }, []);

    useEffect(() => {
        const selection = caret.current;
        if (!selection) return;
        caret.current = null;

        const restore = (): void => {
            const input = innerRef.current;
            if (!input || document.activeElement !== input) return;
            try { input.setSelectionRange(selection[0], selection[1]); } catch { /* unsupported */ }
        };
        restore();
        // And again on the next macrotask, which is where Chromium actually clobbers it.
        // A restore that only runs inline silently loses. Focus is re-checked first, so a
        // visitor who clicked elsewhere meanwhile is not dragged back.
        const timer = setTimeout(restore, 0);
        return () => clearTimeout(timer);
    }, [revealed]);

    /* -------- the generator, loaded when it is first pressed -------- */

    const handleGenerate = useCallback(async () => {
        const input = innerRef.current;
        if (!input) return;
        // Imported here rather than at the top: a form with a password field that nobody
        // ever asks to generate has no reason to carry a CSPRNG alphabet around.
        const { generatePassword } = await import("@/core/password");
        const password = generatePassword(typeof generate === "object" ? generate : {});
        writeValue(input, password);
        if (revealOnGenerate) setRevealed(true);
        if (copyOnGenerate) void navigator.clipboard?.writeText(password).catch(() => {
            // Denied permission or an insecure context. The password is in the field, which
            // is the part that matters, so there is nothing to report.
        });
        input.focus();
        onGenerate?.(password);
    }, [generate, revealOnGenerate, copyOnGenerate, onGenerate]);

    const handleClear = useCallback(() => {
        const input = innerRef.current;
        if (!input) return;
        writeValue(input, "");
        input.focus();
    }, []);

    /* -------- what the per-type chunks report back -------- */

    const [score, setScore] = useState<number | null>(null);
    const [breached, setBreached] = useState(false);

    const handleBreach = useCallback((state: BreachState) => {
        setBreached(state.status === "breached");
        onBreachChange?.(state);
    }, [onBreachChange]);

    /* -------- rendering -------- */

    const builtIn: FieldAction[] = [];
    if (showGenerate) {
        builtIn.push({
            name: "generate",
            label: generateLabel,
            icon: <Icon paths={INPUT_ICON_PATHS.generate} />,
            onSelect: () => { void handleGenerate(); }
        });
    }
    if (showReveal) {
        builtIn.push({
            name: "reveal",
            label: revealed ? revealLabels?.hide ?? "Hide password" : revealLabels?.show ?? "Show password",
            icon: <Icon paths={revealed ? INPUT_ICON_PATHS.eyeOff : INPUT_ICON_PATHS.eye} />,
            pressed: revealed,
            onSelect: toggleReveal
        });
    }
    if (showClear) {
        builtIn.push({
            name: "clear",
            label: clearLabel,
            icon: <Icon paths={INPUT_ICON_PATHS.clear} />,
            // Nothing to clear is nothing to press: the button would be a target that does
            // not respond, which reads as broken rather than as unavailable.
            visible: value.length > 0,
            onSelect: handleClear
        });
    }

    const overridden = new Set(actions.map((action) => action.name));
    const rendered = [...builtIn.filter((action) => !overridden.has(action.name)), ...actions]
        .filter((action) => action.visible !== false);

    const locked = rest.disabled === true || rest.readOnly === true;
    const buttons = rendered.length === 0 ? null : (
        <span data-enigma-input-actions="" data-position={position} className={classNames?.actions}>
            {rendered.map((action) => (
                <button
                    key={action.name}
                    type="button"
                    data-enigma-input-action={action.name}
                    className={classNames?.action}
                    aria-label={action.label}
                    title={action.label}
                    aria-pressed={action.pressed}
                    disabled={locked}
                    // Keeps focus in the field: the visitor is mid-word and expects to keep
                    // typing, and a caret that never left needs no restoring.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={action.onSelect}
                >
                    {action.icon}
                </button>
            ))}
        </span>
    );

    const wantsPasswordChunk = isPassword && (strength !== false || Boolean(breach));
    const wantsSearchChunk = isSearch && Boolean(items || matcher);

    return (
        <div
            {...wrapperProps}
            data-enigma-input-root=""
            data-revealed={revealed ? "" : undefined}
            data-breached={breached ? "" : undefined}
            data-score={score ?? undefined}
        >
            <div {...fieldProps} data-enigma-input-field="">
                {/* No fallback, for the reason the meter has none: the field is already on
                    screen and typeable, and a placeholder where a swatch is about to appear
                    would be a second layout shift rather than one. */}
                {isColor && (
                    <Suspense fallback={null}>
                        <ColorExtras
                            input={element}
                            value={value}
                            format={format}
                            alpha={alpha}
                            swatches={swatches}
                            eyedropper={eyedropper}
                            placement={placement}
                            styles={styles}
                            locked={locked}
                            labels={colorLabels}
                        />
                    </Suspense>
                )}
                {position === "start" && buttons}
                <input
                    {...(isColor ? COLOR_FIELD_PROPS : null)}
                    {...rest}
                    ref={(node) => {
                        innerRef.current = node;
                        setElement(node);
                        if (typeof forwardedRef === "function") forwardedRef(node);
                        else if (forwardedRef) forwardedRef.current = node;
                    }}
                    // Revealing a password is a type switch, which is what the caret dance
                    // above exists for. A colour field is a TEXT one in the DOM: the native
                    // `type="color"` renders a swatch whose popup is the operating system's -
                    // unstylable, alpha-less, and impossible to type or paste a value into.
                    type={isColor ? "text" : revealed && isPassword ? "text" : type}
                    onChange={handleChange}
                    data-enigma-input=""
                    aria-describedby={score !== null ? describedBy : rest["aria-describedby"]}
                />
                {position === "end" && buttons}
            </div>
            {/* No fallback: the field is already on screen and usable, and a spinner where a
                meter is about to appear moves the layout twice for nothing. */}
            {wantsPasswordChunk && (
                <Suspense fallback={null}>
                    <PasswordExtras
                        id={describedBy}
                        value={value}
                        strength={strength}
                        onStrengthChange={onStrengthChange}
                        onScore={setScore}
                        breach={breach}
                        breachDelay={breachDelay}
                        onBreachChange={handleBreach}
                        classNames={classNames?.strength}
                    />
                </Suspense>
            )}
            {wantsSearchChunk && (
                <Suspense fallback={null}>
                    <SearchExtras
                        input={element}
                        items={items}
                        keys={keys}
                        delay={delay}
                        limit={limit}
                        fuse={fuse}
                        fuseOptions={fuseOptions}
                        matcher={matcher}
                        onResults={onResults}
                        renderResults={renderResults}
                    />
                </Suspense>
            )}
            {children}
        </div>
    );
}) as <Item = unknown>(props: InputProps<Item> & { ref?: React.Ref<HTMLInputElement>; }) => ReactNode;

/**
 * Types only. A VALUE re-export here (`PasswordStrength`, say) would be a static edge into
 * the password chunk, and a static edge is exactly what stops it being a chunk: the bundler
 * would fold it back into whatever imports `Input`. The entry re-exports it instead, where
 * an unused export is dropped.
 */
export type {
    InputProps, InputBaseProps, InputType, FieldAction,
    BreachChecker, BreachState, BreachStatus,
    ColorLabels, ColorPanelPlacement,
    PasswordOnlyProps, SearchOnlyProps, ColorOnlyProps, PlainOnlyProps
} from "@/react/input/types";
