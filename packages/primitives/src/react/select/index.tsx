"use client";

import type { ReactNode } from "react";
import * as parts from "@/react/select/root";
import { useSelectContext } from "@/react/select/context";
import type { SelectRootProps, SelectTriggerProps, SelectContentProps, SelectListProps } from "@/react/select/root";

export type SelectProps = SelectRootProps & {
    /** What the trigger says with nothing chosen. */
    placeholder?: ReactNode;
    searchPlaceholder?: string;
    /** Removable tags instead of a comma-separated line. Default: on when `multiple`. */
    tags?: boolean;
    maxTags?: number;
    /** Shown when the filter matches nothing. */
    empty?: ReactNode;
    /** Draw a row yourself: the icon, label, description and check are the default. */
    renderOption?: SelectListProps["children"];
    /** On the root, which is the element with a size. `triggerProps` dresses the button. */
    className?: string;
    triggerProps?: SelectTriggerProps;
    contentProps?: SelectContentProps;
};

/**
 * The select, assembled.
 *
 * ```tsx
 * <Select
 *     options={[{ value: "es", label: "Spain", icon: <Flag code="es" /> }]}
 *     value={country}
 *     onValueChange={setCountry}
 * />
 * ```
 *
 * Everything it renders is a part you can render yourself instead - see `Select.Root` for
 * the anatomy. This is those parts in the order they belong in, not a different component.
 *
 * `multiple` changes the types with it: `value` and what the change reports are a list, and
 * the compiler says so at the call site. A filter appears on its own once the list is long
 * enough to need one, fuzzy if you hand over Fuse's constructor and plain otherwise.
 */
export function Select(props: SelectProps): ReactNode {
    const {
        placeholder = "Select",
        searchPlaceholder = "Search",
        tags,
        maxTags,
        empty,
        renderOption,
        className,
        triggerProps,
        contentProps,
        children,
        ...rest
    } = props;

    // The union survives as far as the props object; the rest spread flattens it, so the
    // cast puts back what TypeScript dropped rather than widening anything.
    const root = rest as SelectRootProps;

    return (
        <parts.SelectRoot {...root} className={className}>
            <parts.SelectTrigger {...triggerProps}>
                <parts.SelectValue placeholder={placeholder} tags={tags} maxTags={maxTags} />
            </parts.SelectTrigger>
            <parts.SelectContent {...contentProps}>
                {/* Rendered on the root's own decision: `searchable="auto"` is a count, and
                    the field has to appear on the same rule the keyboard follows. */}
                <SearchSlot placeholder={searchPlaceholder} />
                <parts.SelectList empty={empty}>{renderOption}</parts.SelectList>
            </parts.SelectContent>
            {children}
        </parts.SelectRoot>
    );
}

/** The filter, only where the root decided there is one. */
function SearchSlot({ placeholder }: { placeholder: string; }): ReactNode {
    const { searchable } = useSelectContext("Select");
    return searchable ? <parts.SelectSearch placeholder={placeholder} /> : null;
}

Select.Root = parts.SelectRoot;
Select.Trigger = parts.SelectTrigger;
Select.Value = parts.SelectValue;
Select.Content = parts.SelectContent;
Select.Search = parts.SelectSearch;
Select.List = parts.SelectList;
Select.Option = parts.SelectOptionRow;

export * from "@/react/select/root";
export { useSelectContext, type SelectItem, type SelectContextValue } from "@/react/select/context";
export { SELECT_STYLES } from "@/react/select/styles";
export { createSelect, SELECT_SEARCH_KEYS } from "@/core/select";
export type { SelectOption, SelectOptions, SelectState, SelectInstance, SelectMoveKey } from "@/core/select";
