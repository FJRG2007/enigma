import { useState } from "react";
import "@enigmax/primitives/input.css";
import { Input } from "@enigmax/primitives/react";
import { checkPasswordBreach } from "@enigmax/utils";
import { Playground, type Control } from "./Playground";

/**
 * The input's playground. Everything here is off until you ask for it, which is exactly how
 * the component behaves - so the default state of this panel is also the default component.
 */

interface Values extends Record<string, string | boolean> {
    placeholder: string;
    generate: boolean;
    strength: boolean;
    breach: boolean;
    position: string;
    disabled: boolean;
}

const CONTROLS: Control<Values>[] = [
    { name: "placeholder", label: "Placeholder", type: "text", placeholder: "Password" },
    { name: "generate", label: "Generator", type: "boolean", hint: "adds the wand" },
    { name: "strength", label: "Strength meter", type: "boolean", hint: "five bars" },
    { name: "breach", label: "Breach check", type: "boolean", hint: "asks Have I Been Pwned" },
    {
        name: "position", label: "Buttons", type: "select",
        options: [{ value: "end", label: "end" }, { value: "start", label: "start" }]
    },
    { name: "disabled", label: "Disabled", type: "boolean" }
];

const INITIAL: Values = { placeholder: "Password", generate: true, strength: true, breach: false, position: "end", disabled: false };

function code(values: Values): string {
    const props = ['type="password"', 'autoComplete="new-password"', "value={password}", "onChange={(event) => setPassword(event.target.value)}"];
    if (values.generate) props.push("generate");
    if (values.strength) props.push("strength={{ userInputs: [email] }}");
    if (values.breach) props.push("breach={checkPasswordBreach}");
    if (values.position !== "end") props.push(`position="${values.position}"`);
    if (values.disabled) props.push("disabled");
    if (values.placeholder) props.push(`placeholder="${values.placeholder}"`);

    const imports = values.breach
        ? 'import { Input } from "@enigmax/primitives/react";\nimport { checkPasswordBreach } from "@enigmax/utils";'
        : 'import { Input } from "@enigmax/primitives/react";';

    return `${imports}\n\n<Input\n${props.map((prop) => `    ${prop}`).join("\n")}\n/>`;
}

export function InputPlayground() {
    const [password, setPassword] = useState("");

    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            render={(values) => (
                <div className="pg-field">
                    <Input
                        type="password"
                        autoComplete="new-password"
                        placeholder={values.placeholder}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        disabled={values.disabled}
                        position={values.position === "start" ? "start" : "end"}
                        generate={values.generate}
                        strength={values.strength}
                        // Only when asked: it is a request to a third party, so it should
                        // never be something a docs page does behind the reader's back.
                        breach={values.breach ? checkPasswordBreach : undefined}
                    />
                </div>
            )}
        />
    );
}
