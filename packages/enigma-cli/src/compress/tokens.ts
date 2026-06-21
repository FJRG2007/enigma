/**
 * Token estimation. A tokenizer-free heuristic (~4 characters per token) good
 * enough to drive compression decisions and report savings without pulling in a
 * tokenizer dependency - enigma ships zero runtime deps. Deliberately
 * conservative: it never under-counts so badly that a savings claim misleads.
 */

/** Estimate the token count of `text` (~4 chars/token, whitespace-aware). */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}
