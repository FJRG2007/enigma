"use client";

import type { ReactNode } from "react";
import * as parts from "@/react/context-menu/root";
import { useContextMenuContext } from "@/react/context-menu/context";
import type { ContextMenuRootProps, ContextMenuTriggerProps, ContextMenuContentProps } from "@/react/context-menu/root";

export type ContextMenuProps = ContextMenuRootProps & {
    /** How many rows to put in the document at once. `Infinity` renders the lot. */
    chunk?: ContextMenuContentProps["chunk"];
    /** Open on a long press as well, which is what a right-click is on a touch screen. */
    longPress?: boolean;
    triggerProps?: ContextMenuTriggerProps;
    contentProps?: ContextMenuContentProps;
};

/**
 * The context menu, assembled.
 *
 * ```tsx
 * <ContextMenu
 *     title={file.name}
 *     items={[
 *         { id: "rename", label: "Rename", shortcut: "F2", icon: <Pencil /> },
 *         { type: "separator" },
 *         { id: "delete", label: "Delete", shortcut: "Delete", destructive: true }
 *     ]}
 *     onSelect={(item) => run(item.id)}
 * >
 *     <FileRow file={file} />
 * </ContextMenu>
 * ```
 *
 * Everything it renders is a part you can render yourself instead - see `ContextMenu.Root`
 * for the anatomy. This is those parts in the order they belong in, not a different
 * component: the children become the area a right-click opens the menu over.
 *
 * A menu with no rows to show does not open, and the press falls through to the browser's own
 * menu - an empty box at the pointer tells the reader nothing, and swallowing the press to
 * show one tells them less.
 */
export function ContextMenu(props: ContextMenuProps): ReactNode {
    const { chunk, longPress, triggerProps, contentProps, children, ...rest } = props;

    return (
        <parts.ContextMenuRoot {...rest}>
            <parts.ContextMenuTrigger longPress={longPress} {...triggerProps}>{children}</parts.ContextMenuTrigger>
            <parts.ContextMenuContent chunk={chunk} {...contentProps} />
        </parts.ContextMenuRoot>
    );
}

ContextMenu.Root = parts.ContextMenuRoot;
ContextMenu.Trigger = parts.ContextMenuTrigger;
ContextMenu.Content = parts.ContextMenuContent;
ContextMenu.Panel = parts.ContextMenuPanel;
ContextMenu.Search = parts.ContextMenuSearch;
ContextMenu.List = parts.ContextMenuList;
ContextMenu.Item = parts.ContextMenuRow;

export {
    ContextMenuRoot,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuPanel,
    ContextMenuSearch,
    ContextMenuList,
    ContextMenuRow,
    type ContextMenuRootProps,
    type ContextMenuTriggerProps,
    type ContextMenuContentProps,
    type ContextMenuPanelProps,
    type ContextMenuSearchProps,
    type ContextMenuListProps,
    type ContextMenuRowProps
} from "@/react/context-menu/root";
export { useContextMenuContext, type ContextMenuItem, type ContextMenuNode, type ContextMenuContextValue } from "@/react/context-menu/context";
export {
    createContextMenu,
    isAction,
    CONTEXT_MENU_SEARCH_KEYS,
    type ContextMenuEntry,
    type ContextMenuAction,
    type ContextMenuSeparator,
    type ContextMenuLabel,
    type ContextMenuOptions,
    type ContextMenuInstance,
    type ContextMenuState,
    type ContextMenuLevel,
    type ContextMenuPoint,
    type ContextMenuMoveKey
} from "@/core/context-menu";
export { CONTEXT_MENU_STYLES } from "@/react/context-menu/styles";
export { shortcutTokens, shortcutText, parseShortcut, matchesShortcut, type Shortcut, type ShortcutSpec } from "@/core/keys";
