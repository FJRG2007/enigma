"use client";

import { Link } from "react-router";
import { forwardRef, createElement } from "react";
import { Button as BaseButton, type ButtonProps } from "@/react/button";

/**
 * The React Router entry. Same components, wired to its `Link`.
 *
 * ```tsx
 * import { Button } from "@enigmax/primitives/react-router";
 *
 * <Button href="/settings">Settings</Button>   // client navigation
 * ```
 *
 * Same deal as the Next entry: the import path is the configuration, and a subpath is only
 * ever resolved by a project that HAS the router - which is what lets a framework-agnostic
 * package reference one at all.
 *
 * React Router names its target `to`, not `href`, so the prop is translated below. That
 * translation is the whole reason this is a file rather than a line in the docs.
 *
 * React Aria solves the same problem the other way, with a `RouterProvider` taking the
 * router's `navigate` (react-spectrum.adobe.com/react-aria/routing.html). One mechanism
 * covers every router and it always renders a real anchor, but it is still a line of setup
 * in the app. `setLinkComponent` is this package's version of that, for a router with no
 * entry of its own here.
 */

/** Bridges the two names, so a call site writes `href` whatever the router underneath is. */
const RouterLink = forwardRef<HTMLAnchorElement, { href?: string; }>(function RouterLink({ href = "", ...props }, ref) {
    return createElement(Link, { ...props, to: href, ref });
});

export const Button = forwardRef<HTMLElement, ButtonProps>(function Button(props, ref) {
    // Only an href makes it a link; a plain button must not be handed a router component.
    return createElement(BaseButton, { ...props, as: props.as ?? (props.href ? RouterLink : undefined), ref });
});

export * from "@/react/index";
