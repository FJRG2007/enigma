/**
 * Downloading a flag set into a project, for the `flags` primitive.
 *
 * The primitive already serves its images from enigma over a CDN and needs none of this.
 * This exists for the project that will not make a third-party request at runtime - an
 * offline install, an air-gapped deployment, a CSP with no `img-src` for a CDN, or simply a
 * build that must not break the day a CDN does. It writes the same layout the primitive
 * reads for a local source:
 *
 *     <out>/rect/es.svg      4:3
 *     <out>/square/es.svg    1:1
 *     <out>/circle/es.svg    round
 *
 * The artwork is stored as SVG, so png/webp are RASTERISED here rather than fetched. That
 * needs `sharp`, which is resolved from the project and never installed behind the user's
 * back: without it the SVGs are still written and the shortfall is reported, because a
 * silent half of what was asked for is the worst outcome.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

export type FlagShape = "rect" | "square" | "circle";
export type FlagFormat = "svg" | "png" | "webp";

export const FLAG_SHAPES: FlagShape[] = ["rect", "square", "circle"];
export const FLAG_FORMATS: FlagFormat[] = ["svg", "png", "webp"];

/** enigma's own artwork, the same base the primitive builds its URLs from. */
const FLAG_CDN = "https://cdn.jsdelivr.net/gh/FJRG2007/enigma@main/assets/flags";

/** Width in px a rasterised flag is written at. Height follows the shape's ratio. */
const RASTER_WIDTH = 160;

function fileUrl(shape: FlagShape, code: string): string {
    return `${FLAG_CDN}/${shape}/${code}.svg`;
}

const listings = new Map<FlagShape, string[]>();

/**
 * Every code a shape publishes, read from the index shipped beside the artwork.
 *
 * An index file rather than a hardcoded list here: a country set in the source goes stale
 * the first time a subdivision is added, and a stale list is invisible - the download simply
 * never fetches the flag nobody noticed was missing. One request answers for every shape.
 */
export async function listFlagCodes(shape: FlagShape): Promise<string[]> {
    const cached = listings.get(shape);
    if (cached) return cached;

    const response = await fetch(`${FLAG_CDN}/index.json`);
    if (!response.ok) throw new Error(`Could not read the flag index (${response.status}).`);
    const index = await response.json() as Partial<Record<FlagShape, string[]>>;
    for (const [name, codes] of Object.entries(index)) {
        if (Array.isArray(codes)) listings.set(name as FlagShape, codes);
    }
    return listings.get(shape) ?? [];
}

export interface FlagDownloadOptions {
    shapes: FlagShape[];
    /** `"all"` or the codes to fetch. Unknown codes are reported, never invented. */
    codes: string[] | "all";
    formats: FlagFormat[];
    /** Directory the `<shape>/<code>.<format>` tree is written under. */
    outDir: string;
    /** Project the rasteriser is resolved from. Defaults to the current directory. */
    projectDir?: string;
    /** Replace files that are already there. Off by default. */
    overwrite?: boolean;
    concurrency?: number;
}

export interface FlagDownloadResult {
    written: string[];
    skipped: number;
    /** Codes asked for that the set does not publish. */
    unknown: string[];
    failed: string[];
    /** Formats asked for that could not be produced because no rasteriser was available. */
    missingRaster: FlagFormat[];
    bytes: number;
}

/** sharp, resolved from the PROJECT rather than from the CLI, or null. */
async function loadRasteriser(projectDir: string): Promise<{ convert: (svg: Buffer, format: "png" | "webp") => Promise<Buffer>; } | null> {
    try {
        const resolver = createRequire(join(projectDir, "package.json"));
        const sharp = (await import(pathToFileURL(resolver.resolve("sharp")).href)).default as (input: Buffer, options?: unknown) => {
            resize: (options: { width: number; }) => { toFormat: (format: string) => { toBuffer: () => Promise<Buffer>; }; };
        };
        return {
            convert: (svg, format) => sharp(svg, { density: 384 }).resize({ width: RASTER_WIDTH }).toFormat(format).toBuffer()
        };
    } catch {
        return null;
    }
}

/** Fetch one URL as bytes, with a single retry: a CDN hiccup over 1,000 files is routine. */
async function fetchBytes(url: string): Promise<Buffer | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) return Buffer.from(await response.arrayBuffer());
            // 404 is an answer, not a hiccup: the file is not there and a retry cannot help.
            if (response.status === 404) return null;
        } catch {
            // Network error: fall through to the retry.
        }
    }
    return null;
}

/**
 * Download the requested shapes into `outDir`.
 *
 * `onProgress` is called per file so a CLI can render a counter; a set of 1,000 files over
 * a slow link is otherwise a minute of silence.
 */
export async function downloadFlags(options: FlagDownloadOptions, onProgress?: (done: number, total: number) => void): Promise<FlagDownloadResult> {
    const { shapes, codes, formats, outDir, projectDir = process.cwd(), overwrite = false, concurrency = 12 } = options;
    const result: FlagDownloadResult = { written: [], skipped: 0, unknown: [], failed: [], missingRaster: [], bytes: 0 };

    const raster = formats.filter((format): format is "png" | "webp" => format !== "svg");
    const rasteriser = raster.length ? await loadRasteriser(projectDir) : null;
    if (raster.length && !rasteriser) result.missingRaster = raster;

    // What can actually be written. With no rasteriser and nothing but raster formats asked
    // for, that leaves NOTHING - so it falls back to SVG rather than downloading zero files
    // and reporting a shortfall against a set that was never written. The caller reports
    // both: what landed, and which formats it could not produce.
    const usable = formats.filter((format) => format === "svg" || rasteriser);
    const writable = usable.length ? usable : ["svg" as FlagFormat];

    // The full job first, so the progress total is real rather than a guess that grows.
    const jobs: { shape: FlagShape; code: string; }[] = [];
    for (const shape of shapes) {
        const published = await listFlagCodes(shape);
        if (codes === "all") {
            for (const code of published) jobs.push({ shape, code });
            continue;
        }
        const set = new Set(published);
        for (const code of codes) {
            if (set.has(code)) jobs.push({ shape, code });
            else if (!result.unknown.includes(code)) result.unknown.push(code);
        }
    }

    let done = 0;
    const writeOne = async (job: { shape: FlagShape; code: string; }): Promise<void> => {
        const dir = join(outDir, job.shape);
        const missing = writable.filter((format) => overwrite || !existsSync(join(dir, `${job.code}.${format}`)));
        if (!missing.length) {
            result.skipped += writable.length;
            return;
        }

        const svg = await fetchBytes(fileUrl(job.shape, job.code));
        if (!svg) {
            result.failed.push(`${job.shape}/${job.code}`);
            return;
        }
        mkdirSync(dir, { recursive: true });
        for (const format of missing) {
            const path = join(dir, `${job.code}.${format}`);
            try {
                const bytes = format === "svg" ? svg : await rasteriser!.convert(svg, format);
                writeFileSync(path, bytes);
                result.written.push(path);
                result.bytes += bytes.byteLength;
            } catch {
                result.failed.push(`${job.shape}/${job.code}.${format}`);
            }
        }
    };

    // A fixed pool rather than one Promise.all over a thousand fetches, which opens a
    // thousand sockets and is how a download gets rate-limited into failing.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (cursor < jobs.length) {
            const job = jobs[cursor++];
            await writeOne(job);
            done++;
            onProgress?.(done, jobs.length);
        }
    });
    await Promise.all(workers);

    return result;
}
