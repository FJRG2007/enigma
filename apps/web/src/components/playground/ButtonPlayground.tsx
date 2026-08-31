import { Button } from "@enigmax/primitives/react";
import { Playground, type Control, type StyleToken } from "./Playground";

/**
 * The button's own playground. The props here are BEHAVIOUR - a cooldown you have to wait
 * out, a shortcut you can actually press, an async press that really takes a second - so
 * turning one on is something you feel rather than something you look at.
 */

interface Values extends Record<string, string | boolean> {
    label: string;
    async: boolean;
    pending: string;
    cooldown: string;
    shortcut: string;
    href: string;
    disabled: boolean;
}

const CONTROLS: Control<Values>[] = [
    { name: "label", label: "Label", type: "text", placeholder: "Save" },
    { name: "async", label: "Async work", type: "boolean", hint: "takes 1.2s" },
    { name: "pending", label: "While busy", type: "text", placeholder: "Saving..." },
    {
        name: "cooldown", label: "Cooldown", type: "select",
        options: [
            { value: "0", label: "none" },
            { value: "3000", label: "3s" },
            { value: "10000", label: "10s" }
        ]
    },
    { name: "shortcut", label: "Shortcut", type: "text", placeholder: "s", hint: "one key" },
    { name: "href", label: "href", type: "text", placeholder: "/settings", hint: "makes it a link" },
    { name: "disabled", label: "Disabled", type: "boolean" }
];

/**
 * The look, as tokens.
 *
 * The primitive ships no styles, so what you see here is this page's CSS - and these are the
 * five declarations that make it. Change one and the preview changes; the CSS and Tailwind
 * tabs below print exactly what you just did, ready to paste into your own button.
 */
const STYLE: StyleToken[] = [
    { name: "demo-bg", label: "Background", type: "color", property: "background", value: "#e0a458", tailwind: "bg-[{}]" },
    { name: "demo-color", label: "Text", type: "color", property: "color", value: "#101010", tailwind: "text-[{}]" },
    { name: "demo-font-size", label: "Text size", type: "px", property: "font-size", value: "13px", min: 11, max: 20, tailwind: "text-[{}]" },
    { name: "demo-radius", label: "Radius", type: "px", property: "border-radius", value: "9px", min: 0, max: 24, tailwind: "rounded-[{}]" },
    { name: "demo-padding", label: "Padding", type: "text", property: "padding", value: "9px 16px", tailwind: "p-[{}]" }
];

const INITIAL: Values = { label: "Save", async: true, pending: "Saving...", cooldown: "3000", shortcut: "", href: "", disabled: false };

const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1200));

/** Only the props that are not defaults, so the code reads like something you would write. */
function code(values: Values): string {
    const props: string[] = [];
    if (values.href) props.push(`href="${values.href}"`);
    else props.push(values.async ? "onClick={save}" : "onClick={() => save()}");
    if (values.async && values.pending) props.push(`pending="${values.pending}"`);
    if (values.cooldown !== "0") props.push(`cooldown={${values.cooldown}}`);
    if (values.shortcut) props.push(`shortcut="${values.shortcut}"`);
    if (values.disabled) props.push("disabled");

    const label = values.label || "Save";
    // Broken across lines once it stops fitting, the way it would be written by hand.
    const inline = `<Button ${props.join(" ")}>${label}</Button>`;
    const body = inline.length <= 78
        ? inline
        : `<Button\n${props.map((prop) => `    ${prop}`).join("\n")}\n>\n    ${label}\n</Button>`;

    return `import { Button } from "@enigmax/primitives/react";\n\n${body}`;
}

export function ButtonPlayground() {
    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            style={STYLE}
            styleSelector=".my-button"
            render={(values) => (
                <Button
                    href={values.href || undefined}
                    disabled={values.disabled}
                    shortcut={values.shortcut || undefined}
                    cooldown={values.cooldown === "0" ? undefined : Number(values.cooldown)}
                    pending={values.async && values.pending ? values.pending : undefined}
                    onClick={values.async ? wait : () => { /* nothing to do; the press is the point */ }}
                    // The primitive ships no styles, so the playground brings its own - the
                    // same ones the CSS recipe writes, so what you see is what --copy gives.
                    className="pg-btn"
                >
                    {values.label || "Save"}
                </Button>
            )}
        />
    );
}
