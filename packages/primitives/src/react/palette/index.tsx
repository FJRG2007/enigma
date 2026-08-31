"use client";

import type { ReactNode } from "react";
import type { PaletteRow } from "@/react/palette/context";
import {
    PaletteRoot, PaletteTrigger, PaletteContent, PaletteField, PaletteList, PaletteItem, PaletteFooter,
    type PaletteRootProps, type PaletteListProps
} from "@/react/palette/root";

export interface SearchPaletteProps<Item> extends PaletteRootProps<Item> {
    placeholder?: string;
    /** The trigger's own content. Pass null for a palette that only opens on the shortcut. */
    trigger?: ReactNode | null;
    /** Render one row, same signature as `SearchPalette.List`. */
    renderItem?: PaletteListProps<Item>["children"];
    empty?: ReactNode;
    footer?: ReactNode;
}

/**
 * The palette, assembled.
 *
 * ```tsx
 * <SearchPalette items={docs} keys={["title", "body"]} onSelect={(doc) => go(doc.href)} />
 * ```
 *
 * Everything it renders is a part you can render yourself instead - see `SearchPalette.Root`
 * for the anatomy. This is the composition that covers the common case, not a different
 * component: it is those parts, in the order they belong in.
 */
export function SearchPalette<Item>({
    placeholder = "Search",
    trigger,
    renderItem,
    empty,
    footer,
    children,
    ...root
}: SearchPaletteProps<Item>): ReactNode {
    return (
        <PaletteRoot<Item> {...root}>
            {trigger !== null && <PaletteTrigger>{trigger}</PaletteTrigger>}
            <PaletteContent>
                <PaletteField placeholder={placeholder} aria-label={placeholder} />
                <PaletteList<Item> empty={empty}>{renderItem}</PaletteList>
                {footer === null ? null : <PaletteFooter>{footer}</PaletteFooter>}
            </PaletteContent>
            {children}
        </PaletteRoot>
    );
}

SearchPalette.Root = PaletteRoot;
SearchPalette.Trigger = PaletteTrigger;
SearchPalette.Content = PaletteContent;
SearchPalette.Field = PaletteField;
SearchPalette.List = PaletteList;
SearchPalette.Item = PaletteItem;
SearchPalette.Footer = PaletteFooter;

export {
    PaletteRoot, PaletteTrigger, PaletteContent, PaletteField, PaletteList, PaletteItem, PaletteFooter,
    type PaletteRootProps, type PaletteListProps, type PaletteSection
} from "@/react/palette/root";
export { usePaletteContext, type PaletteRow, type PaletteContextValue } from "@/react/palette/context";
export type { PaletteRow as SearchPaletteRow };
