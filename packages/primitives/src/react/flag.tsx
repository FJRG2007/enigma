"use client";

import { type ImgHTMLAttributes, type ReactNode } from "react";
import { flagView, type FlagOptions, type FlagShape, type FlagFormat, type FlagSource } from "@/core/flags";

export interface FlagProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "width" | "height"> {
    /** `es`, `ES`, `en-GB`, `gb-eng`, or the emoji flag you are replacing. */
    code: string | null | undefined;
    /**
     * The accessible name. Leave it out and the flag is decorative, which is what it is
     * beside a country name - the reader hears the name once instead of twice.
     */
    label?: string;
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
export function Flag({ code, label, shape, format, source, basePath, size, fallback = null, ...rest }: FlagProps): ReactNode {
    const options: FlagOptions = { shape, format, source, basePath, size };
    // An explicit `undefined` prop must not beat the configured default, so the unset ones
    // are dropped rather than spread over the config.
    for (const key of Object.keys(options) as (keyof FlagOptions)[]) {
        if (options[key] === undefined) delete options[key];
    }

    const view = flagView(code, options);
    if (!view) return fallback;

    const name = label?.trim();
    return (
        <img
            src={view.src}
            alt={name ?? ""}
            width={view.width}
            height={view.height}
            loading="lazy"
            decoding="async"
            aria-hidden={name ? undefined : true}
            data-enigma-flag=""
            data-flag-code={view.code}
            data-flag-shape={view.shape}
            {...rest}
        />
    );
}
