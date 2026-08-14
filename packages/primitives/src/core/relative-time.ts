/**
 * Relative time: "3 hours ago", and everything that has to be right around it.
 *
 * The rendering itself is `<relative-time>` (@github/relative-time-element), which already
 * owns the hard parts - Intl.RelativeTimeFormat per locale, and re-rendering on a schedule
 * that gets slower as the date gets older. What is here is the part every wrapper
 * re-implements and usually gets wrong: parsing a timestamp that does not declare its zone,
 * knowing when the date has aged past the relative threshold, and producing an absolute
 * label to show while the element is still loading, or forever if scripting is off.
 *
 * Nothing in this file touches the DOM, so it renders on a server.
 */

/** How the element should phrase it. `auto` is relative until the threshold, then a date. */
export type RelativeTimeFormat = "auto" | "relative" | "duration" | "datetime" | "micro" | "elapsed";
export type RelativeTimeTense = "auto" | "past" | "future";
export type RelativeTimePrecision = "year" | "month" | "day" | "hour" | "minute" | "second";
export type RelativeTimeStyle = "long" | "short" | "narrow";
export type NumericStyle = "numeric" | "2-digit";

export interface RelativeTimeOptions {
    format?: RelativeTimeFormat;
    tense?: RelativeTimeTense;
    precision?: RelativeTimePrecision;
    /** ISO 8601 duration. Past this age `auto` stops being relative. Default `P30D`. */
    threshold?: string;
    /** Word before an absolute date, e.g. "on 5 May". Empty string removes it. */
    prefix?: string;
    formatStyle?: RelativeTimeStyle;
    /**
     * BCP 47 tag. Left undefined the element reads the closest `lang` in the document,
     * which is what a translated page wants - hardcoding one is how a Spanish page ends
     * up saying "3 hours ago".
     */
    locale?: string;
    /** IANA zone for the absolute rendering. Undefined means the reader's own. */
    timeZone?: string;
    second?: NumericStyle;
    minute?: NumericStyle;
    hour?: NumericStyle;
    weekday?: RelativeTimeStyle;
    day?: NumericStyle;
    month?: NumericStyle | "short" | "long" | "narrow";
    year?: NumericStyle;
    timeZoneName?: "long" | "short" | "shortOffset" | "longOffset" | "shortGeneric" | "longGeneric";
    /** Drop the exact timestamp the element otherwise puts in `title`. */
    noTitle?: boolean;
    /**
     * Once the date is older than `threshold`, render it as digits (05/05/2026) instead of
     * a prefixed month name. The cutoff is the threshold itself, not a guess at it.
     */
    numericBeyondThreshold?: boolean;
}

/** Everything derived from a date, in one pass, for whichever adapter is rendering it. */
export interface RelativeTimeView {
    /** Null when the input could not be parsed - nothing else here is meaningful then. */
    date: Date | null;
    /** `datetime` attribute value: always UTC, always ISO. */
    iso: string;
    /** Absolute text. Shown until the element upgrades, and forever without scripting. */
    label: string;
    /** Full timestamp for `title` / `aria-label`. */
    exact: string;
    /** The date is older (or further ahead) than `threshold`. */
    beyondThreshold: boolean;
    /** Render `label` in a plain `<time>` and skip the element entirely. */
    absoluteOnly: boolean;
}

const ZONED = /([zZ]|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_TIME = /\d{2}:\d{2}/;
const DURATION = /^([+-])?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** Calendar-free approximations, matching what the element uses to compare an age. */
const WEEK = 7 * DAY, MONTH = 30 * DAY, YEAR = 365 * DAY;

/**
 * A timestamp with no zone is UTC.
 *
 * This is the single most common defect in a date column: `2026-08-13 22:41:00` comes back
 * from the database with no offset, `new Date()` reads it as LOCAL time, and every reader
 * east or west of the server sees a time that is hours out - silently, because the wrong
 * time is still a valid one.
 *
 * A date with no clock is left exactly as it is. The spec already reads a bare `YYYY-MM-DD`
 * as UTC, so there is nothing to add - and `YYYY-MM-DDZ` is not in the spec's grammar at
 * all, which drops it into each engine's own legacy parser. That is a portability coin
 * flip on a value that was already correct.
 */
export function ensureZone(text: string): string {
    const trimmed = text.trim();
    if (!trimmed || DATE_ONLY.test(trimmed) || ZONED.test(trimmed)) return trimmed;
    const iso = trimmed.replace(" ", "T");
    return HAS_TIME.test(iso) ? `${iso}Z` : iso;
}

/** Parse anything a date column or an API hands over. Null rather than an Invalid Date. */
export function normalizeDate(value: string | number | Date | null | undefined): Date | null {
    if (value == null) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    // A bare number is epoch milliseconds; seconds would be 1970 and obviously wrong.
    if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
    const date = new Date(ensureZone(value));
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * ISO 8601 duration to milliseconds, for comparing an age against `threshold`.
 *
 * Years and months are approximated the way the element approximates them, because the
 * threshold is a rough "old enough to stop counting", not an anniversary.
 */
export function parseDuration(value: string): number {
    const match = DURATION.exec(value.trim());
    if (!match) return 0;
    const [, sign, years, months, weeks, days, hours, minutes, seconds] = match;
    const n = (part: string | undefined): number => (part ? Number(part) : 0);
    const total =
        n(years) * YEAR + n(months) * MONTH + n(weeks) * WEEK + n(days) * DAY +
        n(hours) * HOUR + n(minutes) * MINUTE + n(seconds) * SECOND;
    return sign === "-" ? -total : total;
}

function dateTimeOptions(options: RelativeTimeOptions): Intl.DateTimeFormatOptions {
    const { second, minute, hour, weekday, day, month, year, timeZone, timeZoneName } = options;
    const parts: Intl.DateTimeFormatOptions = { timeZone, timeZoneName, second, minute, hour, weekday, day, month, year };
    // An explicit `undefined` is not the same as an absent key to Intl in every engine.
    for (const key of Object.keys(parts) as (keyof Intl.DateTimeFormatOptions)[]) {
        if (parts[key] === undefined) delete parts[key];
    }
    return parts;
}

function format(date: Date, locale: string | undefined, options: Intl.DateTimeFormatOptions): string {
    try {
        return new Intl.DateTimeFormat(locale, options).format(date);
    } catch {
        // An invalid locale tag or an unsupported time zone throws rather than degrading.
        return date.toISOString();
    }
}

/**
 * Everything an adapter needs to render one date.
 *
 * `now` is a parameter so a test can pin it, and so a server render can pass the same
 * instant it used elsewhere on the page.
 */
export function relativeTimeView(value: string | number | Date | null | undefined, options: RelativeTimeOptions = {}, now: Date = new Date()): RelativeTimeView {
    const date = normalizeDate(value);
    if (!date) return { date: null, iso: "", label: "", exact: "", beyondThreshold: false, absoluteOnly: false };

    const { locale, threshold = "P30D", prefix = "on", numericBeyondThreshold = false } = options;
    const age = Math.abs(date.getTime() - now.getTime());
    const beyondThreshold = age > parseDuration(threshold);

    // Beyond the threshold the element itself would render a date, so rendering it here
    // costs nothing and skips a custom element that has no work left to do.
    const absoluteOnly = numericBeyondThreshold && beyondThreshold;
    const parts = absoluteOnly
        ? { day: "numeric" as const, month: "numeric" as const, year: "numeric" as const, timeZone: options.timeZone }
        : { day: "numeric" as const, month: "short" as const, year: "numeric" as const, ...dateTimeOptions(options) };

    const label = format(date, locale, parts);
    return {
        date,
        iso: date.toISOString(),
        label: !absoluteOnly && prefix ? `${prefix} ${label}` : label,
        exact: format(date, locale, { dateStyle: "full", timeStyle: "long", timeZone: options.timeZone }),
        beyondThreshold,
        absoluteOnly
    };
}

/**
 * The element's attributes, kebab-cased, with anything undefined left out.
 *
 * Written as attributes rather than properties because that is the half of a custom
 * element's API that works before it is defined - the markup is already correct when the
 * definition arrives late, or never.
 */
export function relativeTimeAttributes(view: RelativeTimeView, options: RelativeTimeOptions = {}): Record<string, string> {
    const attributes: Record<string, string | undefined> = {
        datetime: view.iso,
        format: options.format,
        tense: options.tense,
        precision: options.precision,
        threshold: options.threshold,
        prefix: options.prefix,
        "format-style": options.formatStyle,
        second: options.second,
        minute: options.minute,
        hour: options.hour,
        weekday: options.weekday,
        day: options.day,
        month: options.month,
        year: options.year,
        lang: options.locale,
        "time-zone": options.timeZone,
        "time-zone-name": options.timeZoneName,
        // Boolean attributes are read by presence: "false" would still be true.
        "no-title": options.noTitle ? "" : undefined
    };

    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) out[key] = value;
    }
    return out;
}
