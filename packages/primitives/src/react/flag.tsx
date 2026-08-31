"use client";

import { type ImgHTMLAttributes, type ReactNode } from "react";
import { flagView, type FlagOptions, type FlagShape, type FlagFormat, type FlagSource } from "@/core/flags";

export interface FlagProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "width" | "height"> {
    /** `es`, `ES`, `en-GB`, `gb-eng`, or the emoji flag you are replacing. */
    code: string | null | undefined;
    /**
     * Your own accessible name. Left out, the country's own name is used, in the reader's
     * language - so a flag standing on its own is never a silent image.
     */
    label?: string;
    /**
     * Beside a country name that is already on screen the flag is decoration, and repeating
     * the name only makes a screen reader say it twice.
     */
    decorative?: boolean;
    /** Language the automatic name is written in. Follows the document's `lang` otherwise. */
    locale?: string;
    shape?: FlagShape;
    format?: FlagFormat;
    source?: FlagSource;
    basePath?: string;
    /** Rendered height in px. The width follows the shape. Default 16. */
    size?: number;
    /** Rendered when the code resolves to nothing. Nothing, by default. */
    fallback?: ReactNode;
}

/**
 * `<Flag code="es" />` - a country flag as an image, at the size you asked for, from the
 * source the app configured once.
 *
 * The defaults come from `configureFlags`, so moving the whole application from the CDN to
 * a downloaded set is one line at startup and no change at any call site.
 */
export function Flag({ code, label, decorative = false, locale, shape, format, source, basePath, size, fallback = null, ...rest }: FlagProps): ReactNode {
    const options: FlagOptions = { shape, format, source, basePath, size, locale };
    // An explicit `undefined` prop must not beat the configured default, so the unset ones
    // are dropped rather than spread over the config.
    for (const key of Object.keys(options) as (keyof FlagOptions)[]) {
        if (options[key] === undefined) delete options[key];
    }

    const view = flagView(code, options);
    if (!view) return fallback;

    // Automatic unless told otherwise: the country's own name, in the reader's language.
    const name = decorative ? "" : label?.trim() || view.name || "";
    return (
        <img
            src={view.src}
            alt={name}
            // `alt` is read; `title` is what a pointer shows. Only one of them is visible,
            // and a flag whose name never appears on hover is the thing people report.
            title={name || undefined}
            width={view.width}
            height={view.height}
            loading="lazy"
            decoding="async"
            aria-hidden={name ? undefined : true}
            // The name comes from the reader's own runtime, so a server render and its
            // hydration can legitimately disagree on the language it is written in. Same
            // escape hatch, and same reason, as the relative timestamp.
            suppressHydrationWarning
            data-enigma-flag=""
            data-flag-code={view.code}
            data-flag-shape={view.shape}
            {...rest}
        />
    );
}
