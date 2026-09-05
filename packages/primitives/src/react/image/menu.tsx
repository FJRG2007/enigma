"use client";

import * as icons from "@/react/image/icons";
import { useRef, type ReactNode } from "react";
import { MenuButton } from "@/react/image/viewer";
import { downloadFile } from "@/core/image-viewer";
import type { ImageItem, ImageLabels, ImageMenuOptions } from "@/react/image/types";
import { ContextMenu, useContextMenuContext, type ContextMenuNode } from "@/react/context-menu";

/**
 * The three dots, and the rows under them.
 *
 * The MENU is the context menu component, opened from a left press at the button's corner
 * rather than from a right-click - which is the composition its own docs describe. Writing a
 * second popup here would mean a second keyboard model, a second set of roles and a second
 * thing to fix, and the `fe-context-menu-hand-rolled` guardrail exists to say so.
 *
 * Its own chunk under the viewer's: the menu is off by default, so a viewer that was never
 * given one downloads neither this module nor the component it composes.
 */

export interface ImageMenuProps {
    item: ImageItem;
    index: number;
    options: ImageMenuOptions;
    labels: ImageLabels;
}

export function ImageMenu({ item, index, options, labels }: ImageMenuProps): ReactNode {
    const rows: ContextMenuNode[] = [];
    if (options.download !== false) {
        rows.push({ id: "download", label: labels.download ?? "Download", icon: <icons.Download /> });
    }
    if (options.items?.length) {
        if (rows.length > 0) rows.push({ type: "separator" });
        rows.push(...options.items);
    }

    return (
        <ContextMenu.Root
            items={rows}
            // The rows act on the picture, not on a selection: Copy, Cut and Paste are built
            // from what was right-clicked, and there is nothing writable in a lightbox.
            clipboard={false}
            onSelect={(row) => {
                if (row.id === "download") void downloadFile(item.download ?? item.src, item.filename);
                options.onSelect?.(row.id, item, index);
            }}
        >
            <Trigger label={labels.menu ?? "More"} />
            <ContextMenu.Content />
        </ContextMenu.Root>
    );
}

/** The button, wired to open the menu under itself the way a toolbar's overflow does. */
function Trigger({ label }: { label: string; }): ReactNode {
    const menu = useContextMenuContext("Image.Menu");
    const ref = useRef<HTMLSpanElement | null>(null);

    return (
        <span ref={ref} style={{ display: "contents" }}>
            <MenuButton
                label={label}
                expanded={menu.state.open}
                onPress={() => {
                    const box = ref.current?.firstElementChild?.getBoundingClientRect();
                    if (!box) return;
                    // Under the button and aligned to its right edge, which is where a toolbar
                    // menu belongs - the panel flips itself if the window has no room.
                    menu.open({ x: box.right, y: box.bottom + 6 });
                }}
            />
        </span>
    );
}
