/**
 * Search with Fuse.js already wired: the batteries-included entry point.
 *
 * `@enigmax/primitives` stays dependency-free, so someone who only wants the marquee
 * never pulls a search engine into their bundle. Importing THIS subpath is the explicit
 * opt-in, and it is what `enigma add search` sets a project up for - it installs fuse.js
 * alongside the package.
 *
 * Everything else is identical to `createSearch` from the main entry: pass `fuseOptions`
 * to configure Fuse, or `matcher` to replace it outright.
 */

import Fuse from "fuse.js";
import { createSearch as createBaseSearch, type SearchOptions, type SearchInstance } from "@/core/search";

export type { SearchOptions, SearchInstance, SearchMatch } from "@/core/search";

/**
 * Search as you type, fuzzy by default.
 *
 * ```js
 * import { createSearch } from "@enigmax/primitives/search";
 *
 * const search = createSearch({ items: docs, keys: ["title", "body"] });
 * ```
 *
 * Pass `fuse: undefined` explicitly to fall back to the built-in substring matcher.
 */
export function createSearch<T>(options: SearchOptions<T> = {}): SearchInstance<T> {
    return createBaseSearch<T>({
        // A caller-supplied `fuse` or `matcher` still wins; this only fills the blank.
        fuse: Fuse as never,
        ...options
    });
}
