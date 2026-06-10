/** Offset/line helpers shared by the lexer and the embedded-source extractors. */

/** Offsets at which each line begins, used to map an offset back to a 1-based line number. */
export function computeLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    return starts;
}

/** The 1-based line containing the given offset. */
export function lineOf(offset: number, starts: number[]): number {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1;
}
