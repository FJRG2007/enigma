/**
 * SmartCrusher - statistical compression of JSON arrays of homogeneous objects,
 * the highest-value path for tool outputs (search hits, rows, records). It keeps
 * a representative, schema-preserving subset and drops the redundant bulk:
 *
 *   1. Find arrays of objects (top level or nested one level under object keys).
 *   2. Decide if an array is crushable: redundant enough to sample, OR carrying
 *      signal (errors / anomalies / a score field) worth surfacing - but never a
 *      set of unique entities with no signal (that would lose real data).
 *   3. Build a keep-set: head+tail anchors, every error row, numeric anomalies
 *      (>2 sigma), structural outliers (rare field/value), deduped, then stride
 *      sampled up to a cap - preserving original order and the original values.
 *
 * The dropped rows are recoverable: index.ts caches the full original in CCR and
 * appends a retrieval marker. This module only decides what to keep; it adds no
 * summaries and never rewrites kept values.
 */

export interface CrushOptions {
    minItems: number;       // skip arrays shorter than this
    maxItems: number;       // cap on rows kept per crushed array
    firstFraction: number;  // share of maxItems reserved for the array head
    lastFraction: number;   // share of maxItems reserved for the array tail
    sigma: number;          // std-dev multiplier for numeric anomalies
}

export const CRUSH_DEFAULTS: CrushOptions = {
    minItems: 5, maxItems: 15, firstFraction: 0.3, lastFraction: 0.15, sigma: 2,
};

const ERROR_RE = /\b(error|errors|failed|failure|fail|exception|fatal|timeout|timed?.?out|denied|refused|panic|critical|unauthorized|invalid)\b/i;

type Json = unknown;
type Obj = Record<string, Json>;

interface FieldStat {
    type: "numeric" | "string" | "boolean" | "object" | "null";
    present: number;        // rows where the field is non-null/defined
    uniqueRatio: number;    // distinct values / total rows
    mean?: number;
    std?: number;
    anomalies?: Set<number>;// row indices > sigma from the mean
    bounded01?: boolean;    // numeric range matches a known score range
}

/** Crush every crushable array in `content`; returns the new JSON + rows dropped. */
export function crushJson(content: string, opts: CrushOptions = CRUSH_DEFAULTS): { compressed: string; offloaded: number } {
    let parsed: Json;
    try { parsed = JSON.parse(content); } catch { return { compressed: content, offloaded: 0 }; }
    let offloaded = 0;
    const transform = (value: Json): Json => {
        if (Array.isArray(value)) {
            const crushed = crushArray(value, opts);
            offloaded += crushed.offloaded;
            return crushed.rows;
        }
        if (value && typeof value === "object") {
            const out: Obj = {};
            for (const [k, v] of Object.entries(value as Obj)) out[k] = transform(v);
            return out;
        }
        return value;
    };
    const result = transform(parsed);
    if (offloaded === 0) return { compressed: content, offloaded: 0 };
    // Preserve the input's pretty/compact shape: minified in -> minified out.
    const pretty = /\n\s/.test(content);
    return { compressed: JSON.stringify(result, null, pretty ? 2 : undefined), offloaded };
}

/** Crush a single array if it is an analyzable, crushable array of objects. */
function crushArray(arr: Json[], opts: CrushOptions): { rows: Json[]; offloaded: number } {
    if (arr.length < opts.minItems || !arr.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) {
        return { rows: arr, offloaded: 0 };
    }
    const items = arr as Obj[];
    const stats = analyzeFields(items, opts);
    const errorRows = detectErrorRows(items);
    const outliers = structuralOutliers(items);
    const anomalies = new Set<number>();
    let hasScore = false;
    for (const s of stats.values()) {
        if (s.anomalies) for (const i of s.anomalies) anomalies.add(i);
        if (s.bounded01) hasScore = true;
    }
    const maxUniq = Math.max(0, ...[...stats.values()].map((s) => s.uniqueRatio));
    const hasIdField = [...stats.values()].some((s) => s.uniqueRatio >= 0.9);
    const hasSignal = errorRows.size > 0 || anomalies.size > 0 || outliers.size > 0 || hasScore;

    // Crushability gate. Redundant arrays are always crushable; otherwise we need a
    // signal worth surfacing. Unique entities with no signal are left intact (safety).
    const crushable = maxUniq < 0.3 || (hasSignal && !(maxUniq > 0.8 && hasIdField && !hasSignal));
    if (!crushable) return { rows: arr, offloaded: 0 };

    const keep = new Set<number>();
    const headN = Math.max(1, Math.ceil(opts.maxItems * opts.firstFraction));
    const tailN = Math.max(1, Math.ceil(opts.maxItems * opts.lastFraction));
    for (let i = 0; i < headN && i < items.length; i++) keep.add(i);
    for (let i = Math.max(0, items.length - tailN); i < items.length; i++) keep.add(i);
    for (const i of errorRows) keep.add(i);
    for (const i of anomalies) keep.add(i);
    for (const i of outliers) keep.add(i);

    // Fill remaining budget with stride samples, skipping content duplicates.
    const seen = new Set<string>();
    for (const i of keep) seen.add(JSON.stringify(items[i]));
    if (keep.size < opts.maxItems) {
        const stride = Math.max(1, Math.floor(items.length / opts.maxItems));
        for (let i = 0; i < items.length && keep.size < opts.maxItems; i += stride) {
            if (keep.has(i)) continue;
            const sig = JSON.stringify(items[i]);
            if (seen.has(sig)) continue;
            seen.add(sig);
            keep.add(i);
        }
    }

    if (keep.size >= items.length) return { rows: arr, offloaded: 0 };
    const ordered = [...keep].sort((a, b) => a - b);
    return { rows: ordered.map((i) => items[i]), offloaded: items.length - ordered.length };
}

/** Per-field type, uniqueness and numeric-anomaly analysis across all rows. */
function analyzeFields(items: Obj[], opts: CrushOptions): Map<string, FieldStat> {
    const keys = new Set<string>();
    for (const it of items) for (const k of Object.keys(it)) keys.add(k);
    const stats = new Map<string, FieldStat>();
    for (const key of keys) {
        const values = items.map((it) => it[key]);
        const present = values.filter((v) => v !== undefined && v !== null);
        const uniq = new Set(present.map((v) => JSON.stringify(v))).size;
        const first = present[0];
        const type: FieldStat["type"] = typeof first === "number" ? "numeric"
            : typeof first === "boolean" ? "boolean"
            : typeof first === "string" ? "string"
            : first && typeof first === "object" ? "object" : "null";
        const stat: FieldStat = {
            type, present: present.length,
            uniqueRatio: items.length ? uniq / items.length : 0,
        };
        if (type === "numeric") {
            const nums: { i: number; v: number }[] = [];
            values.forEach((v, i) => { if (typeof v === "number" && Number.isFinite(v)) nums.push({ i, v }); });
            if (nums.length >= 2) {
                const mean = nums.reduce((s, n) => s + n.v, 0) / nums.length;
                const variance = nums.reduce((s, n) => s + (n.v - mean) ** 2, 0) / (nums.length - 1);
                const std = Math.sqrt(variance);
                stat.mean = mean; stat.std = std;
                if (std > 0) {
                    stat.anomalies = new Set(nums.filter((n) => Math.abs(n.v - mean) > opts.sigma * std).map((n) => n.i));
                }
                const min = Math.min(...nums.map((n) => n.v));
                const max = Math.max(...nums.map((n) => n.v));
                stat.bounded01 = isScoreRange(min, max);
            }
        }
        stats.set(key, stat);
    }
    return stats;
}

/** True when a numeric range matches a recognizable score range (0..1, 0..100, -1..1). */
function isScoreRange(min: number, max: number): boolean {
    const within = (lo: number, hi: number) => min >= lo && max <= hi && max > lo;
    return within(0, 1) || within(0, 10) || within(0, 100) || within(-1, 1);
}

/** Row indices whose any string value reads like an error/failure. */
function detectErrorRows(items: Obj[]): Set<number> {
    const rows = new Set<number>();
    items.forEach((it, i) => {
        for (const v of Object.values(it)) {
            if (typeof v === "string" && ERROR_RE.test(v)) { rows.add(i); break; }
        }
    });
    return rows;
}

/**
 * Row indices that are structurally unusual: they carry a field present in <20% of
 * rows, or a rare value of a low-cardinality categorical field. These are the rows
 * worth keeping verbatim because they break the dominant pattern.
 */
function structuralOutliers(items: Obj[]): Set<number> {
    const n = items.length;
    const fieldCount = new Map<string, number>();
    for (const it of items) for (const k of Object.keys(it)) fieldCount.set(k, (fieldCount.get(k) ?? 0) + 1);
    const rareFields = new Set([...fieldCount].filter(([, c]) => c / n < 0.2).map(([k]) => k));

    // Per-field categorical value counts, only for low-cardinality string/bool fields.
    const valueCounts = new Map<string, Map<string, number>>();
    for (const [k] of fieldCount) {
        const counts = new Map<string, number>();
        for (const it of items) {
            const v = it[k];
            if (typeof v === "string" || typeof v === "boolean") counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
        }
        if (counts.size >= 2 && counts.size <= 50) valueCounts.set(k, counts);
    }

    const out = new Set<number>();
    items.forEach((it, i) => {
        for (const k of Object.keys(it)) {
            if (rareFields.has(k)) { out.add(i); return; }
            const counts = valueCounts.get(k);
            const v = it[k];
            if (counts && (typeof v === "string" || typeof v === "boolean") && (counts.get(String(v)) ?? 0) / n < 0.05) {
                out.add(i); return;
            }
        }
    });
    return out;
}
