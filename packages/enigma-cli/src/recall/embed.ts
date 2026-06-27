/**
 * Dependency-free text embedding for recall's vector half of hybrid search. There is no model
 * or network here: it is feature hashing (the "hashing trick") over word tokens AND character
 * trigrams, into a fixed-dimension L2-normalized vector. Two texts that share words or
 * morphology get a high cosine, so it adds fuzzy recall (typos, plural/stem variants, related
 * forms) on top of FTS's exact keyword matching.
 *
 * This is "semantic-lite", not true dense embeddings - real synonym/semantic matching needs a
 * model. `EmbeddingProvider` is the seam for that: a future provider (a local ONNX model or an
 * embeddings API) can replace `localEmbed` without touching the store or search. The local
 * embedder stays the zero-dep default.
 */

/** Embedding dimensionality. 256 floats = 1 KB/observation as a BLOB - cheap for a local store. */
export const EMBED_DIM = 256;

/** FNV-1a 32-bit hash with a seed, for the feature index and the sign bit. */
function fnv1a(text: string, seed: number): number {
    let h = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

/** Word tokens (>=2 chars) plus padded character trigrams of each word, capped for cost. */
function tokens(text: string): string[] {
    const words = (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 2).slice(0, 400);
    const out: string[] = [];
    for (const w of words) {
        out.push(w);
        const p = `#${w}#`;
        for (let i = 0; i + 3 <= p.length; i++) out.push(p.slice(i, i + 3));
    }
    return out;
}

/**
 * Embed text into an L2-normalized vector via signed feature hashing. Signed hashing (a second
 * hash decides +/-) makes collisions cancel on average instead of always inflating a bucket.
 * Returns a zero vector for empty input.
 */
export function localEmbed(text: string): Float32Array {
    const vec = new Float32Array(EMBED_DIM);
    for (const t of tokens(text)) {
        const idx = fnv1a(t, 0) % EMBED_DIM;
        const sign = (fnv1a(t, 0x9e3779b9) & 1) === 0 ? 1 : -1;
        vec[idx]! += sign;
    }
    let norm = 0;
    for (let i = 0; i < EMBED_DIM; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < EMBED_DIM; i++) vec[i]! /= norm;
    return vec;
}

/** Cosine similarity of two L2-normalized vectors (just the dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
    return dot;
}

/** A pluggable embedder, so a real provider can replace the local one later. */
export type EmbeddingProvider = (text: string) => Float32Array;

/** Pack a vector into a BLOB for SQLite storage. */
export function packVector(vec: Float32Array): Uint8Array {
    return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Unpack a BLOB back into a vector (copies, so the underlying buffer is independent). */
export function unpackVector(buf: Uint8Array): Float32Array {
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    return new Float32Array(copy.buffer);
}
