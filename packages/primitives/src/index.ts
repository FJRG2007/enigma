export { createMarquee, type MarqueeOptions, type MarqueeInstance, type MarqueeHover } from "@/core/marquee";
export { createInput, type InputOptions, type InputInstance, type InputAction, type InputIcon, type InputActionState } from "@/core/input";
export { createSearch, subsequenceMatcher, shortenQuery, type SearchOptions, type SearchInstance, type SearchMatch, type FuseConstructor, type FuseLike } from "@/core/search";
export { createButton, type ButtonOptions, type ButtonInstance, type ButtonState, type ButtonElement, type ButtonCooldown } from "@/core/button";
export { INPUT_ICON_PATHS, iconMarkup } from "@/core/input";
export {
    generatePassword,
    estimatePasswordStrength,
    type GeneratePasswordOptions,
    type PasswordAlphabet,
    type EstimateOptions,
    type PasswordStrengthReport,
    type PasswordScore
} from "@/core/password";
// The colour maths behind `<Input type="color">`. The picker is React, the conversions are
// not, so a vanilla page drawing its own square has the same parser and the same hue rule.
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
export { createNotifications, type Notifications, type Notification, type NotificationInput, type NotificationTone, type NotificationAction, type NotificationsOptions, type PromiseMessages } from "@/core/notifications";
export { createNetworkMonitor, SERVER_NETWORK_STATE, type NetworkState, type NetworkMonitor } from "@/core/network";
export {
    relativeTimeView,
    relativeTimeAttributes,
    normalizeDate,
    ensureZone,
    parseDuration,
    type RelativeTimeView,
    type RelativeTimeOptions,
    type RelativeTimeFormat,
    type RelativeTimeTense,
    type RelativeTimePrecision,
    type RelativeTimeStyle
} from "@/core/relative-time";
export {
    flagSrc,
    flagView,
    flagAttributes,
    flagName,
    normalizeFlagCode,
    configureFlags,
    flagConfig,
    resetFlagConfig,
    FLAG_RATIO,
    FLAG_CDN,
    type FlagOptions,
    type FlagConfig,
    type FlagView,
    type FlagShape,
    type FlagFormat,
    type FlagSource
} from "@/core/flags";
// The palette's non-rendering half: no framework anywhere near it, so a vanilla or Astro
// page can run the same keyboard arithmetic, grouping and history the React palette does.
export {
    createRecentStore,
    recentKey,
    groupRows,
    moveActive,
    shortcutLabel,
    isPaletteShortcut,
    type RecentEntry,
    type RecentStore,
    type RecentStoreOptions,
    type RowGroup,
    type PositionedRow,
    type PaletteKey
} from "@/core/palette";
// The select's non-rendering half, for the same reason as the palette's: the selection
// rules, the filter and the highlight are arithmetic, not React.
export {
    createSelect,
    SELECT_SEARCH_KEYS,
    type SelectOption,
    type SelectOptions,
    type SelectInstance,
    type SelectState,
    type SelectMoveKey
} from "@/core/select";
// The context menu's non-rendering half: the tree, the highlight, the filter and the cache
// of a fetched submenu are arithmetic, so a renderer that is not React only has to draw.
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
// Copy, Cut and Paste for a menu, and the DOM questions behind them: what is selected,
// whether it can be written to, and how text goes back in without breaking undo.
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

// The selection model, for the same reason: what a Ctrl+click does to a set is not React.
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
// Shortcuts as data, shared by the two above: the menu PRINTS what the list LISTENS for, and
// a menu whose label says Ctrl+A over a list bound to Cmd+A is the defect that splitting them
// produces.
export {
    parseShortcut,
    matchesShortcut,
    shortcutTokens,
    shortcutText,
    shortcutList,
    isApplePlatform,
    typeaheadStep,
    TYPEAHEAD_MS,
    type Shortcut,
    type ShortcutSpec,
    type ShortcutEvent,
    type TypeaheadState,
    type TypeaheadStep
} from "@/core/keys";
