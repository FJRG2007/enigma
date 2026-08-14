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
export {
    Input,
    PasswordStrength,
    type InputProps,
    type PasswordStrengthProps,
    type FieldAction,
    type BreachChecker,
    type BreachState,
    type BreachStatus
} from "@/react/input";
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
