"use client";

import { createContext, useContext } from "react";
import type { ReactNode, RefObject } from "react";
import type { SelectInstance, SelectOption, SelectState } from "@/core/select";

/**
 * One option, as React draws it. The core carries `icon` as `unknown` because it cannot
 * know what a node is; here it is one.
 */
export interface SelectItem extends SelectOption {
    icon?: ReactNode;
}

export interface SelectContextValue {
    instance: SelectInstance;
    state: SelectState;
    /** Open or close the panel. React owns that flag; the instance follows it. */
    setOpen: (open: boolean) => void;
    disabled: boolean;
    /** Whether the trigger offers a × that empties the selection. */
    clearable: boolean;
    searchable: boolean;
    /** ids the parts need to point at each other. */
    ids: { trigger: string; list: string; field: string; };
    optionId: (index: number) => string;
    triggerRef: RefObject<HTMLButtonElement | null>;
    fieldRef: RefObject<HTMLInputElement | null>;
    /** Close and put focus back where it came from - the trigger, always. */
    close: () => void;
    /** The keys the list answers to, shared by the trigger and the search field. */
    onListKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * Null rather than a default: a part rendered outside its Root is a mistake with an obvious
 * fix, and a silent default would leave it half-working - a trigger that opens nothing, an
 * option that selects into the void.
 */
export const SelectContext = createContext<SelectContextValue | null>(null);

export function useSelectContext(part: string): SelectContextValue {
    const value = useContext(SelectContext);
    if (!value) throw new Error(`<${part}> must be rendered inside <Select.Root>.`);
    return value;
}
