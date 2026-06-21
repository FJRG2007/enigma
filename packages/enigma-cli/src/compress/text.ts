/**
 * Generic text truncation for content with no exploitable structure (plain prose,
 * search-result blobs). Keeps the head and tail - where the answer and the
 * conclusion usually live - and elides the middle, noting how much was dropped.
 * Lossy but reversible via CCR (see index.ts). Used only for "text"; code, diffs
 * and markdown pass through untouched (truncating them blindly would corrupt them).
 */

export interface TextOptions {
    /** Fraction of the original length to retain (split head/tail). */
    ratio: number;
    /** Don't bother below this length. */
    minLength: number;
}

export const TEXT_DEFAULTS: TextOptions = { ratio: 0.3, minLength: 400 };

/** Truncate `content` keeping head+tail; returns the result and whether it changed. */
export function crushText(content: string, opts: TextOptions = TEXT_DEFAULTS): { compressed: string; offloaded: number } {
    const target = Math.floor(content.length * opts.ratio);
    if (content.length <= opts.minLength || content.length <= target) return { compressed: content, offloaded: 0 };
    const keepStart = Math.floor((target * 2) / 3);
    const keepEnd = target - keepStart;
    const dropped = content.length - keepStart - keepEnd;
    const head = content.slice(0, keepStart);
    const tail = keepEnd > 0 ? content.slice(content.length - keepEnd) : "";
    return { compressed: `${head}\n...[${dropped} chars elided]...\n${tail}`, offloaded: dropped };
}
