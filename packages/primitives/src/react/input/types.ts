/**
 * The prop shapes for `<Input>`, split from the component so the per-type chunks can import
 * them without importing the component - and so every type in here is erased at build,
 * which is what keeps a `type="text"` field from pulling the password estimator or a search
 * engine into the bundle.
 *
 * The API is ONE component keyed on `type`, the way HTML itself is: `type` is an attribute
 * of one element, not a different element. Radix splits Select, Checkbox and Slider into
 * their own primitives because those are composed widgets rather than an `<input>` - that
 * split is about the DOM, not about the props. What varies here is which props EXIST, and
 * that is a discriminated union: `strength` on a text field and `items` on a password field
 * are compile errors rather than props that quietly do nothing.
 */

import type { ColorFormat } from "@/core/color";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { SearchMatch, FuseConstructor, SearchOptions } from "@/core/search";
import type { GeneratePasswordOptions, EstimateOptions, PasswordStrengthReport } from "@/core/password";

/** An extra button inside the field. The built-ins are the same shape. */
export interface FieldAction {
    /** Stable id. Lands on `data-enigma-input-action`, and replaces a built-in of the same name. */
    name: string;
    /** Accessible name. Becomes `aria-label` and `title`. */
    label: string;
    icon: ReactNode;
    onSelect: () => void;
    /** Renders `aria-pressed`. Omit for actions that are not toggles. */
    pressed?: boolean;
    /** Default true. A false action is not rendered at all. */
    visible?: boolean;
}

export type BreachStatus = "idle" | "checking" | "safe" | "breached" | "error";

export interface BreachState {
    status: BreachStatus;
    /** How many breaches the password appears in. 0 unless `status` is "breached". */
    count: number;
    /** Whatever the checker threw. The form decides whether that is worth showing. */
    error: unknown;
}

export type BreachChecker = (password: string, options: { signal: AbortSignal; }) => Promise<{ breached: boolean; count: number; }>;

/** Every `type` a single `<input>` element takes, plus the two this component teaches. */
export type InputType =
    | "text" | "email" | "password" | "search" | "tel" | "url" | "number"
    | "date" | "datetime-local" | "month" | "week" | "time"
    | "color" | "file" | "range" | "hidden" | "checkbox" | "radio";

export interface PasswordStrengthClassNames {
    track?: string;
    segment?: string;
    label?: string;
    warning?: string;
}

/** What every type has, whatever it is. */
export interface InputBaseProps extends Omit<ComponentPropsWithoutRef<"input">, "children" | "type"> {
    /** The reveal toggle. Defaults to on for `type="password"` and off for everything else. */
    reveal?: boolean;
    revealLabels?: { show?: string; hide?: string; };
    /** Extra buttons, or a replacement for a built-in by name. */
    actions?: FieldAction[];
    /** Which end the buttons sit at. Position them yourself; this only orders the markup. */
    position?: "start" | "end";
    /** Props for the element wrapping the field, its buttons and anything under them. */
    wrapperProps?: ComponentPropsWithoutRef<"div">;
    /** Props for the row holding the field and its buttons - this is what you position. */
    fieldProps?: ComponentPropsWithoutRef<"div">;
    /**
     * Classes for the parts you cannot reach with a ref, which is what Tailwind needs.
     * `className` still goes to the `<input>` itself, where you would expect it.
     */
    classNames?: {
        actions?: string;
        action?: string;
        strength?: PasswordStrengthClassNames;
        results?: string;
        result?: string;
    };
    /** Rendered inside the wrapper, after everything the type adds. Your error goes here. */
    children?: ReactNode;
}

/** The half only a password field has. */
export interface PasswordOnlyProps {
    type: "password";
    /** Offer to generate a password. `true` for the defaults, or the generator's options. */
    generate?: boolean | GeneratePasswordOptions;
    generateLabel?: string;
    /** Show what was generated. On by default - a password nobody can read is not usable. */
    revealOnGenerate?: boolean;
    /**
     * Also copy it to the clipboard. OFF by default and worth leaving off: the clipboard is
     * shared with every other app on the machine and is not cleared.
     */
    copyOnGenerate?: boolean;
    onGenerate?: (password: string) => void;
    /** Score the password as it is typed, and render the meter under the field. */
    strength?: boolean | EstimateOptions;
    onStrengthChange?: (report: PasswordStrengthReport) => void;
    /**
     * Check the password against a breach corpus - pass `checkPasswordBreach` from
     * @enigmax/utils, or your own. It is a prop rather than a built-in because it makes a
     * network request, and that is not a decision a field should take on its own.
     */
    breach?: BreachChecker;
    /** Quiet time before a check fires, in ms. Default 500. */
    breachDelay?: number;
    onBreachChange?: (state: BreachState) => void;
}

/** The half only a search field has. The palette is its own component, not a prop. */
export interface SearchOnlyProps<Item = unknown> {
    type: "search";
    /** What to search. Leave it out for a field that only reports the query. */
    items?: Item[];
    /** Which fields to read. `["title", "body"]`, or leave it out for every string field. */
    keys?: SearchOptions<Item>["keys"];
    /** Quiet time before a search runs, in ms. Default 150. */
    delay?: number;
    /** Cap the result list. Applies to the empty query too. */
    limit?: number;
    /** Fuse.js's constructor, for fuzzy matching. Without it, a substring matcher is used. */
    fuse?: FuseConstructor;
    fuseOptions?: SearchOptions<Item>["fuseOptions"];
    /** Replaces the engine outright, and wins over `fuse`. */
    matcher?: SearchOptions<Item>["matcher"];
    onResults?: (matches: SearchMatch<Item>[], query: string) => void;
    /** Render the results under the field. Without it, the field only reports them. */
    renderResults?: (matches: SearchMatch<Item>[], query: string) => ReactNode;
    /** Clear button. On by default for a search field, because the platform's own is not. */
    clearable?: boolean;
    clearLabel?: string;
}

/** Which side of the field the picker's panel opens on. `auto` measures the room there is. */
export type ColorPanelPlacement = "auto" | "top" | "bottom";

/** The picker's accessible names, for a UI that is not in English. */
export interface ColorLabels {
    /** The swatch that opens the panel. */
    open?: string;
    /** The panel itself. */
    panel?: string;
    /** The saturation and brightness square. */
    area?: string;
    hue?: string;
    alpha?: string;
    eyedropper?: string;
    swatches?: string;
    /** The editable readout under the rails. Default "Colour value". */
    value?: string;
    /** The button that cycles the readout between HEX, RGB and HSL. Default "Show as". */
    formatAs?: string;
    /** The word before the colour in what a screen reader announces. Default "Colour". */
    color?: string;
}

/** The half only a colour field has. */
export interface ColorOnlyProps {
    type: "color";
    /**
     * How the picker writes the value back: `#3b82f6`, `rgb(59, 130, 246)` or an `hsl()`.
     * Default hex. Whatever the format, every one of them is READ - a pasted `rgb()` in a hex
     * field is understood and normalized on blur rather than rejected.
     */
    format?: ColorFormat;
    /**
     * The opacity rail, and the alpha channel in the value. OFF by default: it turns
     * `#3b82f6` into `#3b82f680`, which is not what a column typed as a 7-character hex, or a
     * `<input type="color">` on the server side, is expecting.
     */
    alpha?: boolean;
    /** Preset colours under the rails - a brand palette, or the last few that were used. */
    swatches?: readonly string[];
    /**
     * The screen eyedropper, where the browser has one (Chromium today). Default true, and
     * feature-detected: the button is not rendered at all where the API is missing.
     */
    eyedropper?: boolean;
    /** Which side the panel opens on. Default `auto`, which flips near the bottom of the window. */
    placement?: ColorPanelPlacement;
    /**
     * The panel's baseline stylesheet, injected once. Default true, and the one place this
     * package ships a look - see `color-styles.ts` for why a picker cannot be unstyled.
     */
    styles?: boolean;
    colorLabels?: ColorLabels;
}

/** Everything else: one `<input>`, its native props, and no extras to bundle. */
export interface PlainOnlyProps {
    type?: Exclude<InputType, "password" | "search" | "color">;
}

export type InputProps<Item = unknown> = InputBaseProps & (PasswordOnlyProps | SearchOnlyProps<Item> | ColorOnlyProps | PlainOnlyProps);

/** Everything the implementation reads, after the union has done its job at the call site. */
export type AnyInputProps<Item = unknown> = InputBaseProps
    & Partial<Omit<PasswordOnlyProps, "type">>
    & Partial<Omit<SearchOnlyProps<Item>, "type">>
    & Partial<Omit<ColorOnlyProps, "type">>
    & { type?: InputType; };
