import Fuse from "fuse.js";
import "./docs-palette.css";
import "@enigmax/primitives/palette.css";
import { useEffect, useState } from "react";
import { SearchPalette } from "@enigmax/primitives/react/palette";

/**
 * The site's search, which is the component the site documents.
 *
 * The docs used to run a hand-written panel over the package's core. That was the right
 * trade while the palette was React-only and the panel worked - but a documentation site
 * that ships its own version of the thing it is selling is arguing against itself, and the
 * component now covers everything the hand-written one did. So this is it, Ctrl/Cmd+K and
 * all, with the docs index as its corpus.
 *
 * `client:idle` in the layout: the palette is not needed for the first paint, and a reader
 * who never presses the key never pays for it beyond the island's own request.
 */

export interface DocRecord {
    title: string;
    group: string;
    text: string;
    href: string;
}

export interface DocsPaletteProps {
    records: DocRecord[];
    /**
     * Left null on the page that DEMONSTRATES the palette, where the demo owns the shortcut -
     * two palettes fighting over Ctrl+K is a page where neither behaves.
     */
    shortcut?: string | null;
}

export function DocsPalette({ records, shortcut = "k" }: DocsPaletteProps) {
    const [open, setOpen] = useState(false);
    /** The demo's palette says so on the document, and this one stands down. */
    const [demoOnPage, setDemoOnPage] = useState(false);

    useEffect(() => {
        setDemoOnPage(Boolean(document.querySelector("[data-palette-demo]")));

        // The header and the mobile drawer already have their own search buttons; they open
        // this rather than getting a second trigger beside them.
        const openers = document.querySelectorAll<HTMLElement>("[data-search-open]");
        const onClick = (event: Event): void => {
            event.preventDefault();
            setOpen(true);
        };
        openers.forEach((el) => el.addEventListener("click", onClick));
        return () => openers.forEach((el) => el.removeEventListener("click", onClick));
    }, []);

    return (
        <SearchPalette<DocRecord>
            open={open}
            onOpenChange={setOpen}
            items={records}
            keys={["title", "text", "group"]}
            // Fuse here rather than the default subsequence ranking: the corpus is prose, so
            // a query is words rather than the initials of a command, and a typo in a word
            // should still land.
            fuse={Fuse}
            fuseOptions={{ threshold: 0.4, ignoreLocation: true, minMatchCharLength: 2 }}
            groupBy={(record) => record.group}
            labelOf={(record) => record.title}
            descriptionOf={(record) => record.text.slice(0, 120)}
            recentsKey="enigma:docs:recent"
            placeholder="Search the docs"
            shortcut={demoOnPage ? null : shortcut}
            trigger={null}
            onSelect={(record) => { window.location.href = record.href; }}
        />
    );
}
