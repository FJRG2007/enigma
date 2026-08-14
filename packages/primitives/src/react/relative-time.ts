"use client";

import { createElement, useEffect, type HTMLAttributes, type ReactNode } from "react";
import { relativeTimeView, relativeTimeAttributes, type RelativeTimeOptions } from "@/core/relative-time";

/**
 * `<RelativeTime date={...} />` - a timestamp that reads as "3 hours ago" and keeps itself
 * current, rendered by @github/relative-time-element.
 *
 * Two things this does that a bare element does not:
 *
 * The absolute date is rendered as the element's child, so a server render, a page whose
 * JavaScript has not arrived yet, and a reader with scripting off all see a real date
 * instead of an empty box. The element replaces it the moment it upgrades.
 *
 * The element is imported on the client only. It is a custom element, so its class extends
 * HTMLElement at module scope - importing it where there is no DOM throws before any
 * component of yours runs. A failed import is not fatal either: the absolute date is
 * already in the markup.
 */

/** One import per page, however many timestamps are on it. */
let loading: Promise<unknown> | null = null;

function loadElement(): void {
    if (loading || typeof window === "undefined") return;
    loading = import("@github/relative-time-element").catch(() => {
        // Not installed, or blocked. The absolute label stands in, so there is nothing to
        // report to the reader and nothing to retry.
        return null;
    });
}

export interface RelativeTimeProps extends RelativeTimeOptions, Omit<HTMLAttributes<HTMLElement>, "prefix" | "children"> {
    /** ISO string, epoch milliseconds, or a Date. A string with no zone is read as UTC. */
    date: string | number | Date | null | undefined;
    /** Rendered when the date cannot be parsed. Nothing, by default. */
    fallback?: ReactNode;
    /** Title Case The Whole Phrase. Rarely what you want; `capitalizeFirst` usually is. */
    capitalize?: boolean;
    /** Uppercase the first letter, so a standalone "yesterday" reads as "Yesterday". */
    capitalizeFirst?: boolean;
    /**
     * Pin the instant the age is measured from. Pass the request's timestamp to make a
     * server render and its hydration agree exactly.
     */
    now?: Date;
}

export function RelativeTime({
    date,
    fallback = null,
    capitalize = false,
    capitalizeFirst = true,
    now,
    format,
    tense,
    precision,
    threshold,
    prefix,
    formatStyle,
    locale,
    timeZone,
    second,
    minute,
    hour,
    weekday,
    day,
    month,
    year,
    timeZoneName,
    noTitle,
    numericBeyondThreshold,
    ...rest
}: RelativeTimeProps): ReactNode {
    useEffect(loadElement, []);

    const options: RelativeTimeOptions = {
        format, tense, precision, threshold, prefix, formatStyle, locale, timeZone,
        second, minute, hour, weekday, day, month, year, timeZoneName, noTitle, numericBeyondThreshold
    };
    const view = relativeTimeView(date, options, now);
    if (!view.date) return fallback;

    const marks = {
        "data-relative-time-capitalize": capitalize ? "true" : undefined,
        "data-relative-time-capitalize-first-letter": capitalizeFirst ? "true" : undefined,
        // The text differs between the server's instant and the browser's, which is the
        // one hydration difference React has an escape hatch for rather than a bug.
        suppressHydrationWarning: true
    };

    // Past the threshold there is no relative phrasing left to produce, so a plain <time>
    // renders the same words without waiting for a custom element to define itself.
    if (view.absoluteOnly) {
        return createElement("time", { dateTime: view.iso, title: noTitle ? undefined : view.exact, ...marks, ...rest }, view.label);
    }

    // createElement rather than JSX: `<relative-time>` is not a known intrinsic element, and
    // declaring it means augmenting React's JSX namespace from inside a published package -
    // which collides with any consumer that declared it too, differently.
    return createElement("relative-time", { ...relativeTimeAttributes(view, options), ...marks, ...rest }, view.label);
}
