import { Playground, type Control } from "./Playground";
// enigma:allow-deep-relative - the recipe is COPIED into a project, not imported from the
// package, so the docs load the exact file `enigma add logo-marquee --copy` writes. A copy
// of it here would be a second version to keep in step, which is the drift this avoids.
import { LogoMarquee, type LogoItem } from "../../../../../packages/primitives/recipes/logo-marquee/index";

/**
 * The logo wall's playground. The interesting controls are the two that make a wall look
 * designed rather than assembled: one optical height for logos that arrive at a dozen
 * sizes, and the colour drained so the palettes stop competing.
 */

// Mixed on purpose: a bare URL, the object form with a real alt, and a node. All three are
// the same list.
const LOGOS: LogoItem[] = [
    { kind: "img", src: "/enigma/logos/claude.svg", alt: "Claude" },
    { kind: "node", node: <span>NASA</span>, key: "nasa" },
    "/enigma/logos/openai.svg",
    { kind: "node", node: <span>BLOOMBERG</span>, key: "bloomberg" },
    "/enigma/logos/kimi.svg",
    { kind: "img", src: "/enigma/logos/opencode.svg", alt: "OpenCode" },
    { kind: "node", node: <span>HARVARD</span>, key: "harvard" }
];

interface Values extends Record<string, string | boolean> {
    speed: string;
    gap: string;
    logoHeight: string;
    tone: string;
    fade: boolean;
    hover: boolean;
}

const CONTROLS: Control<Values>[] = [
    {
        name: "speed", label: "Speed", type: "select", hint: "px per second",
        options: [{ value: "20", label: "20 px/s" }, { value: "40", label: "40 px/s" }, { value: "90", label: "90 px/s" }]
    },
    {
        name: "logoHeight", label: "Logo height", type: "select", hint: "one for all of them",
        options: [{ value: "20", label: "20px" }, { value: "28", label: "28px" }, { value: "40", label: "40px" }]
    },
    {
        name: "gap", label: "Gap", type: "select",
        options: [{ value: "32", label: "32px" }, { value: "56", label: "56px" }, { value: "88", label: "88px" }]
    },
    {
        name: "tone", label: "Colour", type: "select",
        options: [{ value: "mono", label: "drained" }, { value: "brand", label: "brand" }]
    },
    { name: "fade", label: "Fade the ends", type: "boolean" },
    { name: "hover", label: "Pause on hover", type: "boolean" }
];

const INITIAL: Values = { speed: "40", gap: "56", logoHeight: "28", tone: "mono", fade: true, hover: true };

function code(values: Values): string {
    const props: string[] = ["logos={logos}"];
    if (values.speed !== "40") props.push(`speed={${values.speed}}`);
    if (values.gap !== "56") props.push(`gap={${values.gap}}`);
    if (values.logoHeight !== "28") props.push(`logoHeight={${values.logoHeight}}`);
    if (values.tone !== "mono") props.push(`tone="${values.tone}"`);
    if (!values.fade) props.push("fade={false}");
    if (values.hover) props.push('hover="pause"');

    return [
        'import { LogoMarquee } from "./logo-marquee";',
        "",
        "const logos = [",
        '    "/logos/openai.svg",                                  // a URL is enough',
        '    { kind: "img",  src: stripeSvgUrl, alt: "Stripe" },   // unless it needs an alt',
        '    { kind: "node", node: <span>NASA</span> }             // or is set in type',
        "];",
        "",
        `<LogoMarquee ${props.join(" ")} />`
    ].join("\n");
}

export function LogoMarqueePlayground() {
    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            render={(values) => (
                <div className="pg-wall">
                    <LogoMarquee
                        // Remounted per speed so the row restarts from the new cruise
                        // instead of easing into it from whatever it was doing.
                        key={values.speed}
                        logos={LOGOS}
                        speed={Number(values.speed)}
                        gap={Number(values.gap)}
                        logoHeight={Number(values.logoHeight)}
                        tone={values.tone === "brand" ? "brand" : "mono"}
                        fade={values.fade}
                        hover={values.hover ? "pause" : "off"}
                        label="Trusted by"
                    />
                </div>
            )}
        />
    );
}
