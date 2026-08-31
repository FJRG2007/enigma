import "@enigmax/primitives/palette.css";
import { Playground, type Control } from "./Playground";
import { SearchPalette } from "@enigmax/primitives/react/palette";

/**
 * The palette's playground.
 *
 * It renders a real palette over this page, which is the only honest way to show one: a
 * command palette is a focus trap, a scroll lock and a keyboard sequence, and none of those
 * can be demonstrated by a picture of a panel.
 */

interface Values extends Record<string, string | boolean> {
    placeholder: string;
    grouped: boolean;
    recents: boolean;
    footer: boolean;
}

const CONTROLS: Control<Values>[] = [
    { name: "placeholder", label: "Placeholder", type: "text", placeholder: "Search the docs" },
    { name: "grouped", label: "Groups", type: "boolean", hint: "one heading per section" },
    { name: "recents", label: "Remember searches", type: "boolean", hint: "in this browser" },
    { name: "footer", label: "Key hints", type: "boolean" }
];

const INITIAL: Values = { placeholder: "Search the docs", grouped: true, recents: true, footer: true };

/** The same corpus the docs search uses, small enough to see the ranking work. */
const DOCS = [
    { title: "Marquee", section: "Motion" },
    { title: "Logo wall", section: "Motion" },
    { title: "Input", section: "Forms" },
    { title: "Button", section: "Forms" },
    { title: "Flags", section: "Data" },
    { title: "Toast", section: "Data" },
    { title: "Relative time", section: "Data" },
    { title: "Breach check", section: "Utils" }
];

function code(values: Values): string {
    const props = ["items={docs}", 'keys={["title"]}', "onSelect={(doc) => go(doc.href)}"];
    if (values.grouped) props.push("groupBy={(doc) => doc.section}");
    if (!values.recents) props.push("recents={false}");
    if (values.placeholder !== "Search") props.push(`placeholder="${values.placeholder}"`);
    if (!values.footer) props.push("footer={null}");

    return `import { SearchPalette } from "@enigmax/primitives/react/palette";\n\n<SearchPalette\n${props.map((prop) => `    ${prop}`).join("\n")}\n/>`;
}

export function PalettePlayground() {
    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            render={(values) => (
                <div className="pg-palette">
                    <SearchPalette
                        items={DOCS}
                        keys={["title"]}
                        delay={0}
                        labelOf={(doc) => doc.title}
                        groupBy={values.grouped ? (doc) => doc.section : undefined}
                        recents={values.recents}
                        recentsKey="enigma:docs:palette-demo"
                        placeholder={values.placeholder}
                        footer={values.footer ? undefined : null}
                        // Bound to a key this page does not otherwise use, so trying it here
                        // never fights the browser's own Ctrl+K.
                        shortcut="j"
                        onSelect={() => undefined}
                    />
                    <p className="pg-flag-alt">or press Ctrl/Cmd + J anywhere on this page</p>
                </div>
            )}
        />
    );
}
