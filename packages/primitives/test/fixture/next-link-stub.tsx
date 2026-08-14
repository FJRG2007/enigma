import type { ReactNode } from "react";

/**
 * Stands in for `next/link` while the fixture is bundled (esbuild `--alias`), so the Next
 * entry can be exercised end to end without pulling a Next runtime into a browser test.
 * It marks itself, which is how the test tells it apart from a plain anchor.
 */
export default function Link({ href, children, ...rest }: { href?: string; children?: ReactNode; }) {
    return <a href={href} data-next-link="" {...rest}>{children}</a>;
}
