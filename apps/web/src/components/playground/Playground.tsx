import "./playground.css";
import { highlight } from "./highlight";
import { COPY_ICON, bindCopy } from "../../lib/copy";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
    /**
     * The controls, or a function of the current values for a component whose props DEPEND
     * on one of them - a field's `type` decides which props even exist, so showing the
     * password controls on a date field would be showing props that are a compile error.
     */
    controls: Control<V>[] | ((values: V) => Control<V>[]);
    initial: V;
    /** The live component. */
    render: (values: V) => ReactNode;
    /** The code for exactly these values - only the props that are not defaults. */
    code: (values: V) => string;
}

export function Playground<V extends Record<string, string | boolean>>({ controls, initial, render, code }: PlaygroundProps<V>) {
    const [values, setValues] = useState<V>(initial);

    const shown = useMemo(() => (typeof controls === "function" ? controls(values) : controls), [controls, values]);
    const source = useMemo(() => code(values), [code, values]);

    /**
     * The same copy button as every other code block, from the same helper - an icon that
     * turns into a tick, and only after a confirmed write.
     *
     * It is wired here rather than left to the layout's script: that runs once, before this
     * island exists, so the block would have no button at all - and the `data-copied` mark
     * below is what stops the script adding a SECOND one if it ever runs again.
     */
    const copyRef = useRef<HTMLButtonElement | null>(null);
    const sourceRef = useRef(source);
    sourceRef.current = source;

    useEffect(() => {
        const button = copyRef.current;
        if (!button) return;
        button.innerHTML = COPY_ICON;
        bindCopy(button, () => sourceRef.current);
    }, []);
    const set = (name: string, value: string | boolean): void => setValues((current) => ({ ...current, [name]: value }));

    return (
        <div className="pg">
            <div className="pg-top">
                <div className="pg-preview">{render(values)}</div>

                <div className="pg-controls">
                    <div className="pg-h">Customize</div>
                    {shown.map((control) => (
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
                <pre data-copied="">
                    <code>{highlight(source)}</code>
                    <button ref={copyRef} type="button" className="code-copy" aria-label="Copy code" title="Copy" />
                </pre>
            </div>
        </div>
    );
}
