import type { ReactNode } from "react";

/**
 * The player's icons, drawn rather than loaded - a sprite would be a request per player.
 *
 * All of them are on ONE 24x24 grid and inside it. That is not a formality: the gear used to
 * carry a path with absolute `V21` and `H4` commands in it, which drew a shape half again the
 * size of the box and hanging off the bottom of its button while every other control sat
 * centred. An icon that leaves the viewBox cannot be centred by the button it is in.
 *
 * The size comes from the stylesheet (`--enigma-video-icon-size`), not from the label's font:
 * `1.25em` of a 13px bar is a 16px icon, and the same markup in a project with larger text
 * silently grew a different player.
 */

function Glyph({ children, filled = false }: { children: ReactNode; filled?: boolean; }): ReactNode {
    return (
        <svg
            viewBox="0 0 24 24"
            width="1em"
            height="1em"
            fill={filled ? "currentColor" : "none"}
            stroke={filled ? "none" : "currentColor"}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {children}
        </svg>
    );
}

export function Play(): ReactNode {
    // Centroid at x 11.7 rather than the box's 12: a triangle centred by its bounding box
    // reads as sitting too far left, which is why every player nudges it right.
    return <Glyph filled><path d="M8 5v14l11-7z" /></Glyph>;
}

export function Pause(): ReactNode {
    return <Glyph filled><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></Glyph>;
}

export function Volume(): ReactNode {
    return <Glyph><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a10 10 0 0 1 0 14" /></Glyph>;
}

export function VolumeLow(): ReactNode {
    return <Glyph><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></Glyph>;
}

export function Muted(): ReactNode {
    return <Glyph><path d="M11 5 6 9H2v6h4l5 4z" /><path d="m16 9 6 6M22 9l-6 6" /></Glyph>;
}

export function Captions(): ReactNode {
    return <Glyph><rect x="2" y="5" width="20" height="14" rx="2.5" /><path d="M7 11h3M7 15h5M14 11h3M14 15h3" /></Glyph>;
}

/** The same box with the lines struck through, for captions that are off. */
export function CaptionsOff(): ReactNode {
    return (
        <Glyph>
            <path d="M10.5 5H19.5a2.5 2.5 0 0 1 2.5 2.5v9M18 19H4.5A2.5 2.5 0 0 1 2 16.5v-9A2.5 2.5 0 0 1 4.5 5" />
            <path d="M7 11h3M7 15h5" />
            <path d="m3 3 18 18" />
        </Glyph>
    );
}

export function Settings(): ReactNode {
    return (
        <Glyph>
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
            <circle cx="12" cy="12" r="3" />
        </Glyph>
    );
}

export function Pip(): ReactNode {
    return <Glyph><path d="M21 11V6.5A2.5 2.5 0 0 0 18.5 4h-13A2.5 2.5 0 0 0 3 6.5v9A2.5 2.5 0 0 0 5.5 18H9" /><rect x="12" y="12" width="9" height="7" rx="1.5" /></Glyph>;
}

/** The screen with the signal arcs - the glyph every platform casts with. */
export function Cast(): ReactNode {
    return (
        <Glyph>
            <path d="M3 8V6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5H13" />
            <path d="M3 12a8 8 0 0 1 8 8" />
            <path d="M3 16a4 4 0 0 1 4 4" />
            <path d="M3 20h.01" />
        </Glyph>
    );
}

export function Expand(): ReactNode {
    return <Glyph><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Glyph>;
}

export function Collapse(): ReactNode {
    return <Glyph><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></Glyph>;
}

export function Download(): ReactNode {
    return <Glyph><path d="M12 4v11M7 11l5 5 5-5M4 19h16" /></Glyph>;
}

/** The tick beside a chosen row in the settings panel. */
export function Check(): ReactNode {
    return <Glyph><path d="m5 12.5 4.5 4.5L19 7" /></Glyph>;
}

export function ChevronRight(): ReactNode {
    return <Glyph><path d="m9 5 7 7-7 7" /></Glyph>;
}

export function ChevronLeft(): ReactNode {
    return <Glyph><path d="m15 5-7 7 7 7" /></Glyph>;
}

export function Loop(): ReactNode {
    return <Glyph><path d="M17 2.5 20.5 6 17 9.5" /><path d="M3.5 12V9a3 3 0 0 1 3-3h14" /><path d="M7 21.5 3.5 18 7 14.5" /><path d="M20.5 12v3a3 3 0 0 1-3 3h-14" /></Glyph>;
}

export function Link(): ReactNode {
    return <Glyph><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.4" /><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.3-1.3" /></Glyph>;
}

export function Clock(): ReactNode {
    return <Glyph><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></Glyph>;
}

export function Speed(): ReactNode {
    return <Glyph><path d="M12 20a8 8 0 1 0-8-8" /><path d="M4 20h16" /><path d="m12 12 4.5-4.5" /></Glyph>;
}
