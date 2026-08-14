import type { Ref } from "react";
import "@enigmax/primitives/marquee.css";
import { Playground, type Control } from "./Playground";
import { useMarquee, type MarqueeHover } from "@enigmax/primitives/react";

/**
 * The marquee's playground. Speed is in px/s and that is the whole point of the primitive -
 * so the control is a speed, and adding items never changes it. Grab the row and throw it.
 */

const ITEMS = ["guardrails", "quality gate", "code graph", "recall", "autoskills", "compress", "packs", "marquee"];

interface Values extends Record<string, string | boolean> {
    speed: string;
    hover: string;
    reverse: boolean;
    fade: boolean;
}

const CONTROLS: Control<Values>[] = [
    {
        name: "speed", label: "Speed", type: "select",
        options: [{ value: "25", label: "25 px/s" }, { value: "70", label: "70 px/s" }, { value: "160", label: "160 px/s" }]
    },
    {
        name: "hover", label: "On hover", type: "select",
        hint: "rest a pointer on it",
        options: [
            { value: "off", label: "nothing" },
            { value: "pause", label: "pause" },
            { value: "0.15", label: "crawl (0.15x)" },
            { value: "2", label: "double" }
        ]
    },
    { name: "reverse", label: "Reverse", type: "boolean" },
    { name: "fade", label: "Fade the ends", type: "boolean" }
];

const INITIAL: Values = { speed: "70", hover: "pause", reverse: false, fade: true };

const hoverOf = (value: string): MarqueeHover => (value === "off" || value === "pause" ? value : Number(value));

function code(values: Values): string {
    const props: string[] = ["items={logos}"];
    if (values.speed !== "70") props.push(`speed={${values.speed}}`);
    if (values.hover !== "off") props.push(values.hover === "pause" ? 'hover="pause"' : `hover={${values.hover}}`);
    if (values.reverse) props.push("reverse");
    if (!values.fade) props.push("fade={false}");

    return [
        'import { Marquee } from "./marquee/Marquee";',
        "",
        `<Marquee ${props.join(" ")}>`,
        "    {(logo) => <img src={logo.src} alt={logo.name} />}",
        "</Marquee>"
    ].join("\n");
}

function Row({ values }: { values: Values; }) {
    const { laneRef, trackRef, copies, dragging } = useMarquee({
        speed: Number(values.speed),
        hover: hoverOf(values.hover),
        reverse: values.reverse
    });

    return (
        <div
            ref={laneRef as Ref<HTMLDivElement>}
            className={`enigma-marquee pg-marquee${values.fade ? " is-faded" : ""}`}
            data-grabbing={dragging ? "" : undefined}
        >
            <div ref={trackRef as Ref<HTMLDivElement>} className="enigma-marquee__track">
                {Array.from({ length: copies }, (unused, copy) => (
                    <div key={copy} aria-hidden={copy > 0} className="enigma-marquee__copy">
                        {ITEMS.map((item) => (
                            <div key={item} className="enigma-marquee__item"><span className="pg-pill">{item}</span></div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

export function MarqueePlayground() {
    return (
        <Playground<Values>
            controls={CONTROLS}
            initial={INITIAL}
            code={code}
            // Remounted per speed/direction so the engine restarts from the new cruise
            // rather than easing into it from whatever it was doing.
            render={(values) => <Row key={`${values.speed}-${values.reverse}`} values={values} />}
        />
    );
}
