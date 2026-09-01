import { useMemo, useState } from "react";
import { Playground, type Control, type StyleToken } from "./Playground";
import { ContextMenu, type ContextMenuNode } from "@enigmax/primitives/react/context-menu";
import { SelectionList, type SelectionShortcuts } from "@enigmax/primitives/react/selection";

/**
 * The selection list's playground. Everything worth judging here is a gesture - Ctrl+click,
 * Shift+click, Ctrl+A, a band dragged over the rows - so the preview is the component and the
 * panel beside it only decides what the component IS.
 */

interface Values extends Record<string, string | boolean> {
    multiple: boolean;
    columns: string;
    marquee: boolean;
    disabled: boolean;
    menu: boolean;
    renameKey: string;
    keyboard: boolean;
}

const CONTROLS: Control<Values>[] = [
    { name: "multiple", label: "Many rows", type: "boolean", hint: "off makes Ctrl and Shift mean nothing" },
    {
        name: "columns", label: "Layout", type: "select",
        options: [{ value: "1", label: "list" }, { value: "4", label: "grid" }]
    },
    { name: "marquee", label: "Rubber band", type: "boolean" },
    { name: "disabled", label: "One row locked", type: "boolean" },
    { name: "menu", label: "Right-click menu", type: "boolean", hint: "acts on the whole selection" },
    {
        name: "renameKey", label: "Rename key", type: "select",
        options: [{ value: "F2", label: "F2 (default)" }, { value: "F3", label: "F3" }, { value: "off", label: "removed" }]
    },
    { name: "keyboard", label: "Keyboard", type: "boolean", hint: "off removes every binding" }
];

const STYLE: StyleToken[] = [
    { name: "demo-pick-bg", label: "Selected", type: "color", property: "--demo-pick-bg", value: "rgba(224, 164, 88, 0.13)" },
    { name: "demo-pick-text", label: "Selected text", type: "color", property: "--demo-pick-text", value: "#eceef2" },
    { name: "demo-pick-cursor", label: "Cursor ring", type: "color", property: "--demo-pick-cursor", value: "#e0a458" },
    { name: "demo-pick-band", label: "Band", type: "color", property: "--demo-pick-band", value: "rgba(224, 164, 88, 0.18)" },
    { name: "demo-pick-radius", label: "Radius", type: "px", property: "--demo-pick-radius", value: "7px", min: 0, max: 16 }
];

const INITIAL: Values = {
    multiple: true,
    columns: "1",
    marquee: true,
    disabled: true,
    menu: true,
    renameKey: "F2",
    keyboard: true
};

interface Row {
    id: string;
    name: string;
    kind: "folder" | "file";
}

const ROWS: Row[] = [
    { id: "src", name: "src", kind: "folder" },
    { id: "public", name: "public", kind: "folder" },
    { id: "index", name: "index.html", kind: "file" },
    { id: "readme", name: "README.md", kind: "file" },
    { id: "package", name: "package.json", kind: "file" },
    { id: "lock", name: "package-lock.json", kind: "file" },
    { id: "config", name: "tsconfig.json", kind: "file" },
    { id: "license", name: "LICENSE", kind: "file" }
];

const MENU: ContextMenuNode[] = [
    { id: "open", label: "Open", shortcut: "Enter" },
    { id: "rename", label: "Rename", shortcut: "F2" },
    { type: "separator" },
    { id: "delete", label: "Delete", shortcut: "Delete", destructive: true }
];

function shortcuts(values: Values): SelectionShortcuts | false {
    if (!values.keyboard) return false;
    if (values.renameKey === "off") return { rename: false };
    if (values.renameKey === "F2") return {};
    return { rename: values.renameKey };
}

function code(values: Values): string {
    const props = ["items={files}", "getId={(file) => file.path}", "onCommand={run}"];
    if (!values.multiple) props.push("multiple={false}");
    if (values.columns !== "1") props.push(`columns={${values.columns}}`);
    if (!values.marquee) props.push("marquee={false}");
    if (values.disabled) props.push("disabled={(file) => file.readOnly}");
    if (!values.keyboard) props.push("shortcuts={false}");
    else if (values.renameKey === "off") props.push("shortcuts={{ rename: false }}");
    else if (values.renameKey !== "F2") props.push(`shortcuts={{ rename: "${values.renameKey}" }}`);

    return [
        'import { SelectionList } from "@enigmax/primitives/react/selection";',
        "",
        `<SelectionList\n${props.map((prop) => `    ${prop}`).join("\n")}\n>`,
        "    {({ item }) => <><FileIcon kind={item.kind} />{item.name}</>}",
        "</SelectionList>"
    ].join("\n");
}

/** The live one, holding the selection the way a file view would hold it. */
function Live({ values }: { values: Values; }) {
    const [last, setLast] = useState<string | null>(null);
    const [picked, setPicked] = useState<string[]>([]);

    const list = useMemo(() => (
        <SelectionList
            className="pg-pick"
            data-columns={values.columns}
            items={ROWS}
            getId={(row) => row.id}
            multiple={values.multiple}
            columns={Number(values.columns)}
            marquee={values.marquee}
            disabled={(row) => values.disabled && row.id === "lock"}
            shortcuts={shortcuts(values)}
            onSelectionChange={(ids) => setPicked(ids)}
            onCommand={(event) => setLast(`${event.command}: ${event.ids.join(", ") || "nothing"}`)}
        >
            {({ item }) => (
                <>
                    <span className="pg-pick-icon" aria-hidden="true">{item.kind === "folder" ? "▸" : "·"}</span>
                    <span className="pg-pick-name">{item.name}</span>
                </>
            )}
        </SelectionList>
        // Rebuilt when a control changes it, which is what the panel is for.
    ), [values]);

    return (
        <div className="pg-pick-wrap">
            {values.menu
                ? (
                    <ContextMenu
                        title={picked.length > 1 ? `${picked.length} items selected` : picked[0] ?? undefined}
                        items={picked.length > 0 ? MENU : []}
                        onSelect={(item) => setLast(`${item.id}: ${picked.join(", ")}`)}
                    >
                        {list}
                    </ContextMenu>
                )
                : list}
            <p className="pg-pick-out" aria-live="polite">
                {last ?? (picked.length > 0 ? `${picked.length} selected` : "Click a row. Ctrl adds, Shift takes a range, Ctrl+A everything.")}
            </p>
        </div>
    );
}

export function SelectionPlayground() {
    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            style={STYLE}
            styleSelector=".files"
            render={(values) => <Live values={values} />}
        />
    );
}
