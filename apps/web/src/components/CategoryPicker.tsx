import { useState } from "react";
import { Select } from "@enigmax/primitives/react/select";

interface Props {
    /** Category name to how many icons are filed under it. */
    counts: Record<string, number>;
    total: number;
}

/**
 * The category filter for the icon grid.
 *
 * A React island for ONE control on an otherwise static page. The grid is 391 glyphs
 * rendered at build time and must not be re-rendered in the browser - hydrating it would
 * ship every drawing a second time as JavaScript - so only the picker hydrates.
 *
 * It reports through a DOM event rather than a prop because the code that owns the grid is
 * the page's own script, not a React tree. That is the same split the docs palette uses:
 * take the primitive where the control is genuinely a control, and leave the page alone.
 */
export function CategoryPicker({ counts, total }: Props) {
    const [value, setValue] = useState("");

    const options = [
        { value: "", label: "All categories", description: `${total}` },
        ...Object.keys(counts).sort().map((category) => ({
            value: category,
            label: category,
            description: `${counts[category]}`,
        })),
    ];

    return (
        <Select
            options={options}
            value={value}
            onValueChange={(next) => {
                const chosen = next as string;
                setValue(chosen);
                document.dispatchEvent(new CustomEvent("icons:category", { detail: chosen }));
            }}
            searchable="auto"
            placeholder="All categories"
            triggerProps={{ "aria-label": "Filter icons by category" }}
        />
    );
}
