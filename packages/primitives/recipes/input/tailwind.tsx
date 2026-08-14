"use client";

import { useState } from "react";
import { Input, type BreachChecker, type BreachState } from "@enigmax/primitives/react";

/**
 * A registration password field, styled with Tailwind. Yours to edit.
 *
 * The primitive renders the structure and publishes its state on `data-*`; every colour
 * below is this file's. The meter's five bars read the score from the ROOT, which is why
 * they colour themselves through a group variant rather than five separate components.
 */

interface PasswordFieldProps {
    value: string;
    onChange: (value: string) => void;
    /** What the visitor has already typed elsewhere, so the meter can spot it in there. */
    userInputs?: string[];
    /**
     * Check the password against a breach corpus. `enigma add password-breach` gives you
     * `checkPasswordBreach` from @enigmax/utils, which asks Have I Been Pwned without
     * sending the password anywhere. Leave it out and the field simply does not check.
     */
    breach?: BreachChecker;
    /** Your own message, from your own validation. */
    error?: string;
}

const SEGMENT = [
    "h-1 rounded-full bg-neutral-800 transition-colors",
    "group-data-[score=0]/field:data-[filled]:bg-red-600",
    "group-data-[score=1]/field:data-[filled]:bg-orange-600",
    "group-data-[score=2]/field:data-[filled]:bg-yellow-500",
    "group-data-[score=3]/field:data-[filled]:bg-lime-500",
    "group-data-[score=4]/field:data-[filled]:bg-green-600"
].join(" ");

export function PasswordField({ value, onChange, userInputs, breach: check, error }: PasswordFieldProps) {
    const [breach, setBreach] = useState<BreachState>({ status: "idle", count: 0, error: null });

    return (
        <div className="grid gap-1.5">
            <label htmlFor="password" className="text-xs text-neutral-400">Password</label>

            <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                generate={{ length: 20 }}
                strength={{ userInputs }}
                // The check is a prop, so the network request is a decision this file makes
                // rather than one the field takes on its own.
                breach={check}
                onBreachChange={setBreach}
                wrapperProps={{ className: "group/field grid gap-1.5" }}
                fieldProps={{
                    className: "flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-900 px-3 focus-within:border-neutral-400 group-data-[breached]/field:border-red-600"
                }}
                className="min-w-0 flex-1 border-0 bg-transparent py-2.5 text-sm text-neutral-100 outline-none"
                classNames={{
                    actions: "inline-flex gap-0.5",
                    action: "grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 aria-pressed:text-amber-400 disabled:opacity-50",
                    strength: {
                        track: "grid grid-cols-5 gap-1",
                        segment: SEGMENT,
                        label: "m-0 text-xs text-neutral-400",
                        warning: "m-0 text-xs text-amber-400"
                    }
                }}
            >
                {/* Whatever a breach means here is this form's decision, so this form makes
                    it. The field reports the count and stops. */}
                {breach.status === "breached" && (
                    <p className="m-0 text-xs text-red-500">
                        This password has appeared in {breach.count.toLocaleString()} breaches. Please pick another.
                    </p>
                )}
                {error && <p className="m-0 text-xs text-red-500">{error}</p>}
            </Input>
        </div>
    );
}
