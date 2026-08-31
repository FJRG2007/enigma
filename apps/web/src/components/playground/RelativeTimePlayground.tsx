import { useState } from "react";
import "@enigmax/primitives/relative-time.css";
import { Playground, type Control, type StyleToken } from "./Playground";
import { RelativeTime } from "@enigmax/primitives/react";
import type { RelativeTimeFormat, RelativeTimeStyle } from "@enigmax/primitives/react";

/**
 * The relative-time playground. The interesting axis is HOW OLD the date is, because that
 * is what decides whether it reads as a phrase or a date - so the first control moves the
 * timestamp rather than a prop.
 */

const AGES = [
    { value: "-90", label: "90 seconds ago" },
    { value: "-7200", label: "2 hours ago" },
    { value: "-172800", label: "2 days ago" },
    { value: "-5184000", label: "60 days ago" },
    { value: "3600", label: "in an hour" }
];

interface Values extends Record<string, string | boolean> {
    age: string;
    format: string;
    threshold: string;
    prefix: string;
    locale: string;
    formatStyle: string;
    numeric: boolean;
}

const CONTROLS: Control<Values>[] = [
    { name: "age", label: "The date is", type: "select", options: AGES },
    {
        name: "format", label: "Format", type: "select",
        options: ["auto", "relative", "datetime", "micro", "elapsed"].map((value) => ({ value, label: value }))
    },
    {
        name: "threshold", label: "Threshold", type: "select", hint: "when it stops counting",
        options: [{ value: "P30D", label: "30 days" }, { value: "P1D", label: "1 day" }, { value: "P1Y", label: "1 year" }]
    },
    { name: "prefix", label: "Prefix", type: "text", placeholder: "on" },
    { name: "locale", label: "Locale", type: "text", placeholder: "page's own", hint: "es-ES, ja-JP..." },
    {
        name: "formatStyle", label: "Style", type: "select",
        options: ["long", "short", "narrow"].map((value) => ({ value, label: value }))
    },
    { name: "numeric", label: "Digits past it", type: "boolean", hint: "13/8/2026" }
];

/** A timestamp is text, so its look is the text's. */
const STYLE: StyleToken[] = [
    { name: "demo-time-color", label: "Text", type: "color", property: "color", value: "#a3a3a3", tailwind: "text-[{}]" },
    { name: "demo-time-size", label: "Text size", type: "px", property: "font-size", value: "14px", min: 11, max: 22, tailwind: "text-[{}]" }
];

const INITIAL: Values = { age: "-7200", format: "auto", threshold: "P30D", prefix: "on", locale: "", formatStyle: "long", numeric: false };

function code(values: Values): string {
    const props = ["date={comment.createdAt}"];
    if (values.format !== "auto") props.push(`format="${values.format}"`);
    if (values.threshold !== "P30D") props.push(`threshold="${values.threshold}"`);
    if (values.prefix !== "on") props.push(`prefix="${values.prefix}"`);
    if (values.locale) props.push(`locale="${values.locale}"`);
    if (values.formatStyle !== "long") props.push(`formatStyle="${values.formatStyle}"`);
    if (values.numeric) props.push("numericBeyondThreshold");

    const inline = `<RelativeTime ${props.join(" ")} />`;
    return [
        'import { RelativeTime } from "@enigmax/primitives/react";',
        'import "@enigmax/primitives/relative-time.css";',
        "",
        inline.length <= 78 ? inline : `<RelativeTime\n${props.map((prop) => `    ${prop}`).join("\n")}\n/>`
    ].join("\n");
}

export function RelativeTimePlayground() {
    // Pinned at mount: the component re-renders on every control change, and a date built
    // during render would drift by the time you compared two settings.
    const [now] = useState(() => new Date());

    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            style={STYLE}
            styleSelector=".timestamp"
            render={(values) => (
                <span className="pg-time">
                    <RelativeTime
                        key={values.locale}
                        date={new Date(now.getTime() + Number(values.age) * 1000)}
                        now={now}
                        format={values.format as RelativeTimeFormat}
                        threshold={values.threshold}
                        prefix={values.prefix}
                        locale={values.locale || undefined}
                        formatStyle={values.formatStyle as RelativeTimeStyle}
                        numericBeyondThreshold={values.numeric}
                    />
                </span>
            )}
        />
    );
}
