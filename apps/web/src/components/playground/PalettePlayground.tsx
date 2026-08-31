import "@enigmax/primitives/palette.css";
import { Playground, type Control, type StyleToken } from "./Playground";
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
    { name: "placeholder", label: "Placeholder", type: "text", placeholder: "Search the components" },
    { name: "grouped", label: "Groups", type: "boolean", hint: "one heading per section" },
    { name: "recents", label: "Remember searches", type: "boolean", hint: "in this browser" },
    { name: "footer", label: "Key hints", type: "boolean" }
];

/** The variables `@enigmax/primitives/palette.css` declares, so the CSS tab is real theming. */
const STYLE: StyleToken[] = [
    { name: "enigma-palette-bg", label: "Panel", type: "color", property: "--enigma-palette-bg", value: "#101010" },
    { name: "enigma-palette-border", label: "Border", type: "color", property: "--enigma-palette-border", value: "#2a2a2a" },
    { name: "enigma-palette-active", label: "Highlight", type: "color", property: "--enigma-palette-active", value: "#1c1c1c" },
    { name: "enigma-palette-accent", label: "Accent", type: "color", property: "--enigma-palette-accent", value: "#e0a458" },
    { name: "enigma-palette-radius", label: "Radius", type: "px", property: "--enigma-palette-radius", value: "14px", min: 0, max: 28 }
];

const INITIAL: Values = { placeholder: "Search the components", grouped: true, recents: true, footer: true };

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
            style={STYLE}
            styleSelector=":root"
            render={(values) => (
                <div className="pg-palette" data-palette-demo="">
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
                        // The real key. The site's own palette reads the marker below and
                        // stands down on this page, so the two never fight over it.
                        shortcut="k"
                        onSelect={() => undefined}
                    />
                    <p className="pg-flag-alt">or press Ctrl/Cmd + K anywhere on this page</p>
                </div>
            )}
        />
    );
}
