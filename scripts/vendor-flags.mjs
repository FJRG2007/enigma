/**
 * Vendor the flag artwork into enigma, so nothing enigma ships points at somebody else's
 * repository at runtime.
 *
 * The `flags` primitive serves its images from THIS repo through jsDelivr, and the CLI's
 * `--flags local` downloads from the same place. That is the whole reason this script
 * exists: a component whose default source is a third party is a component that breaks when
 * the third party moves, renames a branch, or goes away - and enigma cannot promise anything
 * about a URL it does not control.
 *
 * Upstream is named HERE and only here, which is the same arrangement `vendor-skills.mjs`
 * has: the provenance belongs in the script that fetched the files and in the NOTICE beside
 * them (both sets are MIT, which requires the copyright notice to travel with the copies),
 * not in the API, the docs or the URLs.
 *
 *   node scripts/vendor-flags.mjs            refresh every set
 *   node scripts/vendor-flags.mjs --check    report what would change, write nothing
 *
 * The output tree is the same shape the primitive reads and the downloader writes:
 *
 *   assets/flags/rect/<code>.svg      4:3
 *   assets/flags/square/<code>.svg    1:1
 *   assets/flags/circle/<code>.svg    round
 *   assets/flags/index.json           the codes each set publishes, so nothing has to ask
 *                                     an API at runtime to know what exists
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "flags");

/** Where the artwork comes from, pinned. Bump deliberately, never automatically. */
const SOURCES = {
    rect: {
        index: "https://data.jsdelivr.com/v1/packages/npm/flag-icons@7.5.0?structure=flat",
        dir: "/flags/4x3/",
        file: (code) => `https://cdn.jsdelivr.net/npm/flag-icons@7.5.0/flags/4x3/${code}.svg`
    },
    square: {
        index: "https://data.jsdelivr.com/v1/packages/npm/flag-icons@7.5.0?structure=flat",
        dir: "/flags/1x1/",
        file: (code) => `https://cdn.jsdelivr.net/npm/flag-icons@7.5.0/flags/1x1/${code}.svg`
    },
    circle: {
        index: "https://data.jsdelivr.com/v1/packages/gh/HatScripts/circle-flags@gh-pages?structure=flat",
        dir: "/flags/",
        file: (code) => `https://cdn.jsdelivr.net/gh/HatScripts/circle-flags@gh-pages/flags/${code}.svg`
    }
};

/** The licences that must travel with the copies. */
const LICENCES = [
    { name: "Rectangular and square sets", url: "https://raw.githubusercontent.com/lipis/flag-icons/main/LICENSE" },
    { name: "Circular set", url: "https://raw.githubusercontent.com/HatScripts/circle-flags/gh-pages/LICENSE" }
];

const check = process.argv.includes("--check");

async function text(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} from ${url}`);
    return response.text();
}

async function codesFor(shape) {
    const source = SOURCES[shape];
    const body = JSON.parse(await text(source.index));
    return (body.files ?? [])
        .map((file) => file.name ?? "")
        .filter((name) => name.startsWith(source.dir) && name.endsWith(".svg"))
        .map((name) => name.slice(source.dir.length, -".svg".length))
        .filter((code) => code && !code.includes("/"))
        .sort();
}

/** A fixed pool, not a thousand parallel fetches: that is how a vendor run gets rate-limited. */
async function pooled(jobs, size, run) {
    let cursor = 0;
    let done = 0;
    await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
        while (cursor < jobs.length) {
            const job = jobs[cursor++];
            await run(job);
            done++;
            if (done % 200 === 0) console.log(`  ${done}/${jobs.length}`);
        }
    }));
}

const index = {};
let written = 0;
let unchanged = 0;
let bytes = 0;

for (const shape of Object.keys(SOURCES)) {
    const codes = await codesFor(shape);
    index[shape] = codes;
    console.log(`${shape}: ${codes.length} flags`);
    if (check) continue;

    const dir = join(OUT, shape);
    mkdirSync(dir, { recursive: true });
    await pooled(codes, 12, async (code) => {
        const svg = await text(SOURCES[shape].file(code));
        const path = join(dir, `${code}.svg`);
        // Compared before writing, so a refresh that changes nothing leaves the tree - and
        // the diff - untouched.
        if (existsSync(path) && readFileSync(path, "utf8") === svg) {
            unchanged++;
            return;
        }
        writeFileSync(path, svg);
        written++;
        bytes += Buffer.byteLength(svg);
    });

    // A file upstream removed must go, or the index and the tree disagree.
    const keep = new Set(codes.map((code) => `${code}.svg`));
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
        if (!keep.has(name)) rmSync(join(dir, name));
    }
}

if (check) {
    console.log("check only: nothing written.");
} else {
    writeFileSync(join(OUT, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

    const notices = await Promise.all(LICENCES.map(async (licence) => {
        const body = await text(licence.url).catch(() => "");
        return `${licence.name}\n${"-".repeat(licence.name.length)}\n\n${body.trim()}\n`;
    }));
    const notice = [
        "The flag artwork in this directory is redistributed under the licences below.",
        "Refresh it with: node scripts/vendor-flags.mjs",
        "",
        notices.join("\n")
    ].join("\n");
    writeFileSync(join(OUT, "NOTICE"), notice);

    console.log(`vendor-flags: ${written} written, ${unchanged} unchanged, ${(bytes / 1048576).toFixed(1)} MB fetched.`);
}
