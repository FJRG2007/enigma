import { useState } from "react";
import { Playground, type Control, type StyleToken } from "./Playground";
import { ContextMenu, type ContextMenuNode } from "@enigmax/primitives/react/context-menu";

/**
 * The context menu's playground. Right-click the pane and the menu that appears is the
 * shipped component with the shipped theme - the only way to judge a control whose whole
 * behaviour happens after a press the page cannot draw.
 */

interface Values extends Record<string, string | boolean> {
    title: string;
    clipboard: boolean;
    icons: boolean;
    shortcuts: boolean;
    descriptions: boolean;
    destructive: boolean;
    submenu: boolean;
    lazy: boolean;
    many: boolean;
    empty: boolean;
}

const CONTROLS: Control<Values>[] = [
    { name: "title", label: "Heading", type: "text", placeholder: "report.pdf", hint: "what the rows act on" },
    { name: "clipboard", label: "Copy / Cut / Paste", type: "boolean", hint: "on by default - try the field" },
    { name: "icons", label: "Icons", type: "boolean" },
    { name: "shortcuts", label: "Shortcuts", type: "boolean", hint: "written for your platform" },
    { name: "descriptions", label: "Second line", type: "boolean" },
    { name: "destructive", label: "Destructive row", type: "boolean" },
    { name: "submenu", label: "Submenu", type: "boolean" },
    { name: "lazy", label: "Fetched submenu", type: "boolean", hint: "loads once, then cached" },
    { name: "many", label: "Long level", type: "boolean", hint: "200 more rows here, with a filter" },
    { name: "empty", label: "No rows", type: "boolean", hint: "nothing opens at all" }
];

const STYLE: StyleToken[] = [
    { name: "enigma-menu-bg", label: "Panel", type: "color", property: "--enigma-menu-bg", value: "#12161f" },
    { name: "enigma-menu-border", label: "Border", type: "color", property: "--enigma-menu-border", value: "#232a36" },
    { name: "enigma-menu-active-bg", label: "Highlight", type: "color", property: "--enigma-menu-active-bg", value: "#1a1f2b" },
    { name: "enigma-menu-danger", label: "Destructive", type: "color", property: "--enigma-menu-danger", value: "#d7875f" },
    { name: "enigma-menu-radius", label: "Radius", type: "px", property: "--enigma-menu-radius", value: "10px", min: 0, max: 20 },
    { name: "enigma-menu-min-width", label: "Min width", type: "px", property: "--enigma-menu-min-width", value: "200px", min: 120, max: 320 }
];

const INITIAL: Values = {
    title: "report.pdf",
    clipboard: true,
    icons: true,
    shortcuts: true,
    descriptions: false,
    destructive: true,
    submenu: true,
    lazy: false,
    many: false,
    empty: false
};

/** Two hundred rows: the case a filter and a render window exist for. */
const MANY = Array.from({ length: 200 }, (_, index) => ({ id: `tag-${index}`, label: `Tag ${index}` }));

function icon(path: string) {
    return <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d={path} /></svg>;
}

const ICONS = {
    open: "M5 12h14M13 6l6 6-6 6",
    rename: "M4 20h4l10-10-4-4L4 16v4Z",
    copy: "M9 9h10v10H9zM5 15V5h10",
    share: "M12 4v11M8 8l4-4 4 4M5 20h14",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"
};

function items(values: Values): ContextMenuNode[] {
    if (values.empty) return [];

    const rows: ContextMenuNode[] = [
        {
            id: "open",
            label: "Open",
            shortcut: values.shortcuts ? "Enter" : undefined,
            icon: values.icons ? icon(ICONS.open) : undefined,
            description: values.descriptions ? "In this window" : undefined
        },
        {
            id: "rename",
            label: "Rename",
            shortcut: values.shortcuts ? "F2" : undefined,
            icon: values.icons ? icon(ICONS.rename) : undefined,
            description: values.descriptions ? "Give it another name" : undefined
        },
        { id: "locked", label: "Move to...", disabled: true, icon: values.icons ? icon(ICONS.copy) : undefined }
    ];

    if (values.submenu) {
        rows.push({ type: "separator" }, {
            id: "share",
            label: "Share",
            icon: values.icons ? icon(ICONS.share) : undefined,
            items: [
                { id: "link", label: "Copy link", shortcut: values.shortcuts ? "Mod+C" : undefined },
                { id: "email", label: "Email" },
                { type: "separator" },
                { id: "public", label: "Anyone with the link", checked: true, group: "who" },
                { id: "team", label: "People in the team", checked: false, group: "who" }
            ]
        });
    }

    if (values.lazy) {
        rows.push({
            id: "tags",
            label: "Tags",
            title: "Add a tag",
            // Resolved immediately: this demo is about the branch being FETCHED and then
            // cached, and an artificial wait only makes the panel feel slow.
            loadItems: async () => [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }, { id: "green", label: "Green" }]
        });
    }

    // Appended to the ROOT level, so the filter and the render window are the first thing
    // you see rather than something hidden one hover deep.
    if (values.many) rows.push({ type: "separator" }, { type: "label", label: "Tags" }, ...MANY);

    if (values.destructive) {
        rows.push({ type: "separator" }, {
            id: "delete",
            label: "Delete",
            shortcut: values.shortcuts ? "Delete" : undefined,
            icon: values.icons ? icon(ICONS.trash) : undefined,
            destructive: true
        });
    }

    return rows;
}

function code(values: Values): string {
    const props: string[] = ["items={rows}", "onSelect={(item) => run(item.id)}"];
    if (values.title) props.push(`title="${values.title}"`);
    if (!values.clipboard) props.push("clipboard={false}");

    const row = [
        '    { id: "rename", label: "Rename"',
        values.shortcuts ? ', shortcut: "F2"' : "",
        values.icons ? ", icon: <Pencil />" : "",
        values.descriptions ? ', description: "Give it another name"' : "",
        " },"
    ].join("");

    const extra = [
        values.submenu ? '    { id: "share", label: "Share", items: [{ id: "link", label: "Copy link" }] },' : "",
        values.lazy ? '    { id: "tags", label: "Tags", loadItems: () => fetch("/tags").then((r) => r.json()) },' : "",
        values.destructive ? '    { type: "separator" },\n    { id: "delete", label: "Delete", shortcut: "Delete", destructive: true }' : ""
    ].filter(Boolean).join("\n");

    return [
        'import { ContextMenu } from "@enigmax/primitives/react/context-menu";',
        "",
        `const rows = [\n${row}\n${extra}\n];`,
        "",
        `<ContextMenu\n${props.map((prop) => `    ${prop}`).join("\n")}\n>\n    <FileRow file={file} />\n</ContextMenu>`
    ].join("\n");
}

/** The live one, reporting what was chosen the way a real handler would act on it. */
function Live({ values }: { values: Values; }) {
    const [chosen, setChosen] = useState<string | null>(null);

    return (
        <div className="pg-menu">
            <ContextMenu
                title={values.title || undefined}
                items={items(values)}
                onSelect={(item, path) => setChosen(path.join(" / "))}
                clipboard={values.clipboard}
                triggerProps={{ className: "pg-menu-area" }}
            >
                <span>Right-click here</span>
                <span className="pg-menu-hint">or press Shift+F10</span>
                {/* A real field, because Copy, Cut and Paste are built from what was clicked:
                    over the pane they cannot appear, and over a selection in here they do. */}
                <input className="pg-menu-field" defaultValue="Select this, then right-click" aria-label="Something to copy" />
            </ContextMenu>
            <p className="pg-menu-out" aria-live="polite">
                {chosen ? <>Chose <code>{chosen}</code></> : values.empty ? "Nothing to show, so nothing opens." : "Nothing chosen yet."}
            </p>
        </div>
    );
}

export function ContextMenuPlayground() {
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
