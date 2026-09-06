"use client";

import { useEffect, type ReactNode } from "react";
import type { ContextMenuPoint } from "@/core/context-menu";
import { ContextMenu, useContextMenuContext, type ContextMenuItem, type ContextMenuNode } from "@/react/context-menu";

/**
 * The menu a right-click on the player opens, the way YouTube's does.
 *
 * It IS the context menu component. Writing a second popup here would mean a second keyboard
 * model, a second set of roles, a second thing to fix - and the `fe-context-menu-hand-rolled`
 * guardrail exists to say so. The rows come from the player, because only the player knows
 * what is playing.
 *
 * Its own chunk, mounted the first time a pointer reaches the player rather than on render: a
 * page of embedded videos nobody right-clicks downloads none of it, and a pointer arrives long
 * before the second button does. A press that beats the chunk falls through to the browser's
 * own menu, which is a better answer than swallowing it.
 *
 * There is no trigger part. The player opens the menu itself, at the point of the press, so
 * what this renders into the tree is nothing at all - the panel is portalled.
 */

export type OpenVideoMenu = (point: ContextMenuPoint) => boolean;

export interface VideoMenuProps {
    rows: readonly ContextMenuNode[];
    title?: string;
    onSelect: (item: ContextMenuItem) => void;
    /**
     * Called with the opener once the menu is live, and with null when it goes away.
     *
     * The player opens the menu itself, at the point of the press, so this is how the two
     * halves meet - and it is also what tells the player that its menu is READY. Until it
     * arrives a right-click is left to the browser rather than swallowed.
     */
    onReady: (open: OpenVideoMenu | null) => void;
}

export function VideoMenu({ rows, title, onSelect, onReady }: VideoMenuProps): ReactNode {
    return (
        <ContextMenu.Root
            items={rows}
            title={title}
            // Nothing in a player is writable and nothing in it is selected: Copy, Cut and
            // Paste built from the press would be three rows that never do anything.
            clipboard={false}
            onSelect={onSelect}
        >
            <Publish onReady={onReady} />
            <ContextMenu.Content />
        </ContextMenu.Root>
    );
}

/** Hands the opener up to the player, which is the only part that knows where the press was. */
function Publish({ onReady }: { onReady: (open: OpenVideoMenu | null) => void; }): ReactNode {
    const menu = useContextMenuContext("Video.Menu");

    useEffect(() => {
        onReady(menu.open);
        return () => onReady(null);
    }, [menu.open, onReady]);

    return null;
}
