"use client";

export { useMarquee, type UseMarqueeResult } from "@/react/use-marquee";
export { type MarqueeOptions, type MarqueeInstance, type MarqueeHover } from "@/core/marquee";
export { useInput, type UseInputResult } from "@/react/use-input";
export { useSearch, type UseSearchResult } from "@/react/use-search";
export { type InputOptions, type InputAction, type InputIcon } from "@/core/input";
export { shortenQuery, type SearchOptions, type SearchMatch, type FuseConstructor } from "@/core/search";
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
    type ColorLabels,
    type ColorPanelPlacement,
    type PasswordOnlyProps,
    type SearchOnlyProps,
    type ColorOnlyProps,
    type PlainOnlyProps
} from "@/react/input/types";
// The meter as a standalone component, for a form that renders it somewhere else. Re-exported
// from the chunk rather than through `Input`, so importing only `Input` leaves it behind.
export { PasswordStrength, type PasswordStrengthProps } from "@/react/input/password";
// The colour maths, for a form that has to read or write the value the picker produced. The
// picker itself arrives through `<Input type="color">`, so nothing here reaches into its chunk.
export {
    parseColor,
    formatColor,
    toHex,
    rgbToHsv,
    hsvToRgb,
    rgbToHsl,
    hslToRgb,
    colorEquals,
    type Rgb,
    type Hsv,
    type Hsl,
    type ColorFormat,
    type FormatColorOptions
} from "@/core/color";
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
export { Toaster, toast, useSonner, type ToasterProps } from "@/react/toaster";
export type { ToastT, ExternalToast, ToastClassnames, Action } from "@/react/toast/types";
export { useNetworkState } from "@/react/use-network-state";
export { type NetworkState } from "@/core/network";
export { RelativeTime, type RelativeTimeProps } from "@/react/relative-time";
// The option types too: a wrapper around any of these has to be able to name its own props.
export type {
    RelativeTimeOptions,
    RelativeTimeFormat,
    RelativeTimeTense,
    RelativeTimePrecision,
    RelativeTimeStyle
} from "@/core/relative-time";
export type { NotificationTone, NotificationAction, NotificationInput, Notification, NotificationsOptions } from "@/core/notifications";
export type { SearchInstance, FuseLike } from "@/core/search";
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
export {
    Select,
    SelectRoot,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectSearch,
    SelectList,
    SelectOptionRow,
    useSelectContext,
    type SelectProps,
    type SelectRootProps,
    type SelectSingleProps,
    type SelectMultipleProps,
    type SelectItem,
    type SelectContextValue
} from "@/react/select";
export { createSelect, type SelectOption, type SelectOptions, type SelectState, type SelectInstance } from "@/core/select";
export {
    ContextMenu,
    ContextMenuRoot,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuPanel,
    ContextMenuSearch,
    ContextMenuList,
    ContextMenuRow,
    useContextMenuContext,
    type ContextMenuProps,
    type ContextMenuRootProps,
    type ContextMenuTriggerProps,
    type ContextMenuContentProps,
    type ContextMenuItem,
    type ContextMenuNode,
    type ContextMenuContextValue
} from "@/react/context-menu";
export {
    CLIPBOARD_PREFIX,
    clipboardEntries,
    clipboardAction,
    clipboardHasText,
    inspectClipboardTarget,
    performClipboardAction,
    type ClipboardAction,
    type ClipboardTarget,
    type ClipboardMenuOptions,
    type ClipboardMenuLabels
} from "@/core/clipboard-menu";
export {
    createContextMenu,
    isAction,
    type ContextMenuEntry,
    type ContextMenuAction,
    type ContextMenuOptions,
    type ContextMenuState,
    type ContextMenuInstance
} from "@/core/context-menu";
export {
    SelectionList,
    useSelection,
    type SelectionListProps,
    type UseSelectionOptions,
    type UseSelectionResult,
    type SelectionRenderer,
    type SelectionRowRender,
    type MarqueeRect
} from "@/react/selection";
export {
    createSelection,
    DEFAULT_SELECTION_SHORTCUTS,
    type SelectionCommand,
    type SelectionCommandName,
    type SelectionCommandEvent,
    type SelectionShortcuts,
    type SelectionOptions,
    type SelectionState,
    type SelectionInstance
} from "@/core/selection";
export { parseShortcut, matchesShortcut, shortcutTokens, shortcutText, isApplePlatform, type Shortcut, type ShortcutSpec } from "@/core/keys";

export { Image, type ImageProps, type ImageItem, type ImageSource, type ImageLabels, type ImageMenuOptions, type ZoomOptions } from "@/react/image";
export { Video, type VideoProps, type VideoSource, type VideoTrack, type VideoControls, type VideoLabels } from "@/react/video";
