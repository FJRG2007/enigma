/**
 * The RawTokens accumulator every extractor fills, and the merge that folds several of
 * them into one before normalization. Merging dedupes by value so a color found by the
 * config reader and again in a stylesheet counts once with both frequencies.
 */

import { isValidHex } from "./color";
import { preferredName } from "./roles";
import type { RawTokens, TokenSource } from "./types";

export function emptyRawTokens(): RawTokens {
    return {
        colors: [], fonts: [], spacingValues: [], shadows: [], cssVariables: [], breakpoints: [],
        borderRadii: [], gradients: [], fontVarMap: {}, animations: [], darkModeVars: [],
        zIndexValues: [], containerMaxWidth: null, fontSources: [], pageSections: [],
        transitionDurations: [], transitionEasings: [],
    };
}

/** Count one occurrence of `hex`, naming it when this is the first name seen for it. */
export function addColor(tokens: RawTokens, hex: string, source: TokenSource, name?: string): void {
    if (!hex || !isValidHex(hex)) return;
    const existing = tokens.colors.find((c) => c.value === hex);
    if (existing) {
        existing.frequency++;
        existing.name = preferredName(existing.name, name);
    } else {
        tokens.colors.push({ value: hex, frequency: 1, source, name });
    }
}

function pushUnique<T>(into: T[], items: T[] | undefined, same: (a: T, b: T) => boolean): void {
    for (const item of items ?? []) if (!into.some((x) => same(x, item))) into.push({ ...item as object } as T);
}

function pushUniqueValue<T>(into: T[], items: T[] | undefined): void {
    for (const item of items ?? []) if (!into.includes(item)) into.push(item);
}

/**
 * Fold `sources` into one RawTokens, earlier sources winning on conflicts (the first
 * container width, the first breakpoint at a value, the first name for a color).
 */
export function mergeRawTokens(sources: RawTokens[]): RawTokens {
    const merged = emptyRawTokens();
    for (const src of sources) {
        for (const color of src.colors) {
            const existing = merged.colors.find((c) => c.value === color.value);
            if (existing) {
                existing.frequency += color.frequency;
                existing.name = preferredName(existing.name, color.name);
            } else {
                merged.colors.push({ ...color });
            }
        }
        for (const font of src.fonts) {
            if (font.family && !merged.fonts.some((f) => f.family === font.family && f.size === font.size)) merged.fonts.push({ ...font });
        }
        merged.spacingValues.push(...src.spacingValues);
        pushUnique(merged.shadows, src.shadows, (a, b) => a.value === b.value);
        pushUnique(merged.cssVariables, src.cssVariables, (a, b) => a.name === b.name);
        pushUnique(merged.breakpoints, src.breakpoints, (a, b) => a.value === b.value);
        pushUniqueValue(merged.borderRadii, src.borderRadii);
        merged.gradients.push(...(src.gradients ?? []));
        Object.assign(merged.fontVarMap, src.fontVarMap ?? {});
        merged.animations.push(...(src.animations ?? []));
        pushUnique(merged.darkModeVars, src.darkModeVars, (a, b) => a.variable === b.variable);
        pushUniqueValue(merged.zIndexValues, src.zIndexValues);
        if (src.containerMaxWidth && !merged.containerMaxWidth) merged.containerMaxWidth = src.containerMaxWidth;
        pushUnique(merged.fontSources, src.fontSources, (a, b) => a.family === b.family && a.src === b.src);
        pushUnique(merged.pageSections, src.pageSections, (a, b) => a.type === b.type);
        pushUniqueValue(merged.transitionDurations, src.transitionDurations);
        pushUniqueValue(merged.transitionEasings, src.transitionEasings);
        merged.favicon = merged.favicon || src.favicon || null;
        merged.siteTitle = merged.siteTitle || src.siteTitle || null;
        if (!merged.renderedType?.length && src.renderedType?.length) merged.renderedType = src.renderedType;
    }
    return merged;
}
