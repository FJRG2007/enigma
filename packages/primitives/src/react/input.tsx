"use client";

import { INPUT_ICON_PATHS } from "@/core/input";
import {
    forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState,
    type ComponentPropsWithoutRef, type ChangeEvent, type ReactNode
} from "react";
import {
    generatePassword, estimatePasswordStrength,
    type GeneratePasswordOptions, type EstimateOptions, type PasswordStrengthReport, type PasswordScore
} from "@/core/password";

/**
 * `<Input>` - a real field you pass props to, with the affordances a password field needs
 * and none of the styling.
 *
 * Everything here is rendered by React. The imperative `createInput` is the adapter for
 * pages that are not React; using it from a component would mean two owners of the same
 * DOM, which is the thing that makes a wrapper feel wrong to work with.
 *
 * Nothing switches on by itself except the reveal, which a password field always wants.
 * The generator, the strength meter and the breach check are props, because they belong on
 * a registration or change-password form and are noise anywhere else.
 */

const ICON_PROPS = {
    viewBox: "0 0 24 24", width: "1em", height: "1em", fill: "none",
    stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
    "aria-hidden": true
} as const;

function Icon({ paths }: { paths: readonly string[]; }): ReactNode {
    return <svg {...ICON_PROPS}>{paths.map((path) => <path key={path} d={path} />)}</svg>;
}

/** An extra button inside the field. The built-ins are the same shape. */
export interface FieldAction {
    /** Stable id. Lands on `data-enigma-input-action`, and replaces a built-in of the same name. */
    name: string;
    /** Accessible name. Becomes `aria-label` and `title`. */
    label: string;
    icon: ReactNode;
    onSelect: () => void;
    /** Renders `aria-pressed`. Omit for actions that are not toggles. */
    pressed?: boolean;
    /** Default true. A false action is not rendered at all. */
    visible?: boolean;
}

export type BreachStatus = "idle" | "checking" | "safe" | "breached" | "error";

export interface BreachState {
    status: BreachStatus;
    /** How many breaches the password appears in. 0 unless `status` is "breached". */
    count: number;
    /** Whatever the checker threw. The form decides whether that is worth showing. */
    error: unknown;
}

export type BreachChecker = (password: string, options: { signal: AbortSignal; }) => Promise<{ breached: boolean; count: number; }>;

export interface InputProps extends Omit<ComponentPropsWithoutRef<"input">, "children"> {
    /** The reveal toggle. Defaults to on for `type="password"` and off for everything else. */
    reveal?: boolean;
    revealLabels?: { show?: string; hide?: string; };
    /** Offer to generate a password. `true` for the defaults, or the generator's options. */
    generate?: boolean | GeneratePasswordOptions;
    generateLabel?: string;
    /** Show what was generated. On by default - a password nobody can read is not usable. */
    revealOnGenerate?: boolean;
    /**
     * Also copy it to the clipboard. OFF by default and worth leaving off: the clipboard is
     * shared with every other app on the machine and is not cleared.
     */
    copyOnGenerate?: boolean;
    onGenerate?: (password: string) => void;
    /** Extra buttons, or a replacement for `reveal` / `generate` by name. */
    actions?: FieldAction[];
    /** Which end the buttons sit at. Position them yourself; this only orders the markup. */
    position?: "start" | "end";
    /** Score the password as it is typed, and render the meter under the field. */
    strength?: boolean | EstimateOptions;
    onStrengthChange?: (report: PasswordStrengthReport) => void;
    /**
     * Check the password against a breach corpus - pass `checkPasswordBreach` from
     * @enigmax/utils, or your own. It is a prop rather than a built-in because it makes a
     * network request, and that is not a decision a field should take on its own.
     */
    breach?: BreachChecker;
    /** Quiet time before a check fires, in ms. Default 500. */
    breachDelay?: number;
    onBreachChange?: (state: BreachState) => void;
    /** Props for the element wrapping the field, its buttons and the meter. */
    wrapperProps?: ComponentPropsWithoutRef<"div">;
    /** Props for the row holding the field and its buttons - this is what you position. */
    fieldProps?: ComponentPropsWithoutRef<"div">;
    /**
     * Classes for the parts you cannot reach with a ref, which is what Tailwind needs.
     * `className` still goes to the `<input>` itself, where you would expect it.
     */
    classNames?: {
        actions?: string;
        action?: string;
        strength?: PasswordStrengthProps["classNames"];
    };
    /** Rendered inside the wrapper, after the meter. Your error message goes here. */
    children?: ReactNode;
}

/**
 * Write a value the way a keystroke would.
 *
 * Assigning `input.value` directly is invisible to React: it tracks the last value it
 * rendered and skips the change event when the DOM disagrees with it. Going through the
 * prototype's setter and dispatching a bubbling `input` event makes the generator behave
 * exactly like typing - which is what makes it work with a controlled field, an
 * uncontrolled one, and a form library, without knowing which it is in.
 */
function writeValue(input: HTMLInputElement, next: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, next);
    else input.value = next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({
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
    wrapperProps,
    fieldProps,
    classNames,
    children,
    type = "text",
    onChange,
    ...props
}, forwardedRef) {
    const innerRef = useRef<HTMLInputElement | null>(null);
    const [revealed, setRevealed] = useState(false);
    const describedBy = useId();

    const isPassword = type === "password";
    const showReveal = reveal ?? isPassword;
    const showGenerate = generate !== false && isPassword;

    // Tracked whether the field is controlled or not, because the meter and the breach
    // check need the current value and an uncontrolled field never reports it as a prop.
    const controlled = props.value !== undefined;
    const [ownValue, setOwnValue] = useState(String(props.defaultValue ?? ""));
    const value = controlled ? String(props.value ?? "") : ownValue;

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

    /* -------- the generator -------- */

    const handleGenerate = useCallback(() => {
        const input = innerRef.current;
        if (!input) return;
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

    /* -------- strength -------- */

    const estimateOptions = typeof strength === "object" ? strength : undefined;
    const userInputs = estimateOptions?.userInputs;
    const report = useMemo(
        () => (strength === false ? null : estimatePasswordStrength(value, { userInputs })),
        // The array is compared by identity, so a literal would re-estimate every render.
        [strength, value, userInputs]
    );

    const strengthListener = useRef(onStrengthChange);
    strengthListener.current = onStrengthChange;
    useEffect(() => {
        if (report) strengthListener.current?.(report);
    }, [report]);

    /* -------- the breach check -------- */

    const [breachState, setBreachState] = useState<BreachState>({ status: "idle", count: 0, error: null });
    const breachListener = useRef(onBreachChange);
    breachListener.current = onBreachChange;

    useEffect(() => {
        if (!breach || !value) {
            setBreachState({ status: "idle", count: 0, error: null });
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            setBreachState({ status: "checking", count: 0, error: null });
            breach(value, { signal: controller.signal })
                .then((result) => {
                    if (controller.signal.aborted) return;
                    setBreachState({ status: result.breached ? "breached" : "safe", count: result.count, error: null });
                })
                .catch((error: unknown) => {
                    // An abort is this effect cleaning up after itself, not a failure.
                    if (controller.signal.aborted) return;
                    setBreachState({ status: "error", count: 0, error });
                });
        }, breachDelay);

        return () => {
            clearTimeout(timer);
            // Cancels the request in flight, so the answer to a password that is three
            // keystrokes old can never overwrite the answer to the current one.
            controller.abort();
        };
    }, [breach, value, breachDelay]);

    useEffect(() => {
        breachListener.current?.(breachState);
    }, [breachState]);

    /* -------- rendering -------- */

    const builtIn: FieldAction[] = [];
    if (showGenerate) {
        builtIn.push({
            name: "generate",
            label: generateLabel,
            icon: <Icon paths={INPUT_ICON_PATHS.generate} />,
            onSelect: handleGenerate
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

    const overridden = new Set(actions.map((action) => action.name));
    const rendered = [...builtIn.filter((action) => !overridden.has(action.name)), ...actions]
        .filter((action) => action.visible !== false);

    const locked = props.disabled === true || props.readOnly === true;
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

    return (
        <div
            {...wrapperProps}
            data-enigma-input-root=""
            data-revealed={revealed ? "" : undefined}
            data-breached={breachState.status === "breached" ? "" : undefined}
            data-score={report && !report.empty ? report.score : undefined}
        >
            <div {...fieldProps} data-enigma-input-field="">
                {position === "start" && buttons}
                <input
                    {...props}
                    ref={(node) => {
                        innerRef.current = node;
                        if (typeof forwardedRef === "function") forwardedRef(node);
                        else if (forwardedRef) forwardedRef.current = node;
                    }}
                    // Revealing a password is a type switch, which is what the caret dance
                    // above exists for.
                    type={revealed && isPassword ? "text" : type}
                    onChange={handleChange}
                    data-enigma-input=""
                    aria-describedby={report ? describedBy : props["aria-describedby"]}
                />
                {position === "end" && buttons}
            </div>
            {report && <PasswordStrength id={describedBy} report={report} classNames={classNames?.strength} />}
            {children}
        </div>
    );
});

const SCORE_LABELS = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;

export interface PasswordStrengthProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
    /** The password to score. Ignored when `report` is given. */
    value?: string;
    /** A report you already have, e.g. from `<Input onStrengthChange>`. */
    report?: PasswordStrengthReport;
    userInputs?: string[];
    /** Bars to draw. Five, so each score has one of its own. */
    segments?: number;
    /** Your own wording, worst first. */
    labels?: readonly string[];
    /** Show the top warning under the bars. On by default; it is the useful half. */
    showWarning?: boolean;
    /**
     * Classes for the inner parts. The score is on the ROOT, so a segment colours itself
     * with a group variant - `group-data-[score=0]/strength:bg-red-600` and so on.
     */
    classNames?: { track?: string; segment?: string; label?: string; warning?: string; };
}

/**
 * The bars under a password field.
 *
 * Structure and state only - `data-score` on the root and `data-filled` per segment are
 * where the colours attach. The component picks no colours, because red-through-green is a
 * palette decision and this package does not own one.
 */
export function PasswordStrength({
    value = "",
    report,
    userInputs,
    segments = 5,
    labels = SCORE_LABELS,
    showWarning = true,
    classNames,
    ...props
}: PasswordStrengthProps): ReactNode {
    const computed = useMemo(
        () => report ?? estimatePasswordStrength(value, { userInputs }),
        [report, value, userInputs]
    );

    const score: PasswordScore = computed.score;
    return (
        <div
            {...props}
            data-enigma-password-strength=""
            data-score={computed.empty ? undefined : score}
            data-empty={computed.empty ? "" : undefined}
        >
            <div data-enigma-password-strength-track="" aria-hidden="true" className={classNames?.track}>
                {Array.from({ length: segments }, (unused, index) => (
                    <span
                        key={index}
                        data-enigma-password-strength-segment=""
                        className={classNames?.segment}
                        // Score 0 still fills one bar: an empty track next to a filled
                        // field reads as "not measured", not as "this is a bad password".
                        data-filled={!computed.empty && index <= score ? "" : undefined}
                    />
                ))}
            </div>
            {/* Announced when the band changes, which is rarely enough not to chatter. */}
            <p data-enigma-password-strength-label="" role="status" aria-live="polite" className={classNames?.label}>
                {computed.empty ? "" : labels[score] ?? ""}
            </p>
            {showWarning && !computed.empty && computed.warnings.length > 0 && (
                <p data-enigma-password-strength-warning="" className={classNames?.warning}>{computed.warnings[0]}</p>
            )}
        </div>
    );
}
