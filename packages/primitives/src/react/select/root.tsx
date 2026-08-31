"use client";

import { Slot } from "@/react/slot";
import { groupRows } from "@/core/palette";
import { SELECT_STYLES } from "@/react/select/styles";
import { SelectContext, useSelectContext, type SelectItem } from "@/react/select/context";
import { createSelect, type SelectInstance, type SelectMoveKey, type SelectOptions, type SelectState } from "@/core/select";
import {
    useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
    type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent, type ReactNode
} from "react";

/**
 * The select, as parts.
 *
 * ```tsx
 * <Select.Root options={countries} value={value} onValueChange={setValue}>
 *     <Select.Trigger><Select.Value placeholder="Country" /></Select.Trigger>
 *     <Select.Content>
 *         <Select.Search />
 *         <Select.List />
 *     </Select.Content>
 * </Select.Root>
 * ```
 *
 * `<Select>` in the entry next to this file is exactly that composition, and the reason to
 * come here is a select whose parts are not in that order - a trigger that is a table cell,
 * a panel with a footer, a list you render row by row.
 *
 * WHY IT IS NOT A `<select>`. The native element cannot hold an icon, a second line, a
 * checkbox or a tag, and its popup is drawn by the operating system: not stylable, not
 * themable, different on every platform. So this is a listbox - and everything the native
 * element gives you for free (typeahead, the keyboard, the form value, the announcement)
 * has to be given back deliberately, which is what the rest of this file is.
 */

let injected = false;

/**
 * The baseline look, injected once.
 *
 * Every other component here ships naked and looks plain until you style it. A popup does
 * not have that option: unstyled, `<Select.Content>` is transparent text lying on top of
 * the page - not plain, broken. So the sheet is injected and PREPENDED to `<head>`, where
 * anything the document already has outranks it by source order without one `!important`;
 * `styles={false}` turns it off, and `@enigmax/primitives/select.css` is the same sheet for
 * anyone who would rather import it.
 */
function injectStyles(): void {
    if (injected || typeof document === "undefined") return;
    injected = true;
    if (document.querySelector("[data-enigma-select-styles]")) return;
    const element = document.createElement("style");
    element.setAttribute("data-enigma-select-styles", "");
    element.textContent = SELECT_STYLES;
    document.head.prepend(element);
}

/** Keys the list owns wherever focus happens to be. */
const MOVE_KEYS: Record<string, SelectMoveKey> = {
    ArrowDown: "ArrowDown",
    ArrowUp: "ArrowUp",
    Home: "Home",
    End: "End",
    PageDown: "PageDown",
    PageUp: "PageUp"
};

/** Filtering a list of eight is worth a field; filtering a list of three is a bigger panel. */
const SEARCHABLE_FROM = 8;

interface SelectRootBase extends Omit<SelectOptions, "options" | "value" | "onValueChange" | "onChange" | "multiple" | "searchable"> {
    options: SelectItem[];
    /** `"auto"` (the default) puts a filter on a list of eight or more. */
    searchable?: boolean | "auto";
    disabled?: boolean;
    /**
     * Submit with a plain HTML form: a hidden input per chosen value, so the select works
     * in a form that posts, not only in one wired to state.
     */
    name?: string;
    required?: boolean;
    /** Controlled panel. Omit both for a panel that manages itself. */
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Inject the baseline stylesheet. See the note above. */
    styles?: boolean;
    /**
     * On the ROOT, which is the element with a size: the trigger fills it, so this is what
     * a `width` belongs on. `triggerProps.className` dresses the button itself.
     */
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
}

/** One value: `value` is a string, and so is what the change reports. */
export interface SelectSingleProps extends SelectRootBase {
    multiple?: false;
    value?: string | null;
    defaultValue?: string | null;
    onValueChange?: (value: string, option: SelectItem | null) => void;
}

/** Many values: everything that was one string is a list, checked by the compiler. */
export interface SelectMultipleProps extends SelectRootBase {
    multiple: true;
    value?: string[] | null;
    defaultValue?: string[] | null;
    onValueChange?: (value: string[], options: SelectItem[]) => void;
}

export type SelectRootProps = SelectSingleProps | SelectMultipleProps;

export function SelectRoot(props: SelectRootProps): ReactNode {
    const {
        options,
        multiple = false,
        searchable = "auto",
        disabled = false,
        name,
        required,
        open: openProp,
        defaultOpen = false,
        onOpenChange,
        styles = true,
        className,
        style,
        closeOnSelect,
        fuse,
        fuseOptions,
        matcher,
        searchKeys,
        children
    } = props;

    // Before paint: a sheet applied after the first frame shows the panel unstyled first.
    useLayoutEffect(() => { if (styles) injectStyles(); }, [styles]);

    const isSearchable = searchable === "auto" ? options.length >= SEARCHABLE_FROM : searchable;
    const controlledValue = props.value === undefined ? undefined : props.value ?? (multiple ? [] : null);

    const id = useId();
    const ids = useMemo(() => ({
        trigger: `${id}-trigger`,
        list: `${id}-list`,
        field: `${id}-field`
    }), [id]);

    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const fieldRef = useRef<HTMLInputElement | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);

    // Kept in a ref so the instance - built once - always calls the CURRENT props rather
    // than the ones it closed over on the first render.
    const latest = useRef(props);
    latest.current = props;

    const instance = useMemo<SelectInstance>(() => createSelect({
        options,
        multiple,
        searchable: isSearchable,
        closeOnSelect,
        fuse,
        fuseOptions,
        matcher,
        searchKeys,
        value: props.defaultValue ?? controlledValue ?? (multiple ? [] : null),
        onValueChange: (next, chosen) => {
            const current = latest.current;
            if (current.multiple) current.onValueChange?.(next as string[], chosen as SelectItem[]);
            else current.onValueChange?.(next as string, (chosen as SelectItem[])[0] ?? null);
        }
        // Built once: rebuilding it would drop the open panel and the highlight on every
        // render. Every option below is pushed in through update().
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);

    const [state, setState] = useState<SelectState>(() => instance.state);

    useEffect(() => {
        const unsubscribe = instance.subscribe(setState);
        setState(instance.state);
        return () => {
            unsubscribe();
            instance.destroy();
        };
    }, [instance]);

    /**
     * What the options ARE, as a string.
     *
     * The effect below cannot depend on the array: `options={[{ value: "es", ... }]}` is a
     * new array of new objects on every render, so pushing it in would emit a new state,
     * render again, and build another array - a loop, and inline options are how everyone
     * writes them. Comparing the content instead makes the effect run when something
     * actually changed. React nodes are left out of the signature on purpose: an icon is a
     * fresh element object every render and no two are ever equal.
     */
    // Built only when the array itself is new, because the root re-renders on every
    // keystroke and serialising a list of 250 countries per render is work nobody asked
    // for: a stable array pays for this once.
    const signature = useMemo(() => JSON.stringify(options.map((option) =>
        [option.value, option.label, option.description, option.group, option.disabled, option.keywords])), [options]);

    /**
     * What the FILTER is, as a string.
     *
     * The same problem as the options, one prop over: `fuseOptions={{ threshold: 0.3 }}`
     * and `searchKeys={["label"]}` are the documented way to write them and a new object on
     * every render, so depending on their identity pushes them in each time - and that
     * rebuilds Fuse's index over the whole list for a filter nobody changed. They are plain
     * data, so their content is comparable; `fuse` and `matcher` are functions and stay on
     * identity, where a rebuild is what a genuinely different one needs.
     */
    const filterSignature = JSON.stringify([searchKeys ?? null, fuseOptions ?? null]);

    // The newest values, pushed in whenever a signature says something is different - so
    // the instance holds the current objects and not the ones from the first render.
    const currentOptions = useRef(options);
    currentOptions.current = options;
    const currentFilter = useRef({ fuseOptions, searchKeys });
    currentFilter.current = { fuseOptions, searchKeys };

    useEffect(() => {
        const { fuseOptions: currentFuseOptions, searchKeys: currentKeys } = currentFilter.current;
        instance.update({
            options: currentOptions.current, multiple, searchable: isSearchable, closeOnSelect,
            fuse, matcher, fuseOptions: currentFuseOptions, searchKeys: currentKeys
        });
    }, [instance, signature, filterSignature, multiple, isSearchable, closeOnSelect, fuse, matcher]);

    /**
     * A controlled value is the caller's, always.
     *
     * Compared after EVERY render rather than when the prop changes, because the case this
     * exists for is the prop NOT changing: a parent that validates a choice and keeps its
     * own value has already had the instance move underneath it, and an effect keyed on the
     * prop would never run to put it back. The comparison is by content - `value={[...]}`
     * is a new array every render - so the two settle in one pass: the push renders once
     * more, that render finds them equal, and nothing further is pushed.
     */
    useEffect(() => {
        if (controlledValue === undefined) return;
        const wanted = controlledValue === null ? [] : Array.isArray(controlledValue) ? controlledValue : [controlledValue];
        const current = instance.state.value;
        if (current.length === wanted.length && current.every((entry, index) => entry === wanted[index])) return;
        instance.update({ value: [...wanted] });
    });

    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
    const open = openProp ?? uncontrolledOpen;

    const setOpen = useCallback((next: boolean) => {
        if (disabled && next) return;
        if (openProp === undefined) setUncontrolledOpen(next);
        // The instance is opened HERE and not only from the effect below, so that whatever
        // the same handler does next - a typeahead, a move - runs against a panel that is
        // already open. Through the effect it would run first and be overwritten by the
        // open, which is a highlight that lands on the wrong row.
        instance.setOpen(next);
        onOpenChange?.(next);
    }, [instance, disabled, openProp, onOpenChange]);

    useEffect(() => { instance.setOpen(open); }, [instance, open]);

    // The core closes itself after a choice; the React copy of that fact has to follow, or
    // the next click on the trigger reopens a panel React still believes is open.
    //
    // Only on the TRANSITION. Comparing the two flags directly reads the one render where
    // React has already opened and the instance has not caught up yet - and closes the panel
    // a frame after it opened, which is the bug this comment exists to keep fixed.
    const wasOpen = useRef(state.open);
    useEffect(() => {
        const closedItself = wasOpen.current && !state.open;
        wasOpen.current = state.open;
        if (!closedItself || !open) return;
        // Whatever closed it was inside the panel - a row, or Enter in the search field -
        // and the panel is about to unmount with the focus still in it. Focus goes back to
        // the trigger rather than to the body, exactly as Escape does it.
        const held = rootRef.current?.contains(document.activeElement);
        setOpen(false);
        if (held) triggerRef.current?.focus();
    }, [state.open, open, setOpen]);

    const close = useCallback(() => {
        setOpen(false);
        // Focus goes back to the trigger rather than to the body: the panel is gone, and a
        // keyboard visitor left standing on nothing has to tab from the top of the page.
        triggerRef.current?.focus();
    }, [setOpen]);

    // A click anywhere else closes it. `pointerdown` rather than `click` so it closes on
    // the way down, before whatever was clicked runs.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (rootRef.current?.contains(event.target as Node)) return;
            setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [open, setOpen]);

    const onListKeyDown = useCallback((event: KeyboardEvent) => {
        const move = MOVE_KEYS[event.key];
        if (move) {
            event.preventDefault();
            if (!open) { setOpen(true); return; }
            instance.move(move);
            return;
        }
        if (event.key === "Enter") {
            if (!open) { event.preventDefault(); setOpen(true); return; }
            event.preventDefault();
            instance.selectActive();
            return;
        }
        if (event.key === "Escape") {
            if (!open) return;
            event.preventDefault();
            // Stopped here so one Escape closes the select and not the dialog around it.
            event.stopPropagation();
            close();
            return;
        }
        if (event.key === "Tab" && open) {
            setOpen(false);
            return;
        }
        // Backspace and Delete take a value off, and only on the trigger: in the search
        // field they edit the query. The × that does this with a pointer sits INSIDE the
        // trigger button, where it cannot be a tab stop of its own, so without this a
        // clearable select is one no keyboard can empty.
        if ((event.key === "Backspace" || event.key === "Delete") && event.currentTarget === triggerRef.current) {
            const chosen = instance.state.value;
            if (chosen.length === 0) return;
            event.preventDefault();
            // Many values drop the last one, the way removing a tag does; one value has
            // nothing to drop but itself.
            if (instance.state.multiple) instance.remove(chosen[chosen.length - 1]);
            else instance.clear();
            return;
        }
        // Space chooses on the trigger, where it is not text; inside the search field it is
        // a space, and taking it would make phrases unsearchable.
        if (event.key === " " && event.currentTarget === triggerRef.current) {
            event.preventDefault();
            if (open) instance.selectActive();
            else setOpen(true);
            return;
        }
        // Typeahead, the way the native control does it - and only where there is no field
        // to type into, because there the letters ARE the filter.
        if (!fieldRef.current && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (!open) setOpen(true);
            instance.typeahead(event.key);
        }
    }, [instance, open, setOpen, close]);

    const context = useMemo(() => ({
        instance,
        state,
        setOpen,
        disabled,
        searchable: isSearchable,
        ids,
        optionId: (index: number) => `${id}-option-${index}`,
        triggerRef,
        fieldRef,
        close,
        onListKeyDown
    }), [instance, state, setOpen, disabled, isSearchable, ids, id, close, onListKeyDown]);

    return (
        <SelectContext.Provider value={context}>
            <div
                ref={rootRef}
                className={className}
                style={style}
                data-enigma-select-root=""
                data-open={open ? "" : undefined}
                data-disabled={disabled ? "" : undefined}
                data-multiple={multiple ? "" : undefined}
            >
                {children}
                {/* The form half. A select that only exists in React state cannot be
                    submitted by the form it sits in, and that is where it usually sits. */}
                {name && state.value.map((entry) => (
                    <input key={entry} type="hidden" name={multiple ? `${name}[]` : name} value={entry} />
                ))}
                {name && state.value.length === 0 && required && (
                    // Required with nothing chosen: a field the browser can refuse to
                    // submit, kept out of the tab order and off the screen readers.
                    <input
                        tabIndex={-1}
                        required
                        aria-hidden="true"
                        data-enigma-select-validity=""
                        // Inline rather than in the sheet: `display: none` is exempt from
                        // constraint validation, so it has to be RENDERED and invisible -
                        // and it has to stay invisible when the sheet is turned off.
                        style={{ position: "absolute", width: 0, height: 0, padding: 0, border: 0, opacity: 0, pointerEvents: "none" }}
                        value=""
                        onChange={() => { /* never typed into; the select owns the value */ }}
                        onFocus={() => triggerRef.current?.focus()}
                    />
                )}
            </div>
        </SelectContext.Provider>
    );
}

export interface SelectTriggerProps extends Omit<ComponentPropsWithoutRef<"button">, "value"> {
    /** Put the behaviour on your own element instead of ours. */
    asChild?: boolean;
}

export function SelectTrigger({ asChild = false, children, onClick, onKeyDown, ...props }: SelectTriggerProps): ReactNode {
    const select = useSelectContext("Select.Trigger");
    const Tag = asChild ? Slot : "button";
    const active = select.state.active;

    return (
        <Tag
            {...props}
            ref={select.triggerRef}
            id={select.ids.trigger}
            type={asChild ? undefined : "button"}
            // The combobox is the trigger only while there is no field to type in: with a
            // search field open, THAT is the combobox and this is the button that opened it.
            role={select.searchable ? undefined : "combobox"}
            aria-haspopup="listbox"
            aria-expanded={select.state.open}
            aria-controls={select.state.open ? select.ids.list : undefined}
            aria-activedescendant={!select.searchable && select.state.open && active >= 0 ? select.optionId(active) : undefined}
            aria-disabled={select.disabled || undefined}
            disabled={asChild ? undefined : select.disabled}
            data-enigma-select-trigger=""
            data-open={select.state.open ? "" : undefined}
            data-placeholder={select.state.value.length === 0 ? "" : undefined}
            onClick={(event) => {
                onClick?.(event);
                if (event.defaultPrevented || select.disabled) return;
                select.setOpen(!select.state.open);
            }}
            onKeyDown={(event) => {
                onKeyDown?.(event);
                if (!event.defaultPrevented) select.onListKeyDown(event);
            }}
        >
            {children}
        </Tag>
    );
}

export interface SelectValueProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
    placeholder?: ReactNode;
    /**
     * Show each chosen option as a removable tag. On by default when many values are
     * allowed, because a comma-separated line of eight labels is not something you can
     * take one item out of.
     */
    tags?: boolean;
    /** How many tags before the rest collapse into "+N". */
    maxTags?: number;
    /** Draw the value yourself, from what is chosen. */
    children?: ReactNode | ((selected: SelectItem[]) => ReactNode);
}

export function SelectValue({ placeholder = "Select", tags, maxTags = 3, children, ...props }: SelectValueProps): ReactNode {
    const select = useSelectContext("Select.Value");
    const selected = select.state.selected as SelectItem[];
    const showTags = tags ?? select.state.multiple;

    if (typeof children === "function") return <span {...props} data-enigma-select-value="">{children(selected)}</span>;
    if (children) return <span {...props} data-enigma-select-value="">{children}</span>;

    if (selected.length === 0) {
        return <span {...props} data-enigma-select-value="" data-placeholder="">{placeholder}</span>;
    }

    if (!showTags) {
        const [first] = selected;
        return (
            <span {...props} data-enigma-select-value="">
                {first.icon ? <span data-enigma-select-icon="">{first.icon}</span> : null}
                {selected.length > 1 ? `${first.label} +${selected.length - 1}` : first.label}
            </span>
        );
    }

    const shown = selected.slice(0, maxTags);
    const rest = selected.length - shown.length;

    return (
        <span {...props} data-enigma-select-value="" data-tags="">
            {shown.map((option) => (
                <span key={option.value} data-enigma-select-tag="">
                    {option.icon ? <span data-enigma-select-icon="">{option.icon}</span> : null}
                    {option.label}
                    {/* A span, not a button: this is already inside the trigger button, and
                        a button inside a button is invalid markup that browsers unnest. */}
                    <span
                        role="button"
                        tabIndex={-1}
                        aria-label={`Remove ${option.label}`}
                        data-enigma-select-tag-remove=""
                        onPointerDown={(event) => {
                            // Down, not click: the trigger toggles the panel on click, and
                            // removing a tag must not also open it.
                            event.preventDefault();
                            event.stopPropagation();
                            select.instance.remove(option.value);
                        }}
                    >×</span>
                </span>
            ))}
            {rest > 0 && <span data-enigma-select-tag="" data-rest="">+{rest}</span>}
        </span>
    );
}

export interface SelectContentProps extends ComponentPropsWithoutRef<"div"> {
    /** Keep the panel mounted while it animates out. ms. */
    closeDuration?: number;
}

export function SelectContent({ closeDuration = 120, children, ...props }: SelectContentProps): ReactNode {
    const select = useSelectContext("Select.Content");
    const ref = useRef<HTMLDivElement | null>(null);
    const [mounted, setMounted] = useState(select.state.open);
    const [side, setSide] = useState<"top" | "bottom">("bottom");

    useEffect(() => {
        if (select.state.open) { setMounted(true); return; }
        // Unmounted a beat later, so the closing animation has something to animate.
        const timer = setTimeout(() => setMounted(false), closeDuration);
        return () => clearTimeout(timer);
    }, [select.state.open, closeDuration]);

    // Which way it opens is measured, not assumed: a select near the bottom of the window
    // opens upwards, or its list is off the screen and unreachable.
    useLayoutEffect(() => {
        if (!select.state.open || !ref.current) return;
        const trigger = select.triggerRef.current?.getBoundingClientRect();
        if (!trigger) return;
        const height = ref.current.offsetHeight;
        const below = window.innerHeight - trigger.bottom;
        setSide(below < height && trigger.top > below ? "top" : "bottom");
    }, [select.state.open, select.state.visible.length, select.triggerRef]);

    if (!mounted) return null;

    return (
        <div
            {...props}
            ref={ref}
            data-enigma-select-content=""
            data-state={select.state.open ? "open" : "closed"}
            data-side={side}
            onKeyDown={(event) => {
                props.onKeyDown?.(event);
                if (!event.defaultPrevented) select.onListKeyDown(event);
            }}
        >
            {children}
        </div>
    );
}

export interface SelectSearchProps extends Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange" | "type"> {
    placeholder?: string;
}

export function SelectSearch({ placeholder = "Search", onKeyDown, ...props }: SelectSearchProps): ReactNode {
    const select = useSelectContext("Select.Search");
    const { instance, state, ids, fieldRef } = select;

    // Focus lands in the field the moment the panel opens, so the first letter typed is
    // part of the filter rather than lost.
    useEffect(() => {
        if (state.open) fieldRef.current?.focus();
    }, [state.open, fieldRef]);

    return (
        <input
            {...props}
            ref={fieldRef}
            id={ids.field}
            // `search` and not `text`: it is a search field, and the platform knows what
            // that means for the keyboard's enter key and for autofill.
            type="search"
            role="combobox"
            aria-expanded={state.open}
            aria-controls={ids.list}
            aria-autocomplete="list"
            aria-activedescendant={state.active >= 0 ? select.optionId(state.active) : undefined}
            aria-label={props["aria-label"] ?? placeholder}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            data-enigma-select-search=""
            value={state.query}
            onChange={(event) => instance.setQuery(event.target.value)}
            onKeyDown={(event) => {
                onKeyDown?.(event);
                if (!event.defaultPrevented) select.onListKeyDown(event);
            }}
        />
    );
}

export interface SelectListProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
    /** Render one option. Default: icon, label, description and the check. */
    children?: (option: SelectItem, index: number) => ReactNode;
    /** What to show when the filter matches nothing. */
    empty?: ReactNode;
    /**
     * How many rows to put in the document at once. The rest arrive a chunk at a time as
     * the list is scrolled - see the note below. `Infinity` renders the lot.
     */
    chunk?: number;
}

/** Rows kept ahead of the highlight, so arrowing down never runs into an unrendered row. */
const OVERSCAN = 10;

export function SelectList({ children, empty, chunk = 40, ...props }: SelectListProps): ReactNode {
    const select = useSelectContext("Select.List");
    const { state } = select;
    const sentinel = useRef<HTMLDivElement | null>(null);
    const [limit, setLimit] = useState(chunk);

    /**
     * Only what can be seen, plus a screenful.
     *
     * A select of every country is 250 rows, and with a flag on each one that is 250 images
     * and 250 subtrees built before the panel can be painted - for the seven rows anybody
     * sees. So the list renders a chunk and grows: on scroll, through the sentinel below,
     * and immediately whenever the highlight is heading past the end, because a keyboard
     * reaches row 200 without ever scrolling.
     */
    const shown = Math.min(state.visible.length, Math.max(limit, state.active + 1 + OVERSCAN));
    const visible = useMemo(() => state.visible.slice(0, shown) as SelectItem[], [state.visible, shown]);
    const rest = state.visible.length - shown;

    // A new filter is a new list: keeping the old window would leave a short result set
    // rendering rows it no longer has, and a long one starting halfway down.
    useEffect(() => { setLimit(chunk); }, [state.query, chunk]);

    useEffect(() => {
        const target = sentinel.current;
        if (!target) return;
        // Without IntersectionObserver the whole list renders rather than a third of it:
        // slower to open beats unreachable rows.
        if (typeof IntersectionObserver === "undefined") { setLimit(Number.POSITIVE_INFINITY); return; }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) setLimit((current) => current + chunk);
        }, { root: target.parentElement, rootMargin: "120px" });
        observer.observe(target);
        return () => observer.disconnect();
    }, [chunk, rest]);

    // Grouped with the flat position kept, so the arrow keys move through ONE sequence and
    // a group heading is invisible to them.
    const groups = useMemo(
        () => groupRows(visible, (option) => option.group ?? ""),
        [visible]
    );

    return (
        <div
            {...props}
            id={select.ids.list}
            role="listbox"
            aria-multiselectable={state.multiple || undefined}
            aria-labelledby={select.ids.trigger}
            data-enigma-select-list=""
        >
            {state.visible.length === 0
                ? empty ?? <p data-enigma-select-empty="">{state.query.trim() ? `Nothing matches "${state.query.trim()}".` : "Nothing to choose."}</p>
                : groups.map((group) => (
                    <div key={group.label} role="group" aria-label={group.label || undefined} data-enigma-select-group="">
                        {group.label && <p data-enigma-select-group-label="" aria-hidden="true">{group.label}</p>}
                        {group.rows.map(({ row, position }) => (
                            <SelectOptionRow key={row.value} option={row} index={position}>
                                {children?.(row, position)}
                            </SelectOptionRow>
                        ))}
                    </div>
                ))}
            {rest > 0 && (
                // The end of what is rendered. Reaching it renders the next chunk, so the
                // list appears endless while the document holds a screenful of it.
                <div ref={sentinel} data-enigma-select-more="" aria-hidden="true" />
            )}
        </div>
    );
}

export interface SelectOptionProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
    option: SelectItem;
    /** Its position in the FLAT list, which is what the keyboard moves through. */
    index: number;
    children?: ReactNode;
}

export function SelectOptionRow({ option, index, children, ...props }: SelectOptionProps): ReactNode {
    const select = useSelectContext("Select.Option");
    const ref = useRef<HTMLDivElement | null>(null);
    const isActive = select.state.active === index;
    const isSelected = select.state.value.includes(option.value);

    // The highlight can move by key onto a row that is scrolled out of sight, and a
    // highlight nobody can see is the same as no highlight.
    useEffect(() => {
        if (isActive) ref.current?.scrollIntoView({ block: "nearest" });
    }, [isActive]);

    return (
        <div
            {...props}
            ref={ref}
            id={select.optionId(index)}
            role="option"
            aria-selected={isSelected}
            aria-disabled={option.disabled || undefined}
            data-enigma-select-option=""
            data-active={isActive ? "" : undefined}
            data-selected={isSelected ? "" : undefined}
            data-disabled={option.disabled ? "" : undefined}
            // Down rather than click: the panel's own pointerdown handler closes on an
            // outside press, and a mouseup that lands after a scroll should not choose.
            onPointerDown={(event) => {
                event.preventDefault();
                select.instance.select(option.value);
            }}
            onPointerMove={() => { if (!option.disabled) select.instance.setActive(index); }}
        >
            {children ?? (
                <>
                    {option.icon ? <span data-enigma-select-icon="">{option.icon}</span> : null}
                    <span data-enigma-select-option-text="">
                        <span data-enigma-select-option-label="">{option.label}</span>
                        {option.description && <span data-enigma-select-option-description="">{option.description}</span>}
                    </span>
                    <span data-enigma-select-check="" aria-hidden="true" />
                </>
            )}
        </div>
    );
}
