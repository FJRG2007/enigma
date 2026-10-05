/**
 * Font-family classification shared by the extractors, the normalizer and the font
 * bundler: which names are real typefaces worth documenting (and downloading), and which
 * are generic keywords, OS system stacks, icon fonts, emoji fonts or parser debris.
 */

export function isGenericFont(family: string): boolean {
    return /^(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|inherit|initial|unset)$/i.test(family);
}

/** OS-provided stacks: implicit on the platform, never downloadable. */
export function isSystemFont(family: string): boolean {
    return /^(-apple-system|blinkmacsystemfont|system-ui|ui-sans-serif|ui-serif|ui-monospace|segoe\s*ui|\.sf\s*(pro|compact))/i.test(family);
}

/** Icon and symbol fonts: they would pollute a typography section. */
export function isIconFont(family: string): boolean {
    return /^(apple\s*(icons?|legacy|sf\s*symbols?)|material\s*(icons?|symbols?)|font\s*awesome|fontawesome|glyphicons?|ionicons?|feather|remixicon|octicons?|bootstrap\s*icons?|hero\s*icons?|phosphor|tabler|lucide)\b/i.test(family)
        || /^apple\s*icons?\s*\d+/i.test(family)
        || /^apple\s*legacy\s*chevron/i.test(family);
}

export function isEmojiFont(family: string): boolean {
    return /^(apple\s*color\s*emoji|noto\s*color\s*emoji|segoe\s*ui\s*emoji|android\s*emoji|twemoji|emoji)/i.test(family);
}

/** Rejects debris a regex pass can capture as a "font name": CSS syntax, numbers, HTML. */
export function isValidFontName(family: string): boolean {
    if (/[{};()]/.test(family)) return false;
    if (/[\n\r<>]/.test(family)) return false;
    if (/^\s*(font-family|font-size|font-weight|color|background|margin|padding)\b/i.test(family)) return false;
    if (/^var\(/i.test(family)) return false;
    if (/^\d+(\.\d+)?(px|rem|em|%)?$/.test(family)) return false;
    return family.length <= 50;
}

export function isMonoFont(family: string): boolean {
    return /mono|consolas|courier|fira\s*code|jetbrains|sf\s*mono|menlo|\bhack\b|source\s*code/i.test(family);
}

/** The first real typeface in a `font-family` stack, skipping generics, system, icon and emoji fonts. */
export function firstRealFont(value: string): string | null {
    for (const raw of value.split(",")) {
        const family = raw.replace(/["']/g, "").trim();
        if (!family || family.startsWith("var(")) continue;
        if (isGenericFont(family) || isSystemFont(family) || isIconFont(family) || isEmojiFont(family)) continue;
        if (!isValidFontName(family)) continue;
        return family;
    }
    return null;
}
