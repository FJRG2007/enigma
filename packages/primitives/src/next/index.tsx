"use client";

import Link from "next/link";
import { forwardRef, createElement } from "react";
import { Button as BaseButton, type ButtonProps } from "@/react/button";

/**
 * The Next.js entry. Same components, wired to `next/link`.
 *
 * ```tsx
 * import { Button } from "@enigmax/primitives/next";
 *
 * <Button href="/settings">Settings</Button>   // renders next/link
 * ```
 *
 * The import path is the configuration. There is nothing to register and nothing to pass at
 * the call site, and a project that is not on Next never resolves this file - which is the
 * whole reason the main entry cannot simply `import Link from "next/link"` itself: that
 * import is a build error for every consumer on Vite, Astro, Remix or plain React.
 *
 * Everything else is re-exported unchanged, so this can be the only import path in a Next
 * app rather than a second one to remember.
 */

export const Button = forwardRef<HTMLElement, ButtonProps>(function Button(props, ref) {
    // Only an href makes it a link; a plain button must not be handed a router component.
    return createElement(BaseButton, { ...props, as: props.as ?? (props.href ? Link : undefined), ref });
});

// `export *` skips names this module exports itself, so the Button above is the one a
// consumer gets and everything else comes straight from the React entry.
export * from "@/react/index";
