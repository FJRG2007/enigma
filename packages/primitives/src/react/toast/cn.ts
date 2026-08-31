/**
 * The class-name joiner the vendored component imports.
 *
 * Its own file, and two lines, because the alternative is editing the component: everything
 * in this directory is upstream's, kept as close to verbatim as a library can keep it, and
 * one helper is a cheaper thing to supply than a diff to maintain.
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
    return classes.filter(Boolean).join(" ");
}
