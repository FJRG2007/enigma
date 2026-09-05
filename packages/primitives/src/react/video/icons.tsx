import type { ReactNode } from "react";

/** The player's icons, drawn rather than loaded - a sprite would be a request per player. */

function Glyph({ children, filled = false }: { children: ReactNode; filled?: boolean; }): ReactNode {
    return (
        <svg
            viewBox="0 0 24 24"
            width="1.25em"
            height="1.25em"
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
    return <Glyph filled><path d="M8 5.5v13l11-6.5z" /></Glyph>;
}

export function Pause(): ReactNode {
    return <Glyph filled><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></Glyph>;
}

export function Volume(): ReactNode {
    return <Glyph><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7" /><path d="M19 6a9 9 0 0 1 0 12" /></Glyph>;
}

export function VolumeLow(): ReactNode {
    return <Glyph><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7" /></Glyph>;
}

export function Muted(): ReactNode {
    return <Glyph><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="m17 9 5 6M22 9l-5 6" /></Glyph>;
}

export function Captions(): ReactNode {
    return <Glyph><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M10 10.5a2.5 2.5 0 1 0 0 3M17 10.5a2.5 2.5 0 1 0 0 3" /></Glyph>;
}

export function Settings(): ReactNode {
    return <Glyph><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.9 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 13.9H4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 5.1 7.2L5 7.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1A2 2 0 1 1 20.2 7l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3Z" /></Glyph>;
}

export function Pip(): ReactNode {
    return <Glyph><rect x="3" y="5" width="18" height="14" rx="2.5" /><rect x="12" y="12" width="7" height="5" rx="1" /></Glyph>;
}

export function Expand(): ReactNode {
    return <Glyph><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Glyph>;
}

export function Collapse(): ReactNode {
    return <Glyph><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></Glyph>;
}

export function Download(): ReactNode {
    return <Glyph><path d="M12 3v12M7 11l5 5 5-5M4 20h16" /></Glyph>;
}
