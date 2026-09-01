import { useState } from "react";
import { Flag } from "@enigmax/primitives/react/flag";
import { Select } from "@enigmax/primitives/react/select";
import { Playground, type Control, type StyleToken } from "./Playground";

/**
 * The select's playground. Every control here changes what the component IS - one value or
 * many, a filter or none, icons on the rows - so the preview is the only way to judge it,
 * and the preview is the shipped component with the shipped theme.
 */

interface Values extends Record<string, string | boolean> {
    multiple: boolean;
    searchable: string;
    icons: boolean;
    descriptions: boolean;
    groups: boolean;
    clearable: boolean;
    disabled: boolean;
    state: string;
    placeholder: string;
}

const CONTROLS: Control<Values>[] = [
    { name: "multiple", label: "Many values", type: "boolean", hint: "tags, and the panel stays" },
    {
        name: "searchable", label: "Filter", type: "select",
        options: [
            { value: "auto", label: "auto" },
            { value: "on", label: "always" },
            { value: "off", label: "never" }
        ]
    },
    { name: "icons", label: "Icons", type: "boolean" },
    { name: "descriptions", label: "Second line", type: "boolean" },
    { name: "groups", label: "Groups", type: "boolean" },
    { name: "clearable", label: "Clear button", type: "boolean" },
    { name: "disabled", label: "Disabled", type: "boolean" },
    {
        name: "state", label: "Options", type: "select",
        hint: "an empty list says so instead of opening",
        options: [
            { value: "ready", label: "loaded" },
            { value: "empty", label: "none" },
            { value: "loading", label: "loading" }
        ]
    },
    { name: "placeholder", label: "Placeholder", type: "text", placeholder: "Country" }
];

/**
 * The theme it ships with, as its own custom properties - the select is the one component
 * here that arrives styled, because an unstyled popup is text lying on the page.
 */
const STYLE: StyleToken[] = [
    { name: "enigma-select-bg", label: "Trigger", type: "color", property: "--enigma-select-bg", value: "#12161f" },
    { name: "enigma-select-border", label: "Border", type: "color", property: "--enigma-select-border", value: "#232a36" },
    { name: "enigma-select-panel-bg", label: "Panel", type: "color", property: "--enigma-select-panel-bg", value: "#12161f" },
    { name: "enigma-select-active-bg", label: "Highlight", type: "color", property: "--enigma-select-active-bg", value: "#1a1f2b" },
    { name: "enigma-select-accent", label: "Check", type: "color", property: "--enigma-select-accent", value: "#e0a458" },
    { name: "enigma-select-radius", label: "Radius", type: "px", property: "--enigma-select-radius", value: "8px", min: 0, max: 20 }
];

const INITIAL: Values = {
    multiple: false,
    searchable: "auto",
    icons: true,
    descriptions: false,
    groups: true,
    clearable: false,
    disabled: false,
    state: "ready",
    placeholder: "Country"
};

/** Nine countries: enough rows for the filter to appear on its own. */
const COUNTRIES = [
    { value: "es", label: "Spain", group: "Europe", description: "Madrid" },
    { value: "fr", label: "France", group: "Europe", description: "Paris" },
    { value: "de", label: "Germany", group: "Europe", description: "Berlin", disabled: true },
    { value: "pt", label: "Portugal", group: "Europe", description: "Lisbon" },
    { value: "it", label: "Italy", group: "Europe", description: "Rome" },
    { value: "us", label: "United States", group: "Americas", description: "Washington" },
    { value: "mx", label: "Mexico", group: "Americas", description: "Mexico City" },
    { value: "br", label: "Brazil", group: "Americas", description: "Brasilia" },
    { value: "ar", label: "Argentina", group: "Americas", description: "Buenos Aires" }
];

function options(values: Values) {
    // Nothing to choose from is a state of its own: the trigger says so and never opens a
    // panel holding one line of apology.
    if (values.state !== "ready") return [];
    return COUNTRIES.map((country) => ({
        value: country.value,
        label: country.label,
        disabled: country.disabled,
        description: values.descriptions ? country.description : undefined,
        group: values.groups ? country.group : undefined,
        icon: values.icons ? <Flag code={country.value} size={14} decorative /> : undefined
    }));
}

function code(values: Values): string {
    const props: string[] = ["options={countries}"];
    if (values.multiple) props.push("multiple", "value={countries}", "onValueChange={setCountries}");
    else props.push("value={country}", "onValueChange={setCountry}");
    if (values.searchable === "on") props.push("searchable");
    if (values.searchable === "off") props.push("searchable={false}");
    if (values.clearable && !values.multiple) props.push("clearable");
    if (values.disabled) props.push("disabled");
    if (values.state === "loading") props.push("loading");
    if (values.placeholder && values.placeholder !== "Select") props.push(`placeholder="${values.placeholder}"`);

    const option = [
        '{ value: "es", label: "Spain"',
        values.descriptions ? ', description: "Madrid"' : "",
        values.groups ? ', group: "Europe"' : "",
        values.icons ? ', icon: <Flag code="es" size={14} decorative />' : "",
        " }"
    ].join("");

    return [
        'import { Select } from "@enigmax/primitives/react/select";',
        "",
        `const countries = [\n    ${option},\n    // ...\n];`,
        "",
        `<Select\n${props.map((prop) => `    ${prop}`).join("\n")}\n/>`
    ].join("\n");
}

/** The live one, holding its own value the way a form would hold it. */
function Live({ values }: { values: Values; }) {
    const [one, setOne] = useState("");
    const [many, setMany] = useState<string[]>([]);
    const searchable = values.searchable === "auto" ? "auto" : values.searchable === "on";
    const loading = values.state === "loading";

    if (values.multiple) {
        return (
            <Select
                multiple
                className="pg-picker"
                options={options(values)}
                value={many}
                onValueChange={setMany}
                searchable={searchable}
                disabled={values.disabled}
                loading={loading}
                placeholder={values.placeholder || "Select"}
            />
        );
    }

    return (
        <Select
            className="pg-picker"
            options={options(values)}
            value={one}
            onValueChange={setOne}
            searchable={searchable}
            clearable={values.clearable}
            disabled={values.disabled}
            loading={loading}
            placeholder={values.placeholder || "Select"}
        />
    );
}

export function SelectPlayground() {
    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            style={STYLE}
            styleSelector=":root"
            render={(values) => <Live values={values} />}
        />
    );
}
