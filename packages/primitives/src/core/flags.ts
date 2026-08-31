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
 * Two upstream sets, both SVG, both installable or served from a CDN:
 *
 * - `rect` / `square` - lipis/flag-icons (`flags/4x3`, `flags/1x1`), the classic
 *   rectangular set, 271 flags plus subdivisions.
 * - `circle` - HatScripts/circle-flags (`flags/*.svg` on its gh-pages branch), 445 round
 *   flags, which is what a flag next to an avatar or inside a chip usually wants.
 *
 * Nothing here touches the DOM, so it renders on a server.
 */

export type FlagShape = "rect" | "square" | "circle";

/**
 * `svg` is the only format the two upstreams publish, so it is the only one a CDN can
 * serve. `png` and `webp` exist for a LOCAL set (`enigma add flags --flags local
 * --flag-formats webp`), which rasterises what it downloads, and for a mirror of your own.
 */
export type FlagFormat = "svg" | "png" | "webp";

/**
 * Where the files come from.
 *
 * - `"cdn"` - jsDelivr, straight from the two upstream projects. Nothing to install.
 * - `"local"` - files under `basePath` in your own public directory.
 * - any URL - a mirror of your own with the same layout as the local one
 *   (`<base>/<shape>/<code>.<format>`), which is exactly the tree the downloader writes.
 */
export type FlagSource = "cdn" | "local" | (string & {});

/** Pinned so an upgrade upstream is a decision here, never a surprise in production. */
export const FLAG_ICONS_VERSION = "7.5.0";
/** circle-flags publishes from a branch, not a tag; gh-pages is its default branch. */
export const CIRCLE_FLAGS_REF = "gh-pages";

export interface FlagOptions {
    shape?: FlagShape;
    format?: FlagFormat;
    source?: FlagSource;
    /** Where a local set is served from. Default `/flags`. */
    basePath?: string;
    /** Rendered HEIGHT in px. The width follows the shape's ratio. Default 16. */
    size?: number;
}

export interface FlagConfig extends Required<Omit<FlagOptions, "size">> {
    size: number;
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
 * both sets publish (Catalonia) and means the file `es-ct`. Lowercasing first makes those
 * two the same string, and then one of them is always wrong.
 */
const LOCALE_TAG = /^([A-Za-z]{2,3})[-_]([A-Z]{2})$/;
/** What the two sets actually name their files: `es`, `gb-eng`, `au-nsw`, `easter_island`. */
const FILE_CODE = /^[a-z]{2,}(?:[-_][a-z0-9]+)*$/;

/**
 * Anything a codebase calls a country into the file name the sets use, or null.
 *
 * Null rather than a guess: a code this cannot resolve would otherwise become a 404 image
 * with no alt text, and a broken flag beside a country name is worse than no flag at all.
 * An emoji flag is accepted and converted, so migrating an existing picker is a rename of
 * the component and nothing else.
 */
export function normalizeFlagCode(value: string | null | undefined): string | null {
    if (!value) return null;
    const raw = value.trim();
    if (!raw) return null;

    if (EMOJI_FLAG.test(raw)) {
        const letters = [...raw].map((char) => String.fromCharCode((char.codePointAt(0) ?? 0) - 0x1f1e6 + 97));
        return letters.join("");
    }

    const locale = LOCALE_TAG.exec(raw);
    if (locale) return locale[2].toLowerCase();

    const code = raw.toLowerCase();
    return FILE_CODE.test(code) ? code : null;
}

/** Everything a renderer needs, computed in one pass. Null when the code is unusable. */
export interface FlagView {
    /** The upstream file name, e.g. `es`, `gb-eng`. */
    code: string;
    src: string;
    shape: FlagShape;
    format: FlagFormat;
    width: number;
    height: number;
}

function cdnUrl(code: string, shape: FlagShape): string {
    if (shape === "circle") return `https://cdn.jsdelivr.net/gh/HatScripts/circle-flags@${CIRCLE_FLAGS_REF}/flags/${code}.svg`;
    const size = shape === "square" ? "1x1" : "4x3";
    return `https://cdn.jsdelivr.net/npm/flag-icons@${FLAG_ICONS_VERSION}/flags/${size}/${code}.svg`;
}

/** One warning per process, not one per flag: a list of 200 would print 200 times. */
let warnedAboutFormat = false;

/**
 * The URL for one flag. Null when the code cannot be resolved.
 *
 * A raster format asked of the CDN falls back to SVG rather than producing a 404: neither
 * upstream publishes anything but SVG, so `format: "webp"` is only meaningful against a
 * local set or a mirror. It says so once, in development, instead of silently disagreeing
 * with what the call site asked for.
 */
export function flagSrc(code: string | null | undefined, options: FlagOptions = {}): string | null {
    const settings = { ...config, ...options };
    const normalized = normalizeFlagCode(code);
    if (!normalized) return null;

    const remoteCdn = settings.source === "cdn";
    let format = settings.format;
    if (remoteCdn && format !== "svg") {
        if (!warnedAboutFormat && typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
            warnedAboutFormat = true;
            console.warn(`[enigma/flags] The flag CDNs publish SVG only, so "${format}" was served as SVG. Download a local set for raster formats: enigma add flags --flags local --flag-formats ${format}`);
        }
        format = "svg";
    }
    if (remoteCdn) return cdnUrl(normalized, settings.shape);

    const base = (settings.source === "local" ? settings.basePath : settings.source).replace(/\/+$/, "");
    return `${base}/${settings.shape}/${normalized}.${format}`;
}

/** `flagSrc` plus the resolved geometry, for a renderer that has to size the box. */
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
        height
    };
}

/**
 * Attributes for a plain `<img>`, for vanilla, Astro and any template language.
 *
 * `label` is the accessible name and there is no default for it: a flag with no label is
 * DECORATIVE (empty alt, `aria-hidden`), which is correct beside a country name and is the
 * common case. Inventing one from the code would put "ES" or "es" into a screen reader,
 * and a country name guessed in the reader's wrong language is worse than silence.
 */
export function flagAttributes(code: string | null | undefined, options: FlagOptions & { label?: string; } = {}): Record<string, string | number> | null {
    const view = flagView(code, options);
    if (!view) return null;
    const label = options.label?.trim();
    return {
        src: view.src,
        alt: label ?? "",
        width: view.width,
        height: view.height,
        loading: "lazy",
        decoding: "async",
        "data-enigma-flag": "",
        "data-flag-code": view.code,
        "data-flag-shape": view.shape,
        ...(label ? {} : { "aria-hidden": "true" })
    };
}
