import type { ReactNode } from "react";

/**
 * The built-in glyphs, drawn from the shared path data.
 *
 * Stroked with `currentColor` at 1em, so an icon inherits the field's text colour and size
 * and needs no styling of its own. Replacing one is a `FieldAction` with the same `name`.
 */
const ICON_PROPS = {
    viewBox: "0 0 24 24", width: "1em", height: "1em", fill: "none",
    stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
    "aria-hidden": true
} as const;

export function Icon({ paths }: { paths: readonly string[]; }): ReactNode {
    return <svg {...ICON_PROPS}>{paths.map((path) => <path key={path} d={path} />)}</svg>;
}
