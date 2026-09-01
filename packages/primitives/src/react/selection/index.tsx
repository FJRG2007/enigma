"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useSelection, type SelectionRenderer, type UseSelectionOptions } from "@/react/selection/use-selection";

/**
 * `onChange` is dropped from BOTH sides on purpose: the model's means "the state moved" and a
 * div's means an input inside it changed, and one name cannot be both. The selection is
 * reported through `onSelectionChange`, and the whole state through `useSelection`.
 */
export interface SelectionListProps<Item> extends Omit<UseSelectionOptions<Item>, "onChange">, Omit<ComponentPropsWithoutRef<"div">, "children" | "onSelect" | "onChange"> {
    /** Draw one row. What it returns goes inside the row element, which this component owns. */
    children: SelectionRenderer<Item>;
    /** Shown instead of the rows when there are none. */
    empty?: ReactNode;
    /** Drag a rubber band over the empty space to select what it covers. Default: on. */
    marquee?: boolean;
}

/**
 * A list whose rows can be selected the way a file manager's are.
 *
 * ```tsx
 * <SelectionList
 *     items={files}
 *     getId={(file) => file.path}
 *     onCommand={(event) => {
 *         if (event.command === "delete") remove(event.items);
 *         if (event.command === "rename") rename(event.cursor);
 *     }}
 * >
 *     {({ item }) => <><FileIcon kind={item.kind} />{item.name}</>}
 * </SelectionList>
 * ```
 *
 * It renders a container and one element per row, with the roles, the ids and the state
 * attributes on them - and nothing else. No borders, no padding, no highlight: `[data-selected]`
 * and `[data-cursor]` are there for the stylesheet, so the list looks like the rest of the
 * product rather than like this package.
 *
 * The shape is the only thing it decides. A table, a grid of cards, a tree or a virtualized
 * window - and anything that needs to reach the model itself, to clear the selection from a
 * toolbar or read it into a header checkbox - uses `useSelection` directly and puts the same
 * props on its own markup. That is the same component with the markup handed back.
 */
export function SelectionList<Item>(props: SelectionListProps<Item>): ReactNode {
    const {
        items,
        getId,
        disabled,
        multiple,
        columns,
        page,
        shortcuts,
        onCommand,
        onSelectionChange,
        scrollIntoView,
        children,
        empty,
        marquee = true,
        ...rest
    } = props;

    const selection = useSelection<Item>({
        items, getId, disabled, multiple, columns, page, shortcuts, onCommand, onSelectionChange, scrollIntoView
    });

    const listProps = selection.getListProps<HTMLDivElement>(rest);
    const containerProps = marquee ? selection.getMarqueeProps<HTMLDivElement>(listProps) : listProps;

    return (
        // `position: relative` is the one style this component sets, and it is not a look: the
        // rubber band is absolutely positioned inside, and without a positioned ancestor it
        // would be drawn against the page instead of against the list.
        <div {...containerProps} style={{ position: "relative", ...rest.style }}>
            {items.length === 0 && empty !== undefined
                ? <div data-enigma-selection-empty="">{empty}</div>
                : items.map((item, index) => (
                    <div key={getId ? getId(item, index) : index} {...selection.getItemProps<HTMLDivElement>(index)}>
                        {children({
                            item,
                            index,
                            selected: selection.state.selectedSet.has(getId ? getId(item, index) : String(index)),
                            cursor: selection.state.cursor === index,
                            disabled: Boolean(disabled?.(item, index))
                        })}
                    </div>
                ))}
            {selection.marquee && (
                // The band is drawn, not just computed: without something on screen a drag over
                // empty space looks like the list selecting rows at random.
                <div
                    aria-hidden="true"
                    data-enigma-selection-marquee=""
                    style={{ position: "absolute", pointerEvents: "none", ...selection.marquee }}
                />
            )}
        </div>
    );
}

export { useSelection, type UseSelectionOptions, type UseSelectionResult, type SelectionRenderer, type SelectionRowRender, type MarqueeRect } from "@/react/selection/use-selection";
export {
    createSelection,
    DEFAULT_SELECTION_SHORTCUTS,
    type SelectionCommand,
    type SelectionCommandName,
    type SelectionCommandEvent,
    type SelectionShortcuts,
    type SelectionOptions,
    type SelectionInstance,
    type SelectionState,
    type SelectionClickModifiers
} from "@/core/selection";
export { shortcutTokens, shortcutText, parseShortcut, matchesShortcut, type Shortcut, type ShortcutSpec } from "@/core/keys";
