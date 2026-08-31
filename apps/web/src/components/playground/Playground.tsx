import { Select } from "@enigmax/primitives/react/select";
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

/**
 * A look you can change, and take away.
 *
 * The primitives ship no styles at all, so every page that shows one is showing SOMEBODY's
 * CSS - and a reader's first question is "how do I make it mine". Each token here is a real
 * CSS declaration applied to the preview through a custom property, so what changes on
 * screen is the same thing the generated stylesheet says.
 */
export interface StyleToken {
    /** Custom property the preview reads, without the leading dashes. */
    name: string;
    label: string;
    type: "color" | "px" | "text";
    /** The CSS declaration this token stands for, for the generated stylesheet. */
    property: string;
    value: string;
    /** The Tailwind utility for the same thing. `{}` is replaced by the value. */
    tailwind?: string;
    min?: number;
    max?: number;
}

export interface PlaygroundProps<V extends Record<string, string | boolean>> {
    /** Style tokens. Given, the panel gains a Style tab and the code block gains two more. */
    style?: StyleToken[];
    /** The class name the generated stylesheet targets. */
    styleSelector?: string;
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

export function Playground<V extends Record<string, string | boolean>>({ controls, initial, render, code, style, styleSelector = ".my-component" }: PlaygroundProps<V>) {
    const [values, setValues] = useState<V>(initial);
    const [styleValues, setStyleValues] = useState<Record<string, string>>(
        () => Object.fromEntries((style ?? []).map((token) => [token.name, token.value]))
    );
    const [tab, setTab] = useState<"props" | "style">("props");
    const [output, setOutput] = useState<"component" | "css" | "tailwind">("component");

    const shown = useMemo(() => (typeof controls === "function" ? controls(values) : controls), [controls, values]);
    const componentSource = useMemo(() => code(values), [code, values]);

    /** The same values, as the stylesheet or the utility classes they stand for. */
    const source = useMemo(() => {
        if (!style || output === "component") return componentSource;
        if (output === "css") {
            const body = style.map((token) => `    ${token.property}: ${styleValues[token.name]};`).join("\n");
            return `${styleSelector} {\n${body}\n}`;
        }
        const classes = style
            .filter((token) => token.tailwind)
            .map((token) => token.tailwind!.replace("{}", styleValues[token.name].replace(/ /g, "_")))
            .join(" ");
        return `<Component className="${classes}" />`;
    }, [componentSource, output, style, styleSelector, styleValues]);

    /** Applied to the preview as custom properties, which is what the demo CSS reads. */
    const previewStyle = useMemo(
        () => Object.fromEntries((style ?? []).map((token) => [`--${token.name}`, styleValues[token.name]])) as Record<string, string>,
        [style, styleValues]
    );

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
                <div className="pg-preview" style={previewStyle}>{render(values)}</div>

                <div className="pg-controls">
                    {style ? (
                        <div className="pg-h pg-h-tabs" role="tablist" aria-label="Customize">
                            <button type="button" role="tab" aria-selected={tab === "props"} className={tab === "props" ? "is-on" : ""} onClick={() => setTab("props")}>Props</button>
                            <button type="button" role="tab" aria-selected={tab === "style"} className={tab === "style" ? "is-on" : ""} onClick={() => setTab("style")}>Style</button>
                        </div>
                    ) : (
                        <div className="pg-h">Customize</div>
                    )}

                    {style && tab === "style" && style.map((token) => (
                        <label key={token.name} className="pg-row">
                            <span className="pg-label">{token.label}</span>
                            {token.type === "color" ? (
                                <input
                                    type="color"
                                    className="pg-color"
                                    value={styleValues[token.name]}
                                    onChange={(event) => setStyleValues((current) => ({ ...current, [token.name]: event.target.value }))}
                                />
                            ) : token.type === "px" ? (
                                <input
                                    type="range"
                                    className="pg-range"
                                    min={token.min ?? 0}
                                    max={token.max ?? 32}
                                    value={parseInt(styleValues[token.name], 10) || 0}
                                    onChange={(event) => setStyleValues((current) => ({ ...current, [token.name]: `${event.target.value}px` }))}
                                />
                            ) : (
                                <input
                                    type="text"
                                    className="pg-text"
                                    value={styleValues[token.name]}
                                    onChange={(event) => setStyleValues((current) => ({ ...current, [token.name]: event.target.value }))}
                                />
                            )}
                        </label>
                    ))}

                    {(!style || tab === "props") && shown.map((control) => (
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
                                // The package's own select, not the platform's: these pages
                                // are the first place a component has to hold up, and the
                                // native popup is drawn by the OS and cannot be themed.
                                <Select
                                    className="pg-select"
                                    options={control.options}
                                    value={String(values[control.name] ?? "")}
                                    onValueChange={(next) => set(control.name, next)}
                                />
                            )}
                        </label>
                    ))}
                    <button
                        type="button"
                        className="pg-reset"
                        onClick={() => {
                            setValues(initial);
                            setStyleValues(Object.fromEntries((style ?? []).map((token) => [token.name, token.value])));
                        }}
                    >Reset</button>
                </div>
            </div>

            <div className="pg-code">
                {style && (
                    <div className="pg-out" role="tablist" aria-label="What to copy">
                        {(["component", "css", "tailwind"] as const).map((name) => (
                            <button
                                key={name}
                                type="button"
                                role="tab"
                                aria-selected={output === name}
                                className={output === name ? "is-on" : ""}
                                onClick={() => setOutput(name)}
                            >
                                {name === "component" ? "Component" : name === "css" ? "CSS" : "Tailwind"}
                            </button>
                        ))}
                    </div>
                )}
                <pre data-copied="">
                    <code>{highlight(source)}</code>
                    <button ref={copyRef} type="button" className="code-copy" aria-label="Copy code" title="Copy" />
                </pre>
            </div>
        </div>
    );
}
