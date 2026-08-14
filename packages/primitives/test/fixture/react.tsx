import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Input, type BreachState, type PasswordStrengthReport } from "@/react/index";

/**
 * The React fixture: a registration form of the kind `<Input>` is for, wired the way a real
 * one is - a CONTROLLED field, a form that counts its own submissions, and a breach checker
 * that answers from a list instead of the network.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
    __submits: number;
    __value: string;
    __strength: PasswordStrengthReport | null;
    __breach: BreachState | null;
    __breachCalls: string[];
}

const fixture = window as unknown as FixtureWindow;
fixture.__submits = 0;
fixture.__value = "";
fixture.__strength = null;
fixture.__breach = null;
fixture.__breachCalls = [];

/** Answers instantly and locally, so the test measures the component and not a network. */
const BREACHED = new Set(["password", "hunter2"]);

function checkBreach(password: string, { signal }: { signal: AbortSignal; }): Promise<{ breached: boolean; count: number; }> {
    fixture.__breachCalls.push(password);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            resolve(BREACHED.has(password) ? { breached: true, count: 3730471 } : { breached: false, count: 0 });
        }, 20);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
        });
    });
}

function Form(): React.ReactNode {
    const [password, setPassword] = useState("");
    fixture.__value = password;

    return (
        <form
            data-testid="form"
            onSubmit={(event) => {
                event.preventDefault();
                fixture.__submits++;
            }}
        >
            <Input
                data-testid="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                generate={{ length: 24 }}
                strength={{ userInputs: ["ada@example.com"] }}
                breach={checkBreach}
                breachDelay={30}
                onStrengthChange={(report) => { fixture.__strength = report; }}
                onBreachChange={(state) => { fixture.__breach = state; }}
            />
            <button data-testid="submit" type="submit">Create account</button>
        </form>
    );
}

createRoot(document.getElementById("root")!).render(<Form />);
// One frame after the mount, so a test never reads a half-rendered tree.
requestAnimationFrame(() => { fixture.__ready = true; });
