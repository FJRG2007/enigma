"use client";

import type { BreachChecker, BreachState, PasswordStrengthClassNames } from "@/react/input/types";
import { useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { estimatePasswordStrength, type EstimateOptions, type PasswordStrengthReport, type PasswordScore } from "@/core/password";

/**
 * Everything only a password field needs: the estimator, the meter and the breach watcher.
 *
 * Its own chunk. `<Input>` imports it dynamically the moment a password field asks for
 * `strength` or `breach`, so a form of text and email fields never downloads a word list, an
 * entropy table or an abort controller it has no use for. Nothing here is imported by the
 * field statically - that would fold the chunk straight back into it.
 */

const SCORE_LABELS = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;

export interface PasswordExtrasProps {
    /** Id the field points `aria-describedby` at. */
    id: string;
    value: string;
    strength: boolean | EstimateOptions;
    onStrengthChange?: (report: PasswordStrengthReport) => void;
    /** Reports the score up so the ROOT can carry `data-score` for a theme to style. */
    onScore: (score: number | null) => void;
    breach?: BreachChecker;
    breachDelay: number;
    onBreachChange: (state: BreachState) => void;
    classNames?: PasswordStrengthClassNames;
}

export function PasswordExtras({
    id,
    value,
    strength,
    onStrengthChange,
    onScore,
    breach,
    breachDelay,
    onBreachChange,
    classNames
}: PasswordExtrasProps): ReactNode {
    const estimateOptions = typeof strength === "object" ? strength : undefined;
    const userInputs = estimateOptions?.userInputs;
    const report = useMemo(
        () => (strength === false ? null : estimatePasswordStrength(value, { userInputs })),
        // The array is compared by identity, so a literal would re-estimate every render.
        [strength, value, userInputs]
    );

    const strengthListener = useRef(onStrengthChange);
    strengthListener.current = onStrengthChange;
    const scoreListener = useRef(onScore);
    scoreListener.current = onScore;

    useEffect(() => {
        if (!report) return;
        strengthListener.current?.(report);
        scoreListener.current(report.empty ? null : report.score);
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
        breachListener.current(breachState);
    }, [breachState]);

    if (!report) return null;
    return <PasswordStrength id={id} report={report} classNames={classNames} />;
}

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
    classNames?: PasswordStrengthClassNames;
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
