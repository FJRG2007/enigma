/**
 * What a color token's name says about its role. A name is the strongest signal there is:
 * `--bg`, `--text` and `--muted-foreground` state their job outright, while qualified
 * names (`warning-bg`, `accent2`, `border-soft`) are variants that must not take a role.
 */

import type { ColorRole } from "./types";

/** Token names that state a role outright (`--bg`, `--text`, `--color-border`, `--muted-foreground`). */
const NAMED_ROLES: Record<string, ColorRole> = {
    "page-background": "background", "background": "background", "bg": "background", "page": "background", "base": "background", "body": "background",
    "surface": "surface", "card": "surface", "panel": "surface", "elevated": "surface",
    "page-text": "text-primary", "text": "text-primary", "fg": "text-primary", "foreground": "text-primary", "text-primary": "text-primary", "ink": "text-primary",
    "muted": "text-muted", "text-muted": "text-muted", "muted-foreground": "text-muted", "text-secondary": "text-muted", "subtle": "text-muted",
    "border": "border", "line": "border", "divider": "border", "stroke": "border",
    "accent": "accent", "primary": "accent", "brand": "accent", "link": "accent",
    "danger": "danger", "error": "danger", "destructive": "danger",
    "success": "success", "positive": "success",
    "warning": "warning", "warn": "warning", "caution": "warning",
    "info": "info", "notice": "info",
};

/**
 * A qualified token (`warning-bg`, `accent2`, `border-soft`, `primary-hover`) is a
 * variant of a role, not the role itself: it must not take the role's slot.
 */
const VARIANT_SUFFIX = /(\d+|-(bg|background|border|text|fg|foreground|weak|soft|strong|subtle|hover|active|focus|pressed|light|dark|alt|contrast|inverse|50|100|200|300|400|500|600|700|800|900))$/;

export function roleFromName(raw: string): ColorRole | null {
    const name = raw.toLowerCase().replace(/^(color|colour|clr|c)-/, "").replace(/-colou?r$/, "");
    const exact = NAMED_ROLES[name];
    if (exact) return exact;
    if (VARIANT_SUFFIX.test(name)) return null;
    if (/\b(surface|card|panel)\b/.test(name)) return "surface";
    if (/\b(accent|primary-action)\b/.test(name) && !/text|font/.test(name)) return "accent";
    if (/\b(muted|subtle|secondary|placeholder|caption)\b/.test(name) && /text|fg|foreground|font|color/.test(name)) return "text-muted";
    return null;
}

/** True when the name maps to a role outright, not through a fuzzy pattern. */
function isExactRoleName(raw: string): boolean {
    return !!NAMED_ROLES[raw.toLowerCase().replace(/^(color|colour|clr|c)-/, "").replace(/-colou?r$/, "")];
}

/**
 * The name to keep when one color is seen under two: the first, unless the newcomer
 * names a role outright and the first does not (a hex shared by `--bg` and
 * `--info-bg` is the background).
 */
export function preferredName(current: string | undefined, candidate: string | undefined): string | undefined {
    if (!candidate) return current;
    if (!current) return candidate;
    return isExactRoleName(candidate) && !isExactRoleName(current) ? candidate : current;
}
