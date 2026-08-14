import "./playground.css";
import { highlight } from "./highlight";
import { writeClipboard } from "../../lib/copy";
import { useMemo, useState, type ReactNode } from "react";

/**
 * Turn the props on and off, watch the real component react, take the code away.
 *
 * The preview is the ACTUAL component from the package, not a drawing of it - so what a
 * control changes is the behaviour you would get, and the code below is generated from the
 * same values that drove it. One state object, two outputs: they cannot disagree.
 */

export type Control<V> =
    | { name: keyof V & string; label: string; type: "boolean"; hint?: string; }
    | { name: keyof V & string; label: string; type: "text"; placeholder?: string; hint?: string; }
    | { name: keyof V & string; label: string; type: "select"; options: { value: string; label: string; }[]; hint?: string; };

export interface PlaygroundProps<V extends Record<string, string | boolean>> {
    controls: Control<V>[];
    initial: V;
    /** The live component. */
    render: (values: V) => ReactNode;
    /** The code for exactly these values - only the props that are not defaults. */
    code: (values: V) => string;
}

export function Playground<V extends Record<string, string | boolean>>({ controls, initial, render, code }: PlaygroundProps<V>) {
    const [values, setValues] = useState<V>(initial);
    const [copied, setCopied] = useState(false);

    const source = useMemo(() => code(values), [code, values]);
    const set = (name: string, value: string | boolean): void => setValues((current) => ({ ...current, [name]: value }));

    return (
        <div className="pg">
            <div className="pg-top">
                <div className="pg-preview">{render(values)}</div>

                <div className="pg-controls">
                    <div className="pg-h">Customize</div>
                    {controls.map((control) => (
                        <label key={control.name} className="pg-row">
                            <span className="pg-label">
                                {control.label}
                                {control.hint && <span className="pg-hint">{control.hint}</span>}
                            </span>

                            {control.type === "boolean" && (
                                <input
                                    type="checkbox"
                                    className="pg-check"
                                    checked={Boolean(values[control.name])}
                                    onChange={(event) => set(control.name, event.target.checked)}
                                />
                            )}
                            {control.type === "text" && (
                                <input
                                    type="text"
                                    className="pg-text"
                                    value={String(values[control.name] ?? "")}
                                    placeholder={control.placeholder}
                                    onChange={(event) => set(control.name, event.target.value)}
                                />
                            )}
                            {control.type === "select" && (
                                <select
                                    className="pg-text"
                                    value={String(values[control.name] ?? "")}
                                    onChange={(event) => set(control.name, event.target.value)}
                                >
                                    {control.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                </select>
                            )}
                        </label>
                    ))}
                    <button type="button" className="pg-reset" onClick={() => setValues(initial)}>Reset</button>
                </div>
            </div>

            <div className="pg-code">
                <pre><code>{highlight(source)}</code></pre>
                <button
                    type="button"
                    className="pg-copy"
                    aria-label="Copy code"
                    onClick={async () => {
                        // Only after a confirmed write, same rule as every other copy button
                        // here: a tick over an unchanged clipboard is found out on paste.
                        if (!(await writeClipboard(source))) return;
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1600);
                    }}
                >{copied ? "Copied" : "Copy"}</button>
            </div>
        </div>
    );
}
