"use client";

export { useMarquee, type UseMarqueeResult } from "@/react/use-marquee";
export { type MarqueeOptions, type MarqueeInstance, type MarqueeHover } from "@/core/marquee";
export { useInput, type UseInputResult } from "@/react/use-input";
export { useSearch, type UseSearchResult } from "@/react/use-search";
export { type InputOptions, type InputAction, type InputIcon } from "@/core/input";
export { type SearchOptions, type SearchMatch, type FuseConstructor } from "@/core/search";
export { useButton, type UseButtonResult } from "@/react/use-button";
export { Button, type ButtonProps } from "@/react/button";
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
