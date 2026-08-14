import "./styles.css";
import type { ReactNode, Ref } from "react";
import { useMarquee, type MarqueeHover } from "@enigmax/primitives/react";

/**
 * The "trusted by" logo wall, yours to edit.
 *
 * A logo wall is a marquee with one extra job: the logos arrive at wildly different aspect
 * ratios and optical weights, and a row that just drops them in reads as random. Normalising
 * them to a common height is most of what makes it look designed.
 *
 * Some of the logos in any real wall are not images - Bloomberg, NASA and Harvard are set in
 * type - so an item is either an image or a node.
 */

export type LogoItem =
    /**
     * A URL, which is the whole entry for most logos:
     * `logos={["/logos/claude.svg", "/logos/openai.svg"]}`.
     *
     * It carries no `alt` - an alt guessed from a file name is a fabricated one, and a
     * wrong alt is worse than an empty one. Use the object form where a mark needs a name.
     */
    | string
    | { kind: "img"; src: string; alt?: string; /** Override the shared height for one that reads small. */ height?: number; }
    | { kind: "node"; node: ReactNode; key?: string; };

/** The object form of whatever was passed. A bare URL is an image with no alt. */
function normalize(item: LogoItem): Exclude<LogoItem, string> {
    return typeof item === "string" ? { kind: "img", src: item } : item;
}

export interface LogoMarqueeProps {
    logos: LogoItem[];
    /**
     * Pixels per second. NEVER a duration: a lap is as long as its content, so seconds-per-
     * loop makes the speed content/duration and the row runs faster every time a logo is
     * added. Measured on one rail: 45, 67 and 87 px/s at 10, 15 and 20 items.
     */
    speed?: number;
    /** Space between logos, in px. */
    gap?: number;
    /** Fade both ends, so logos enter and leave instead of being cut. */
    fade?: boolean;
    /**
     * What a pointer resting on the row does: "off", "pause", a multiplier (0.15 crawls),
     * or `{ speed }` for an absolute px/s.
     */
    hover?: MarqueeHover;
    reverse?: boolean;
    /** The shared optical height every image is scaled to. */
    logoHeight?: number;
    /**
     * `mono` drains the colour so twelve brand palettes stop fighting each other, and
     * restores it under the pointer. `brand` leaves them alone.
     */
    tone?: "brand" | "mono";
    /** Names the row for a screen reader, e.g. "Trusted by". Untranslated by default. */
    label?: string;
    className?: string;
}

export function LogoMarquee({
    logos,
    speed = 40,
    gap = 56,
    fade = true,
    hover = "off",
    reverse = false,
    logoHeight = 28,
    tone = "mono",
    label,
    className = ""
}: LogoMarqueeProps) {
    const { laneRef, trackRef, copies, dragging } = useMarquee({ speed, hover, reverse });

    const render = (raw: LogoItem, index: number): ReactNode => {
        const item = normalize(raw);
        return (
        <span className="logo-marquee__item" key={item.kind === "node" ? item.key ?? index : index}>
            {item.kind === "img"
                ? <img
                    src={item.src}
                    // Empty by default: a wall of brand names read out one after another is
                    // noise, and `label` already says what the row is.
                    alt={item.alt ?? ""}
                    style={item.height ? { height: `${item.height}px` } : undefined}
                    draggable={false}
                    // Never lazy: the row measures its own lap from the rendered width, and
                    // an image with no size yet measures as nothing.
                    decoding="async"
                />
                : item.node}
        </span>
        );
    };

    return (
        <div
            ref={laneRef as Ref<HTMLDivElement>}
            className={["logo-marquee", fade ? "is-faded" : "", className].filter(Boolean).join(" ")}
            style={{ "--logo-marquee-gap": `${gap}px`, "--logo-marquee-height": `${logoHeight}px` } as React.CSSProperties}
            data-tone={tone}
            data-grabbing={dragging ? "" : undefined}
            role={label ? "group" : undefined}
            aria-label={label}
        >
            <div ref={trackRef as Ref<HTMLDivElement>} className="logo-marquee__track">
                {Array.from({ length: copies }, (unused, copy) => (
                    // Only the first copy is read: the rest are the same logos again, and a
                    // screen reader announcing the wall three times is the bug this prevents.
                    <div key={copy} aria-hidden={copy > 0} className="logo-marquee__copy">
                        {logos.map(render)}
                    </div>
                ))}
            </div>
        </div>
    );
}
