"use client";

import { createContext, useContext } from "react";
import type { ReactNode, RefObject } from "react";
import type { ContextMenuAction, ContextMenuEntry, ContextMenuInstance, ContextMenuPoint, ContextMenuState } from "@/core/context-menu";

/**
 * One row, as React draws it. The core carries `icon` as `unknown` because it cannot know
 * what a node is; here it is one.
 */
export interface ContextMenuItem extends Omit<ContextMenuAction, "icon" | "items"> {
    icon?: ReactNode;
    items?: readonly ContextMenuNode[];
}

/** Anything that can appear in a menu, with React's icon type. */
export type ContextMenuNode = ContextMenuItem | Exclude<ContextMenuEntry, ContextMenuAction>;

export interface ContextMenuContextValue {
    instance: ContextMenuInstance;
    state: ContextMenuState;
    /** Open at a point. False when there was nothing to show, so the press is left alone. */
    open: (point: ContextMenuPoint) => boolean;
    close: () => void;
    /** ids the parts need to point at each other. */
    ids: { trigger: string; };
    panelId: (level: number) => string;
    itemId: (level: number, index: number) => string;
    triggerRef: RefObject<HTMLElement | null>;
    /** Which panel the keyboard is in. Always the deepest open one. */
    onMenuKeyDown: (event: React.KeyboardEvent) => void;
    /** How long the pointer must rest on a row before its submenu opens, and before one closes. */
    delays: { open: number; close: number; };
    /** Draw a row instead of the default icon / label / shortcut. */
    renderItem?: (item: ContextMenuItem, level: number, index: number) => ReactNode;
    /** Shown while a fetched submenu has not answered. */
    loadingLabel: ReactNode;
    /** Shown when a filter matched nothing, or a fetched submenu came back with nothing. */
    emptyLabel: ReactNode;
}

/**
 * Null rather than a default: a part rendered outside its Root is a mistake with an obvious
 * fix, and a silent default would leave it half-working - a trigger that opens nothing, a row
 * that invokes into the void.
 */
export const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

export function useContextMenuContext(part: string): ContextMenuContextValue {
    const value = useContext(ContextMenuContext);
    if (!value) throw new Error(`<${part}> must be rendered inside <ContextMenu.Root>.`);
    return value;
}
