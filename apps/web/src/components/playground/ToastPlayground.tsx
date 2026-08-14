import "@enigmax/primitives/toast.css";
import { Playground, type Control } from "./Playground";
import { Toaster, useNotifications } from "@enigmax/primitives/react";
import type { NotificationTone, ToastPosition } from "@enigmax/primitives/react";

/**
 * The toast's playground. Raising one is the only way to judge a toast, so the preview is a
 * button that raises a real one into a real `<Toaster>` - the stack, the timer, the swipe
 * and the exit are all the shipped ones.
 */

interface Values extends Record<string, string | boolean> {
    title: string;
    body: string;
    tone: string;
    position: string;
    action: boolean;
    sticky: boolean;
}

const CONTROLS: Control<Values>[] = [
    { name: "title", label: "Title", type: "text", placeholder: "Saved" },
    { name: "body", label: "Body", type: "text", placeholder: "Two files changed" },
    {
        name: "tone", label: "Tone", type: "select",
        options: ["info", "success", "warning", "error", "loading"].map((tone) => ({ value: tone, label: tone }))
    },
    {
        name: "position", label: "Position", type: "select",
        options: ["bottom-right", "bottom-center", "bottom-left", "top-right", "top-center", "top-left"]
            .map((position) => ({ value: position, label: position }))
    },
    { name: "action", label: "Undo action", type: "boolean" },
    { name: "sticky", label: "Stays until dismissed", type: "boolean", hint: "errors do anyway" }
];

const INITIAL: Values = { title: "Saved", body: "Two files changed", tone: "success", position: "bottom-right", action: false, sticky: false };

function code(values: Values): string {
    const fields = [`title: "${values.title || "Saved"}"`];
    if (values.body) fields.push(`body: "${values.body}"`);
    if (values.tone !== "info") fields.push(`tone: "${values.tone}"`);
    if (values.sticky) fields.push("duration: Infinity");
    if (values.action) fields.push('action: { label: "Undo", onSelect: () => restore() }');

    const mount = values.position === "bottom-right" ? "<Toaster />" : `<Toaster position="${values.position}" />`;
    return [
        'import { Toaster, useNotifications } from "@enigmax/primitives/react";',
        'import "@enigmax/primitives/toast.css";',
        "",
        "// once, near the root",
        mount,
        "",
        "// anywhere",
        "const { notify } = useNotifications();",
        `notify({\n${fields.map((field) => `    ${field}`).join(",\n")}\n});`
    ].join("\n");
}

function Raise({ values }: { values: Values; }) {
    const { notify } = useNotifications();

    return (
        <button
            type="button"
            className="pg-btn"
            onClick={() => notify({
                title: values.title || "Saved",
                body: values.body || undefined,
                tone: values.tone as NotificationTone,
                duration: values.sticky ? Infinity : undefined,
                action: values.action ? { label: "Undo", onSelect: () => { /* nothing to undo here */ } } : undefined
            })}
        >Raise a toast</button>
    );
}

export function ToastPlayground() {
    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            render={(values) => (
                <>
                    <Raise values={values} />
                    {/* The real one, on the page. Hover it and the timer stops; drag it
                        towards its edge and it goes. */}
                    <Toaster position={values.position as ToastPosition} />
                </>
            )}
        />
    );
}
