export { createMarquee, type MarqueeOptions, type MarqueeInstance, type MarqueeHover } from "@/core/marquee";
export { createInput, type InputOptions, type InputInstance, type InputAction, type InputIcon, type InputActionState } from "@/core/input";
export { createSearch, subsequenceMatcher, type SearchOptions, type SearchInstance, type SearchMatch, type FuseConstructor, type FuseLike } from "@/core/search";
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
