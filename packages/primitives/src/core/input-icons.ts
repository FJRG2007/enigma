/**
 * The icon shapes both renderers draw.
 *
 * Their own module because the React field imports NOTHING else from the vanilla adapter:
 * pulling `createInput` in for two arrays of path data put the whole imperative renderer
 * into every React bundle, for a component that never calls it.
 */

/**
 * The built-in glyphs, as path data.
 *
 * Path data rather than markup because there are two renderers: this file writes an SVG
 * string into a button it created, and the React component builds elements. Keeping the
 * shapes here means one definition, and a theme that replaces an icon replaces it in both.
 * Everything is stroked with `currentColor` at 1em, so an icon inherits the field's text.
 */
export const INPUT_ICON_PATHS = {
    eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"],
    eyeOff: [
        "M10.6 5.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.2 6.2A17.7 17.7 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.2-.9",
        "m2 2 20 20",
        "M9.9 9.9a3 3 0 0 0 4.2 4.2"
    ],
    generate: ["m12 3 1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9Z", "M19 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"],
    /** Clears a search field. The platform draws one only in WebKit, and not on mobile. */
    clear: ["m6 6 12 12", "m18 6-12 12"],
    search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z", "m20 20-4.2-4.2"]
} as const;

/** The same shapes as a standalone SVG string, for the DOM renderer below. */
export function iconMarkup(paths: readonly string[]): string {
    const body = paths.map((path) => `<path d="${path}"/>`).join("");
    return `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
