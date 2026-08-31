"use client";

import type { SearchMatch } from "@/core/search";
import { createContext, useContext } from "react";
import type { RecentEntry } from "@/core/palette";

/** One line in the palette, whatever it came from. */
export interface PaletteRow<Item> {
    /** Stable within a render. Used for React keys and for `aria-activedescendant`. */
    id: string;
    /** Which group it appears under. */
    group: string;
    /** `item` for a result, `recent` for a memory, `action` for a row the app declared. */
    kind: "item" | "recent" | "action";
    item?: Item;
    recent?: RecentEntry;
    /** Set for a result that came from the engine, so a renderer can show the score. */
    match?: SearchMatch<Item>;
    /** What running this row does. The palette closes afterwards unless this returns false. */
    onSelect?: () => void | boolean;
    label: string;
    description?: string;
}

export interface PaletteContextValue<Item = unknown> {
    open: boolean;
    setOpen: (open: boolean) => void;
    query: string;
    setQuery: (query: string) => void;
    rows: PaletteRow<Item>[];
    active: number;
    setActive: (index: number) => void;
    /** Run a row: its own action, or the palette's `onSelect`, then remember it. */
    select: (row: PaletteRow<Item> | undefined) => void;
    /** Wipe the remembered searches. */
    clearRecents: () => void;
    forgetRecent: (entry: RecentEntry) => void;
    /** True while the engine is loading or an async source is in flight. */
    busy: boolean;
    /** ids the parts need to point at each other. */
    ids: { field: string; list: string; title: string; };
    /** `Ctrl K` or `⌘ K`, whichever this platform uses. */
    shortcutLabel: string;
    triggerRef: { current: HTMLElement | null; };
    fieldRef: { current: HTMLInputElement | null; };
    rowId: (row: PaletteRow<Item>) => string;
}

/**
 * Null rather than a default value: a part rendered outside its Root is a mistake with a
 * clear fix, and a silent default would leave it half-working - a field that types into
 * nothing, an item that never highlights.
 */
export const PaletteContext = createContext<PaletteContextValue<never> | null>(null);

export function usePaletteContext<Item = unknown>(part: string): PaletteContextValue<Item> {
    const value = useContext(PaletteContext);
    if (!value) throw new Error(`<${part}> must be rendered inside <SearchPalette.Root>.`);
    return value as unknown as PaletteContextValue<Item>;
}
