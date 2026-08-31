"use client";

export { useMarquee, type UseMarqueeResult } from "@/react/use-marquee";
export { type MarqueeOptions, type MarqueeInstance, type MarqueeHover } from "@/core/marquee";
export { useInput, type UseInputResult } from "@/react/use-input";
export { useSearch, type UseSearchResult } from "@/react/use-search";
export { type InputOptions, type InputAction, type InputIcon } from "@/core/input";
export { type SearchOptions, type SearchMatch, type FuseConstructor } from "@/core/search";
export { useButton, type UseButtonResult } from "@/react/use-button";
export { Button, type ButtonProps } from "@/react/button";
export { setLinkComponent, getLinkComponent } from "@/react/link";
export { type ButtonOptions, type ButtonState } from "@/core/button";
export { Input } from "@/react/input";
export {
    type InputProps,
    type InputBaseProps,
    type InputType,
    type FieldAction,
    type BreachChecker,
    type BreachState,
    type BreachStatus,
    type PasswordOnlyProps,
    type SearchOnlyProps,
    type PlainOnlyProps
} from "@/react/input/types";
// The meter as a standalone component, for a form that renders it somewhere else. Re-exported
// from the chunk rather than through `Input`, so importing only `Input` leaves it behind.
export { PasswordStrength, type PasswordStrengthProps } from "@/react/input/password";
export { Slot, mergeSlotProps, type SlotProps } from "@/react/slot";
export {
    generatePassword,
    estimatePasswordStrength,
    type GeneratePasswordOptions,
    type EstimateOptions,
    type PasswordStrengthReport,
    type PasswordScore
} from "@/core/password";
export { useNotifications, createNotificationQueue, defaultQueue, type UseNotificationsResult } from "@/react/use-notifications";
export { Toaster, type ToasterProps, type ToastPosition, type ToastControls } from "@/react/toaster";
export { useNetworkState } from "@/react/use-network-state";
export { type NetworkState } from "@/core/network";
export { RelativeTime, type RelativeTimeProps } from "@/react/relative-time";
export { Flag, type FlagProps } from "@/react/flag";
export {
    flagSrc,
    flagView,
    flagAttributes,
    flagName,
    normalizeFlagCode,
    configureFlags,
    type FlagOptions,
    type FlagShape,
    type FlagFormat,
    type FlagSource
} from "@/core/flags";
export {
    SearchPalette,
    PaletteRoot,
    PaletteTrigger,
    PaletteContent,
    PaletteField,
    PaletteList,
    PaletteItem,
    PaletteFooter,
    usePaletteContext,
    type SearchPaletteProps,
    type PaletteRootProps,
    type PaletteListProps,
    type PaletteSection,
    type PaletteRow,
    type PaletteContextValue
} from "@/react/palette";
export {
    createRecentStore,
    recentKey,
    groupRows,
    moveActive,
    shortcutLabel,
    isPaletteShortcut,
    type RecentEntry,
    type RecentStore
} from "@/core/palette";
