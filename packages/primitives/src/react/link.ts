"use client";

import type { ElementType } from "react";

/**
 * The component every `href` in this package renders through.
 *
 * The package cannot `import Link from "next/link"`. It is framework-agnostic and Next is
 * not a dependency, so that import would fail to resolve for every consumer who is not on
 * Next - a hard build error in Vite, Astro, Remix and plain React.
 *
 * So it is registered instead, ONCE, and after that an href is a router link everywhere:
 *
 * ```tsx
 * // app/providers.tsx, or wherever your app starts
 * import Link from "next/link";
 * import { setLinkComponent } from "@enigmax/primitives/react";
 *
 * setLinkComponent(Link);
 * ```
 *
 * ```tsx
 * // and from then on, every call site
 * <Button href="/settings">Settings</Button>
 * ```
 *
 * Without it an href renders a plain `<a>`, which is correct everywhere and merely means a
 * full page load under a router. Any router works the same way - react-router's `Link`,
 * TanStack Router's, Astro has none to register.
 *
 * A module-level value rather than a context: it is one component reference for the whole
 * app, identical on every request, so threading a provider through the tree would buy
 * nothing and cost every consumer a wrapper.
 */
let linkComponent: ElementType | null = null;

/** Register the router's link. Pass null to go back to a plain anchor. */
export function setLinkComponent(component: ElementType | null): void {
    linkComponent = component;
}

/** What an href should render as right now. */
export function getLinkComponent(): ElementType {
    return linkComponent ?? "a";
}
