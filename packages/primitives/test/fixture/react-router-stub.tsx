import type { ReactNode } from "react";

/**
 * Stands in for react-router's `Link` while the fixture is bundled, so the entry can be
 * exercised end to end without a router in a Playwright page. It marks itself and echoes
 * the `to` it was given, which is what proves the href/to translation happened.
 */
export function Link({ to, children, ...rest }: { to?: string; children?: ReactNode; }) {
    return <a href={to} data-router-to={to} {...rest}>{children}</a>;
}
