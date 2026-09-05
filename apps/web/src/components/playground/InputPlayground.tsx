import { useState } from "react";
import "@enigmax/primitives/input.css";
import { checkPasswordBreach } from "@enigmax/utils";
import { Input } from "@enigmax/primitives/react/input";
import { Playground, type Control, type StyleToken } from "./Playground";

/**
 * The input's playground, driven by `type` - because that is what drives the component.
 *
 * The controls CHANGE with the type, and that is the point rather than a nicety: the props a
 * field has depend on what kind of field it is, so a strength meter on a date field is a
 * compile error rather than a prop that quietly does nothing. What this panel offers is
 * exactly what TypeScript would let you write.
 */

interface Values extends Record<string, string | boolean> {
    type: string;
    placeholder: string;
    generate: boolean;
    strength: boolean;
    breach: boolean;
    clearable: boolean;
    format: string;
    placement: string;
    alpha: boolean;
    presets: boolean;
    eyedropper: boolean;
    position: string;
    disabled: boolean;
}

/** A small corpus, so the search field has something real to rank. */
const DOCS = [
    { title: "Marquee", section: "Motion" },
    { title: "Logo wall", section: "Motion" },
    { title: "Input", section: "Forms" },
    { title: "Command palette", section: "Forms" },
    { title: "Flags", section: "Data" },
    { title: "Relative time", section: "Data" }
];

const TYPES = ["text", "email", "password", "search", "color", "number", "date", "tel", "url"];

/** A brand palette, which is what `swatches` is for: the colours this project actually uses. */
const SWATCHES = ["#3b82f6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#a855f7"];

const SHARED: Control<Values>[] = [
    {
        name: "type", label: "Type", type: "select",
        options: TYPES.map((value) => ({ value, label: value }))
    },
    { name: "placeholder", label: "Placeholder", type: "text", placeholder: "Type here" }
];

const TAIL: Control<Values>[] = [
    {
        name: "position", label: "Buttons", type: "select",
        options: [{ value: "end", label: "end" }, { value: "start", label: "start" }]
    },
    { name: "disabled", label: "Disabled", type: "boolean" }
];

function controlsFor(values: Values): Control<Values>[] {
    if (values.type === "password") {
        return [
            ...SHARED,
            { name: "generate", label: "Generator", type: "boolean", hint: "adds the wand" },
            { name: "strength", label: "Strength meter", type: "boolean", hint: "five bars, for a NEW password" },
            { name: "breach", label: "Breach check", type: "boolean", hint: "asks whether it has leaked" },
            ...TAIL
        ];
    }
    if (values.type === "search") {
        return [
            ...SHARED,
            { name: "clearable", label: "Clear button", type: "boolean", hint: "on by default" },
            ...TAIL
        ];
    }
    if (values.type === "color") {
        return [
            ...SHARED,
            {
                name: "format", label: "Writes", type: "select",
                hint: "every format is still read",
                options: [{ value: "hex", label: "hex" }, { value: "rgb", label: "rgb()" }, { value: "hsl", label: "hsl()" }]
            },
            {
                name: "placement", label: "Panel side", type: "select",
                hint: "auto measures the room there is",
                options: [{ value: "bottom", label: "bottom" }, { value: "top", label: "top" }, { value: "auto", label: "auto" }]
            },
            { name: "alpha", label: "Opacity rail", type: "boolean", hint: "puts alpha in the value" },
            { name: "presets", label: "Presets", type: "boolean", hint: "swatches under the rails" },
            { name: "eyedropper", label: "Eyedropper", type: "boolean", hint: "Chromium only, feature-detected" },
            ...TAIL
        ];
    }
    return [...SHARED, ...TAIL];
}

/**
 * The look, as the stylesheet's own custom properties.
 *
 * These are not demo-only knobs: they are the variables `@enigmax/primitives/input.css`
 * declares, so the CSS tab prints a block you can paste into your app and get exactly what
 * is on screen.
 */
const STYLE: StyleToken[] = [
    { name: "enigma-input-bg", label: "Field", type: "color", property: "--enigma-input-bg", value: "#171717", tailwind: "bg-[{}]" },
    { name: "enigma-input-border", label: "Border", type: "color", property: "--enigma-input-border", value: "#404040", tailwind: "border-[{}]" },
    { name: "enigma-input-text", label: "Text", type: "color", property: "--enigma-input-text", value: "#f5f5f5", tailwind: "text-[{}]" },
    { name: "enigma-input-font-size", label: "Text size", type: "px", property: "--enigma-input-font-size", value: "14px", min: 12, max: 20, tailwind: "text-[{}]" },
    { name: "enigma-input-radius", label: "Radius", type: "px", property: "--enigma-input-radius", value: "8px", min: 0, max: 24, tailwind: "rounded-[{}]" }
];

const INITIAL: Values = {
    type: "password",
    placeholder: "Password",
    generate: true,
    strength: true,
    breach: false,
    clearable: true,
    format: "hex",
    placement: "bottom",
    alpha: false,
    presets: true,
    eyedropper: true,
    position: "end",
    disabled: false
};

function code(values: Values): string {
    const props = [`type="${values.type}"`];
    if (values.type === "password") {
        props.push('autoComplete="new-password"');
        if (values.generate) props.push("generate");
        if (values.strength) props.push("strength={{ userInputs: [email] }}");
        if (values.breach) props.push("breach={checkPasswordBreach}");
    }
    if (values.type === "search") {
        props.push("items={docs}", 'keys={["title"]}');
        if (!values.clearable) props.push("clearable={false}");
        props.push("renderResults={(matches) => <Results matches={matches} />}");
    }
    if (values.type === "color") {
        props.push("value={brand}", "onChange={(event) => setBrand(event.target.value)}");
        if (values.format !== "hex") props.push(`format="${values.format}"`);
        if (values.placement !== "auto") props.push(`placement="${values.placement}"`);
        if (values.alpha) props.push("alpha");
        if (values.presets) props.push("swatches={palette}");
        if (!values.eyedropper) props.push("eyedropper={false}");
    }
    if (values.position !== "end") props.push(`position="${values.position}"`);
    if (values.disabled) props.push("disabled");
    if (values.placeholder) props.push(`placeholder="${values.placeholder}"`);

    const imports = ['import { Input } from "@enigmax/primitives/react/input";'];
    if (values.type === "password" && values.breach) imports.push('import { checkPasswordBreach } from "@enigmax/utils";');

    const consts = values.type === "color" && values.presets
        ? `\nconst palette = [${SWATCHES.map((color) => `"${color}"`).join(", ")}];\n`
        : "";

    return `${imports.join("\n")}\n${consts}\n<Input\n${props.map((prop) => `    ${prop}`).join("\n")}\n/>`;
}

export function InputPlayground() {
    const [value, setValue] = useState("");
    const [color, setColor] = useState("#3b82f6");

    return (
        <Playground<Values>
            controls={controlsFor}
            initial={INITIAL}
            code={code}
            style={STYLE}
            styleSelector=":root"
            render={(values) => (
                <div className="pg-field">
                    {values.type === "search" ? (
                        <Input
                            type="search"
                            placeholder={values.placeholder}
                            disabled={values.disabled}
                            position={values.position === "start" ? "start" : "end"}
                            clearable={values.clearable}
                            items={DOCS}
                            keys={["title"]}
                            renderResults={(matches, query) => (
                                <ul className="pg-results">
                                    {query.trim() === "" && <li className="pg-none">Type to search</li>}
                                    {query.trim() !== "" && matches.length === 0 && <li className="pg-none">No matches</li>}
                                    {matches.map((match) => (
                                        <li key={match.item.title}>
                                            {match.item.title}
                                            <span className="pg-kind">{match.item.section}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        />
                    ) : values.type === "password" ? (
                        <Input
                            type="password"
                            autoComplete="new-password"
                            placeholder={values.placeholder}
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            disabled={values.disabled}
                            position={values.position === "start" ? "start" : "end"}
                            generate={values.generate}
                            strength={values.strength}
                            // Only when asked: it is a request to a third party, so it should
                            // never be something a docs page does behind the reader's back.
                            breach={values.breach ? checkPasswordBreach : undefined}
                        />
                    ) : values.type === "color" ? (
                        <Input
                            type="color"
                            placeholder={values.placeholder}
                            value={color}
                            onChange={(event) => setColor(event.target.value)}
                            disabled={values.disabled}
                            position={values.position === "start" ? "start" : "end"}
                            format={values.format as "hex"}
                            placement={values.placement as "auto"}
                            alpha={values.alpha}
                            swatches={values.presets ? SWATCHES : undefined}
                            eyedropper={values.eyedropper}
                        />
                    ) : (
                        <Input
                            type={values.type as "text"}
                            placeholder={values.placeholder}
                            disabled={values.disabled}
                            position={values.position === "start" ? "start" : "end"}
                        />
                    )}
                </div>
            )}
        />
    );
}
