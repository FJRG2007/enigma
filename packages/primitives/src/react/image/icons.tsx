import type { ReactNode } from "react";

/**
 * The viewer's icons, drawn rather than loaded.
 *
 * A sprite or an SVG file would be a request, and an icon package would be a dependency for
 * eight paths. They sit in one module so the viewer and its menu share them without either
 * pulling the other's chunk.
 */

function Glyph({ children }: { children: ReactNode; }): ReactNode {
    return (
        <svg viewBox="0 0 24 24" width="1.125em" height="1.125em" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {children}
        </svg>
    );
}

export function Close(): ReactNode {
    return <Glyph><path d="M6 6 18 18M18 6 6 18" /></Glyph>;
}

export function Plus(): ReactNode {
    return <Glyph><path d="M12 5v14M5 12h14" /></Glyph>;
}

export function Minus(): ReactNode {
    return <Glyph><path d="M5 12h14" /></Glyph>;
}

export function ChevronLeft(): ReactNode {
    return <Glyph><path d="m15 5-7 7 7 7" /></Glyph>;
}

export function ChevronRight(): ReactNode {
    return <Glyph><path d="m9 5 7 7-7 7" /></Glyph>;
}

export function Trash(): ReactNode {
    return <Glyph><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></Glyph>;
}

export function Dots(): ReactNode {
    return (
        <svg viewBox="0 0 24 24" width="1.125em" height="1.125em" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="1.75" />
            <circle cx="12" cy="12" r="1.75" />
            <circle cx="12" cy="19" r="1.75" />
        </svg>
    );
}

export function Download(): ReactNode {
    return <Glyph><path d="M12 3v12M7 11l5 5 5-5M4 20h16" /></Glyph>;
}

export function NewTab(): ReactNode {
    return <Glyph><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V7.5A1.5 1.5 0 0 1 5.5 6H10" /></Glyph>;
}
