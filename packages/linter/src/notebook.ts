/**
 * Jupyter notebook (`.ipynb`) extraction: pull the Python source out of code cells and map every
 * extracted line back to its physical line in the JSON file, so violations point where the user
 * can act on them. Markdown/raw cells and cell outputs are ignored - only executable code is linted.
 */

import type { EmbeddedBlock } from "./types";
import { lineOf, computeLineStarts } from "./lines";

/** A cell's `source` is either one string or an array of line strings (each usually ending in "\n"). */
function cellSource(source: unknown): string {
    if (Array.isArray(source)) return source.join("");
    if (typeof source === "string") return source;
    return "";
}

/**
 * Extract one block per code cell. The notebook language is taken from `metadata.kernelspec`/
 * `language_info`; only Python notebooks are linted (others would misfire the Python lexer).
 */
export function extractNotebookBlocks(text: string): EmbeddedBlock[] {
    let notebook: { cells?: unknown[]; metadata?: { kernelspec?: { language?: string; }; language_info?: { name?: string; }; }; };
    try { notebook = JSON.parse(text); } catch { return []; }
    if (!notebook || !Array.isArray(notebook.cells)) return [];
    if (!isPython(notebook)) return [];

    const lineStarts = computeLineStarts(text);
    const blocks: EmbeddedBlock[] = [];
    let searchPos = 0;

    for (const cell of notebook.cells) {
        if (!cell || typeof cell !== "object") continue;
        const record = cell as { cell_type?: unknown; source?: unknown; };
        if (record.cell_type !== "code") continue;

        const source = cellSource(record.source);
        if (!source.trim()) continue;

        const cellLines = source.split("\n");
        const lineMap: number[] = [];
        for (const line of cellLines) {
            // The line's escaped content appears in the JSON exactly as JSON.stringify produces it.
            // A forward-only search keeps cells and lines in order even when content repeats.
            const needle = JSON.stringify(line).slice(1, -1);
            const at = needle ? text.indexOf(needle, searchPos) : -1;
            if (at >= 0) {
                lineMap.push(lineOf(at, lineStarts));
                searchPos = at + needle.length;
            } else {
                // Blank lines and unlocatable fragments inherit the previous mapped line.
                lineMap.push(lineMap.length ? lineMap[lineMap.length - 1]! : lineOf(searchPos, lineStarts));
            }
        }
        blocks.push({ language: "python", text: source, lineMap });
    }
    return blocks;
}

/** A notebook is treated as Python when its kernel/language metadata says so, or says nothing. */
function isPython(notebook: { metadata?: { kernelspec?: { language?: string; }; language_info?: { name?: string; }; }; }): boolean {
    const language = (notebook.metadata?.kernelspec?.language ?? notebook.metadata?.language_info?.name ?? "python").toLowerCase();
    return language.includes("python");
}
