import { Flag } from "@enigmax/primitives/react/flag";
import { Playground, type Control } from "./Playground";

/**
 * The flag's playground. Everything here changes what the image IS - which set it comes
 * from, how tall it renders, whether it names itself - so every control is something you
 * can see rather than something you have to take on trust.
 */

interface Values extends Record<string, string | boolean> {
    code: string;
    shape: string;
    size: string;
    label: string;
    decorative: boolean;
}

const CONTROLS: Control<Values>[] = [
    { name: "code", label: "Code", type: "text", placeholder: "es", hint: "es, ES, en-GB, gb-eng" },
    {
        name: "shape", label: "Shape", type: "select",
        options: [
            { value: "rect", label: "rect 4:3" },
            { value: "square", label: "square 1:1" },
            { value: "circle", label: "circle" }
        ]
    },
    {
        name: "size", label: "Height", type: "select",
        options: [
            { value: "16", label: "16px" },
            { value: "24", label: "24px" },
            { value: "40", label: "40px" },
            { value: "72", label: "72px" }
        ]
    },
    { name: "label", label: "Label", type: "text", placeholder: "automatic", hint: "overrides the country name" },
    { name: "decorative", label: "Decorative", type: "boolean", hint: "no name at all" }
];

const INITIAL: Values = { code: "es", shape: "rect", size: "24", label: "", decorative: false };

/** Only the props that are not defaults, so the code reads like something you would write. */
function code(values: Values): string {
    const props = [`code="${values.code || "es"}"`];
    if (values.shape !== "rect") props.push(`shape="${values.shape}"`);
    if (values.size !== "16") props.push(`size={${values.size}}`);
    if (values.label) props.push(`label="${values.label}"`);
    if (values.decorative) props.push("decorative");

    return `import { Flag } from "@enigmax/primitives/react/flag";\n\n<Flag ${props.join(" ")} />`;
}

export function FlagPlayground() {
    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            render={(values) => (
                <div className="pg-flags">
                    <Flag
                        code={values.code || "es"}
                        shape={values.shape as "rect" | "square" | "circle"}
                        size={Number(values.size)}
                        label={values.label || undefined}
                        decorative={values.decorative}
                        className="pg-flag"
                    />
                    {/* What the reader would actually hear, which is the half of a flag
                        nobody can see on the page. */}
                    <FlagName values={values} />
                </div>
            )}
        />
    );
}

function FlagName({ values }: { values: Values; }) {
    if (values.decorative) return <span className="pg-flag-alt">read as: nothing, it is decoration</span>;
    if (values.label) return <span className="pg-flag-alt">read as: {values.label}</span>;
    return <span className="pg-flag-alt">read as: the country name, in the reader's language</span>;
}
