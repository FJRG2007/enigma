/**
 * Country flags as ASSETS, which is the only form of them that renders everywhere.
 *
 * The emoji flag is the thing this replaces. It is a pair of regional-indicator code
 * points, and the glyph for that pair exists only where the platform ships one: Windows
 * has never shipped country flags in Segoe UI Emoji, so `\u{1F1EA}\u{1F1F8}` renders as
 * the letters "ES" for the largest desktop platform there is - and a language picker built
 * out of them looks broken to those readers, with nothing in the code to explain why.
 * There is no font stack that fixes it, so the fix is not a font: it is an image.
 *
 * Three sets, all SVG, all served by enigma itself:
 *
 * - `rect` (4:3) and `square` (1:1) - the classic rectangular artwork.
 * - `circle` - round, which is what a flag next to an avatar or inside a chip wants.
 *
 * They are served from enigma's own tree rather than from anyone else's, because a
 * component whose default source is a third party is a component that breaks when that
 * third party moves, renames a branch, or goes away.
 *
 * Nothing here touches the DOM, so it renders on a server.
 */

export type FlagShape = "rect" | "square" | "circle";

/**
 * `svg` is what the sets are stored as, so it is what a remote source can serve. `png` and
 * `webp` exist for a LOCAL set (`enigma add flags --flags local --flag-formats webp`), which
 * rasterises what it downloads, and for a mirror of your own.
 */
export type FlagFormat = "svg" | "png" | "webp";

/**
 * Where the files come from.
 *
 * - `"cdn"` - enigma's own artwork, over a CDN. Nothing to install.
 * - `"local"` - files under `basePath` in your own public directory.
 * - any URL - a mirror of your own with the same layout
 *   (`<base>/<shape>/<code>.<format>`), which is exactly the tree the downloader writes.
 */
export type FlagSource = "cdn" | "local" | (string & {});

/** enigma's own artwork, over a CDN. Every source shares this layout. */
export const FLAG_CDN = "https://cdn.jsdelivr.net/gh/FJRG2007/enigma@main/assets/flags";

export interface FlagOptions {
    shape?: FlagShape;
    format?: FlagFormat;
    source?: FlagSource;
    /** Where a local set is served from. Default `/flags`. */
    basePath?: string;
    /** Rendered HEIGHT in px. The width follows the shape's ratio. Default 16. */
    size?: number;
    /**
     * Language the automatic name is written in. Left out, it follows the document's own
     * `lang`, which is what a translated page wants.
     */
    locale?: string;
}

export interface FlagConfig extends Required<Omit<FlagOptions, "size" | "locale">> {
    size: number;
    locale?: string;
}

const DEFAULTS: FlagConfig = {
    shape: "rect",
    format: "svg",
    source: "cdn",
    basePath: "/flags",
    size: 16
};

let config: FlagConfig = { ...DEFAULTS };

/**
 * Set the defaults for every flag on the page, once, at startup.
 *
 * This is what makes the CDN/local decision a one-line change rather than a prop on every
 * call site: `configureFlags({ source: "local" })` moves the whole app onto the files the
 * downloader wrote, and nothing else in the codebase mentions where a flag comes from.
 */
export function configureFlags(patch: Partial<FlagConfig>): FlagConfig {
    config = { ...config, ...patch };
    return config;
}

export function flagConfig(): FlagConfig {
    return config;
}

/** Test seam and a way back to the shipped defaults. */
export function resetFlagConfig(): FlagConfig {
    config = { ...DEFAULTS };
    return config;
}

/** Width / height of each shape. The circle set is square; only `rect` is 4:3. */
export const FLAG_RATIO: Record<FlagShape, number> = { rect: 4 / 3, square: 1, circle: 1 };

const EMOJI_FLAG = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
/**
 * A BCP 47 tag whose region is spelled the way the standard spells it: UPPERCASE. That
 * casing is the whole discriminator, and it has to be read before the value is lowercased -
 * `es-ES` is Spanish-in-Spain and means the flag `es`, while `es-ct` is a subdivision code
 * the sets publish (Catalonia) and means the file `es-ct`. Lowercasing first makes those
 * two the same string, and then one of them is always wrong.
 */
const LOCALE_TAG = /^([A-Za-z]{2,3})[-_]([A-Z]{2})$/;
/**
 * A SUBDIVISION or a named file, which is the only shape that cannot be checked against
 * anything: `gb-eng`, `au-nsw`, `es-ct`, `easter_island`. It must carry a separator - that
 * is what distinguishes a file name from an ordinary word, and without it `banana` was
 * accepted as a code and rendered as a 404.
 */
const FILE_CODE = /^[a-z]{2,}[-_][a-z0-9_-]+$/;
/** A plain country: exactly the shape `Intl.DisplayNames` can put a name to. */
const COUNTRY_CODE = /^[a-z]{2}$/;

/**
 * Accent-, case- and apostrophe-insensitive, so `espana`, `España` and `ESPAÑA` are one
 * string - and so are `Cote d'Ivoire` and `Côte d’Ivoire`.
 *
 * The apostrophe matters more than it looks: CLDR writes the typographic one (U+2019) and
 * every keyboard, database and API writes the straight one, so a lookup that kept them
 * apart failed on exactly the countries whose names contain one.
 */
function fold(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/['‘’ʼ`´]/g, "")
        .toLowerCase()
        // Three spellings of the same name, and all three are mechanical - CLDR writes
        // "St. Lucia" and "Trinidad & Tobago", while a form, a database and an API write
        // "Saint Lucia" and "Trinidad and Tobago". Both sides of the lookup go through this,
        // so it is a normalization rather than a table of alternative names.
        .replace(/&/g, " and ")
        .replace(/\bst\.?\s/g, "saint ")
        .replace(/^the\s+/, "")
        .replace(/[.,]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Every two-letter region the runtime can name, folded, mapped back to its code.
 *
 * Built by asking `Intl.DisplayNames` for all 676 letter pairs and keeping the ones it has a
 * name for - which is also how an unknown code is detected, since it echoes the input back.
 * The runtime already holds this data, translated and maintained; shipping a table of 250
 * country names would be a copy of it that goes stale.
 *
 * Memoized per locale and built only when something that is not a code arrives, so a page
 * that passes codes never pays for it.
 */
const nameIndexes = new Map<string, Map<string, string> | null>();

/**
 * The code a region is FILED under.
 *
 * `Intl.Locale` canonicalizes a deprecated or alias subtag, which is the difference between
 * a flag and a 404: `UK` is not the ISO code for the United Kingdom (`GB` is), `AN` became
 * `CW`, `SU` became `RU`. All three have a name, so a name lookup that skipped this step
 * resolved "United Kingdom" to `uk` and asked for a file that does not exist.
 */
function canonicalRegion(code: string): string {
    try {
        return new Intl.Locale(`und-${code}`).region?.toLowerCase() ?? code.toLowerCase();
    } catch {
        return code.toLowerCase();
    }
}

/**
 * The name the runtime uses for a region it does not know.
 *
 * `ZZ` IS that region by definition, so its name is the sentinel: any code the runtime
 * cannot place comes back either echoing the code (`QQ`) or carrying this exact string, and
 * both have to be refused. Comparing against `of("ZZ")` rather than the English words keeps
 * that true in every language.
 */
function unknownRegionName(names: Intl.DisplayNames): string | undefined {
    return names.of("ZZ");
}

function regionsByName(locale: string): Map<string, string> | null {
    const cached = nameIndexes.get(locale);
    if (cached !== undefined) return cached;

    let index: Map<string, string> | null = null;
    try {
        const names = new Intl.DisplayNames([locale], { type: "region" });
        const unknown = unknownRegionName(names);
        index = new Map();
        for (let first = 65; first <= 90; first++) {
            for (let second = 65; second <= 90; second++) {
                const code = String.fromCharCode(first, second);
                const name = names.of(code);
                if (!name || name === code || name === unknown) continue;
                const key = fold(name);
                // First wins, and the code is canonical, so an alias can neither overwrite
                // the real entry nor become one.
                if (!index.has(key)) index.set(key, canonicalRegion(code));
            }
        }
    } catch {
        index = null;   // No Intl, or no data for this locale.
    }
    nameIndexes.set(locale, index);
    return index;
}

/** Whether the runtime knows this two-letter code as a region at all. */
function isKnownRegion(code: string): boolean {
    try {
        const names = new Intl.DisplayNames(["en"], { type: "region" });
        const upper = code.toUpperCase();
        const name = names.of(upper);
        return Boolean(name) && name !== upper && name !== unknownRegionName(names);
    } catch {
        // Without Intl there is nothing to check against, and refusing every code would be
        // worse than passing one through: two letters is the shape of a flag file.
        return true;
    }
}

/**
 * Anything a codebase calls a country into the file name the sets use, or null.
 *
 * What it accepts: a code (`es`, `ES`), a locale tag (`en-GB`, `es_ES`), a subdivision or
 * named file (`gb-eng`, `au-nsw`, `easter_island`), the emoji flag you are replacing, and
 * the country's NAME - in English or in the page's own language, accents optional, so
 * `Spain`, `España` and `espana` all resolve. A name is what a database column or an API
 * payload usually holds, and requiring the caller to convert it first is how a flag ends up
 * not being rendered at all.
 *
 * Null rather than a guess, and that is the point of the strictness: `banana` used to pass
 * as a file code and render as a 404 with no alt text, which is worse than no flag. A
 * two-letter code is checked against the runtime's own region list, a bare word is resolved
 * as a name or refused, and only a separator-carrying file name is taken on trust, because
 * nothing can check those without shipping the whole directory listing.
 */
export function normalizeFlagCode(value: string | null | undefined, locale?: string): string | null {
    if (!value) return null;
    const raw = value.trim();
    if (!raw) return null;

    if (EMOJI_FLAG.test(raw)) {
        const letters = [...raw].map((char) => String.fromCharCode((char.codePointAt(0) ?? 0) - 0x1f1e6 + 97));
        return letters.join("");
    }

    const tag = LOCALE_TAG.exec(raw);
    if (tag) return tag[2].toLowerCase();

    const lower = raw.toLowerCase();
    // Canonical, so `uk` reaches the file the United Kingdom is actually filed under.
    if (COUNTRY_CODE.test(lower)) return isKnownRegion(lower) ? canonicalRegion(lower) : null;
    if (FILE_CODE.test(lower)) return lower;

    // A name, then, in this order: the locale you asked for, the page's own, English, and
    // finally the runtime's. English is always tried because it is what an API or a database
    // column holds even on a translated page; the runtime's is last so it can rescue a name
    // nothing else placed without ever overriding a match that was more specific.
    const folded = fold(raw);
    for (const candidate of [locale, documentLocale(), "en", runtimeLocale()]) {
        if (!candidate) continue;
        const found = regionsByName(candidate)?.get(folded);
        if (found) return found;
    }
    return null;
}

/**
 * The country's name, in the reader's language, or null.
 *
 * `Intl.DisplayNames` is the whole implementation: the names are in the runtime already,
 * translated, and maintained by whoever maintains the platform - so this ships no table of
 * 250 country names to go stale, and a Spanish page says "España" without being told.
 *
 * Null for anything it cannot name, and that is deliberate for SUBDIVISIONS: `gb-eng` is
 * England, and falling back to the region (`gb`, "United Kingdom") would put a confidently
 * wrong name on the flag. A name nobody can source is worse than no name.
 */
export function flagName(code: string | null | undefined, locale?: string): string | null {
    const normalized = normalizeFlagCode(code);
    if (!normalized || !COUNTRY_CODE.test(normalized)) return null;
    const region = normalized.toUpperCase();
    try {
        const names = new Intl.DisplayNames([locale ?? documentLocale() ?? "en"], { type: "region" });
        const name = names.of(region);
        // It echoes the input back when it has no name for the code.
        return !name || name === region ? null : name;
    } catch {
        return null;
    }
}

/** Whatever language this runtime is set to - the browser's, or the server's. */
function runtimeLocale(): string | undefined {
    try {
        return Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
        return undefined;
    }
}

/** The page's own language, which is what a translated page wants the name written in. */
function documentLocale(): string | undefined {
    if (typeof document === "undefined") return undefined;
    return document.documentElement.lang || undefined;
}

/** Everything a renderer needs, computed in one pass. Null when the code is unusable. */
export interface FlagView {
    /** The file name, e.g. `es`, `gb-eng`. */
    code: string;
    src: string;
    shape: FlagShape;
    format: FlagFormat;
    width: number;
    height: number;
    /** The automatic name, when there is one. */
    name: string | null;
}

/** One warning per process, not one per flag: a list of 200 would print 200 times. */
let warnedAboutFormat = false;

/**
 * The URL for one flag. Null when the code cannot be resolved.
 *
 * A raster format asked of the CDN falls back to SVG rather than producing a 404: the sets
 * are stored as SVG, so `format: "webp"` is only meaningful against a local set or a mirror.
 * It says so once, in development, instead of silently disagreeing with the call site.
 */
export function flagSrc(code: string | null | undefined, options: FlagOptions = {}): string | null {
    const settings = { ...config, ...options };
    const normalized = normalizeFlagCode(code);
    if (!normalized) return null;

    const remote = settings.source === "cdn";
    let format = settings.format;
    if (remote && format !== "svg") {
        if (!warnedAboutFormat && typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
            warnedAboutFormat = true;
            console.warn(`[enigma/flags] The flags are served as SVG, so "${format}" was served as SVG. Download a local set for raster formats: enigma add flags --flags local --flag-formats ${format}`);
        }
        format = "svg";
    }

    // One layout everywhere - `<base>/<shape>/<code>.<format>` - so a mirror is the same
    // string with a different host, and the downloader writes exactly what this reads.
    const base = remote ? FLAG_CDN : (settings.source === "local" ? settings.basePath : settings.source).replace(/\/+$/, "");
    return `${base}/${settings.shape}/${normalized}.${format}`;
}

/** `flagSrc` plus the resolved geometry and name, for a renderer that has to size the box. */
export function flagView(code: string | null | undefined, options: FlagOptions = {}): FlagView | null {
    const settings = { ...config, ...options };
    const normalized = normalizeFlagCode(code);
    const src = flagSrc(normalized, options);
    if (!normalized || !src) return null;
    const height = Math.max(1, Math.round(settings.size));
    return {
        code: normalized,
        src,
        shape: settings.shape,
        format: settings.source === "cdn" ? "svg" : settings.format,
        width: Math.round(height * FLAG_RATIO[settings.shape]),
        height,
        name: flagName(normalized, settings.locale)
    };
}

export interface FlagAttributeOptions extends FlagOptions {
    /** Your own accessible name, which wins over the automatic one. */
    label?: string;
    /**
     * Beside a country name that is already on screen, the flag is decoration and repeating
     * the name only makes a screen reader say it twice.
     */
    decorative?: boolean;
}

/**
 * Attributes for a plain `<img>`, for vanilla, Astro and any template language.
 *
 * The accessible name is AUTOMATIC: the country's own name, in the reader's language, from
 * `Intl.DisplayNames`. `label` replaces it and `decorative` drops it. Nothing is ever
 * invented - a subdivision the platform cannot name, or a runtime without `Intl`, renders
 * as decoration rather than putting a bare "ES" into a screen reader.
 *
 * The name goes on `title` as well as `alt`, because those two do different jobs and only
 * one of them is visible: `alt` is what a screen reader reads and what shows when the image
 * fails, while a POINTER tooltip comes from `title` and from nothing else. A flag with a
 * name nobody can see on hover is the common complaint, and it is not an accessibility
 * nicety - the flag is often the only thing in a cell. A decorative flag gets neither.
 */
export function flagAttributes(code: string | null | undefined, options: FlagAttributeOptions = {}): Record<string, string | number> | null {
    const view = flagView(code, options);
    if (!view) return null;
    const label = options.decorative ? "" : options.label?.trim() || view.name || "";
    return {
        src: view.src,
        alt: label,
        width: view.width,
        height: view.height,
        loading: "lazy",
        decoding: "async",
        "data-enigma-flag": "",
        "data-flag-code": view.code,
        "data-flag-shape": view.shape,
        ...(label ? { title: label } : { "aria-hidden": "true" })
    };
}
