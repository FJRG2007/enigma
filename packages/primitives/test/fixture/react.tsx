import { useState } from "react";
import { createRoot } from "react-dom/client";
// The Next entry, with next/link aliased to a stub at bundle time.
import { Button as NextButton } from "@/next/index";
import { Button, Input, setLinkComponent, type BreachState, type PasswordStrengthReport } from "@/react/index";

/**
 * The React fixture: a registration form of the kind `<Input>` is for, wired the way a real
 * one is - a CONTROLLED field, a form that counts its own submissions, and a breach checker
 * that answers from a list instead of the network.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
    __presses: number;
    __release: () => void;
    __unsetLink: () => void;
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
fixture.__presses = 0;

/**
 * Stands in for next/link: a component that renders an anchor and marks itself, so a test
 * can tell a registered router link from the plain fallback.
 */
function FakeLink({ href, children, ...rest }: { href?: string; children?: React.ReactNode; }) {
    return <a href={href} data-router-link="" {...rest}>{children}</a>;
}
setLinkComponent(FakeLink);

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
    const [, redraw] = useState(0);
    fixture.__value = password;

    // Dropping the registration has to be followed by a render: the component reads the
    // registered link while rendering, so nothing on screen changes on its own.
    fixture.__unsetLink = () => {
        setLinkComponent(null);
        redraw((count) => count + 1);
    };

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

            {/* The short form: no hook, no spreading, no six lines per call site. */}
            <Button data-testid="save" onPress={() => { fixture.__presses++; }}>Save</Button>

            {/* Async work, a cooldown after it, and a label that follows the state. */}
            <Button
                data-testid="send"
                cooldown={3000}
                pending="Sending..."
                onPress={() => new Promise<void>((resolve) => { fixture.__release = resolve; })}
            >
                {({ cooldown }) => (cooldown > 0 ? `Wait ${Math.ceil(cooldown / 1000)}s` : "Send")}
            </Button>

            {/* No `as`: the href alone picks up the link registered above. */}
            <Button data-testid="link" href="/settings">Settings</Button>

            {/* The Next entry: an href is next/link, with nothing at the call site. */}
            <NextButton data-testid="next-link" href="/settings">Settings</NextButton>
            <NextButton data-testid="next-button" onPress={() => { fixture.__presses++; }}>Save</NextButton>
        </form>
    );
}

createRoot(document.getElementById("root")!).render(<Form />);
// One frame after the mount, so a test never reads a half-rendered tree.
requestAnimationFrame(() => { fixture.__ready = true; });
