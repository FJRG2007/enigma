/**
 * Universal compression entry point. Detects the content type, routes to the
 * matching compressor, and - when the result is lossy - caches the original in CCR
 * and appends a retrieval marker so nothing is permanently lost. Returns the
 * compressed text plus a token-savings report.
 *
 * Routing: JSON -> SmartCrusher, logs -> template collapse, plain text -> head+tail
 * truncation. Code, diffs and markdown pass through unchanged (no safe lossy
 * transform without a parser). Small inputs pass through untouched.
 */

import { detect } from "./detect";
import type { ContentType } from "./detect";
import { crushJson } from "./crusher";
import { crushLogs } from "./logs";
import { crushText } from "./text";
import { estimateTokens } from "./tokens";
import { ccrMarker, recordStats, retrieve, store } from "./ccr";

export type { ContentType } from "./detect";
export type { CcrStats, HistoryPoint } from "./ccr";
export { retrieve, readStats, readHistory } from "./ccr";

const MIN_LENGTH = 100;

export interface CompressOptions {
    /** Force a content type instead of detecting it. */
    type?: ContentType;
    /** Skip recording cumulative stats (used by read-only callers/tests). */
    noStats?: boolean;
}

export interface CompressResult {
    compressed: string;
    contentType: ContentType;
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    ratio: number;          // tokensAfter / tokensBefore (1 = no change)
    offloaded: number;      // rows/spans dropped (recoverable via ccrHash)
    ccrHash?: string;       // retrieval key when the result is lossy
}

/** Compress `content`, returning the result, savings and a CCR handle when lossy. */
export function compress(content: string, opts: CompressOptions = {}): CompressResult {
    const tokensBefore = estimateTokens(content);
    const passthrough = (type: ContentType): CompressResult => ({
        compressed: content, contentType: type, tokensBefore, tokensAfter: tokensBefore,
        tokensSaved: 0, ratio: 1, offloaded: 0,
    });

    if (!content || content.length < MIN_LENGTH) return passthrough("unknown");
    const type = opts.type ?? detect(content).type;

    let compressed = content;
    let offloaded = 0;
    if (type === "json") ({ compressed, offloaded } = crushJson(content));
    else if (type === "log") ({ compressed, offloaded } = crushLogs(content));
    else if (type === "text") ({ compressed, offloaded } = crushText(content));
    // code / diff / markdown / unknown: pass through (no safe lossy transform).

    if (offloaded === 0 || compressed === content) {
        const r = passthrough(type);
        if (!opts.noStats) recordStats(tokensBefore, tokensBefore);
        return r;
    }

    // Lossy: cache the original and tag the output so it can be retrieved.
    const ccrHash = store(content);
    compressed = `${compressed}\n${ccrMarker(ccrHash, offloaded)}`;
    const tokensAfter = estimateTokens(compressed);
    if (!opts.noStats) recordStats(tokensBefore, tokensAfter);
    return {
        compressed, contentType: type, tokensBefore, tokensAfter,
        tokensSaved: Math.max(0, tokensBefore - tokensAfter),
        ratio: tokensBefore ? tokensAfter / tokensBefore : 1,
        offloaded, ccrHash,
    };
}
