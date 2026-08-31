"use client";

import { Children, cloneElement, forwardRef, isValidElement, type ReactNode } from "react";

/**
 * `asChild`: render the behaviour onto YOUR element instead of ours.
 *
 * This is the escape hatch that decides whether a headless package is usable at scale. A
 * component that always renders its own `<button>` forces every consumer who needs a link,
 * a `motion.button`, a router's `Link` or their own design-system button to reimplement the
 * behaviour - and that is the moment a team stops using the package. With `asChild` the
 * component contributes props, refs and handlers, and the consumer owns the element:
 *
 * ```tsx
 * <Button asChild shortcut="s">
 *     <motion.a href="/save" whileTap={{ scale: 0.98 }}>Save</motion.a>
 * </Button>
 * ```
 *
 * Radix's Slot, deliberately: the semantics are the ones a React developer already knows.
 * Its rules, and why each is the way round it is:
 *
 * - The CHILD's props win, because the child is what the author wrote by hand at this call
 *   site, while ours are the defaults a component supplied.
 * - EVENT HANDLERS are chained rather than replaced, ours first: dropping ours would take
 *   the behaviour with it silently, which is the failure `onClick` on the Button already
 *   cost once. The child's handler still runs even if ours called `preventDefault`, so a
 *   handler that wants to bail checks `event.defaultPrevented` itself.
 * - `className` and `style` are MERGED, child last, because both are additive by nature and
 *   an overwritten className is the single most confusing thing a wrapper can do.
 * - Refs are composed, so both sides keep the node.
 */

type Props = Record<string, unknown>;

function composeRefs<T>(...refs: React.Ref<T>[]): (node: T | null) => void {
    return (node) => {
        for (const ref of refs) {
            if (typeof ref === "function") ref(node);
            else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
        }
    };
}

/** Merge the slot's props into the child's, by the rules above. */
export function mergeSlotProps(slotProps: Props, childProps: Props): Props {
    const merged: Props = { ...slotProps, ...childProps };

    for (const key of Object.keys(slotProps)) {
        const slotValue = slotProps[key];
        const childValue = childProps[key];
        const isHandler = /^on[A-Z]/.test(key);

        if (isHandler && typeof slotValue === "function" && typeof childValue === "function") {
            merged[key] = (...args: unknown[]) => {
                (slotValue as (...a: unknown[]) => unknown)(...args);
                return (childValue as (...a: unknown[]) => unknown)(...args);
            };
        } else if (isHandler && typeof slotValue === "function" && childValue === undefined) {
            merged[key] = slotValue;
        } else if (key === "style") {
            merged[key] = { ...(slotValue as object), ...(childValue as object) };
        } else if (key === "className") {
            merged[key] = [slotValue, childValue].filter(Boolean).join(" ");
        }
    }
    return merged;
}

export interface SlotProps extends Props {
    children?: ReactNode;
}

/**
 * Clones its single child with the props it was given.
 *
 * A child that is not a single element is a mistake worth failing on rather than
 * papering over: `asChild` with two children has no answer to "which one gets the
 * behaviour", and rendering nothing would be a blank space nobody can debug.
 */
export const Slot = forwardRef<HTMLElement, SlotProps>(function Slot({ children, ...slotProps }, forwardedRef) {
    const child = Children.only(children);
    if (!isValidElement(child)) return null;

    const childProps = child.props as Props;
    const childRef = (child as unknown as { ref?: React.Ref<unknown>; }).ref;
    const merged = mergeSlotProps(slotProps, childProps);
    if (forwardedRef || childRef) merged.ref = composeRefs(forwardedRef as React.Ref<unknown>, childRef ?? null);

    return cloneElement(child, merged);
});
