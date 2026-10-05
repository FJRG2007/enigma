/**
 * A ZIP writer for the packaged `.skill` file: deflate (or store, when deflate does not
 * shrink the entry) with CRC-32, UTF-8 names, local headers, central directory and end
 * record, per the PKWARE APPNOTE. No ZIP64: a skill package is megabytes, so sizes past
 * 4 GiB are refused rather than written as a corrupt archive.
 */

import { deflateRawSync } from "node:zlib";
import { join, relative, sep } from "node:path";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time fields (local time, 2-second resolution, 1980 epoch). */
function dosDateTime(date: Date): { time: number; date: number; } {
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

export interface ZipEntry { name: string; data: Buffer; modified: Date; }

const LIMIT = 0xffffffff;

export function buildZip(entries: ZipEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name.split(sep).join("/"), "utf8");
        const deflated = deflateRawSync(entry.data, { level: 9 });
        const stored = deflated.length >= entry.data.length;
        const body = stored ? entry.data : deflated;
        if (entry.data.length >= LIMIT || offset + body.length >= LIMIT) throw new Error("archive exceeds 4 GiB; ZIP64 is not supported");
        const crc = crc32(entry.data);
        const { time, date } = dosDateTime(entry.modified);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(stored ? 0 : 8, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(stored ? 0 : 8, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    if (entries.length > 0xffff) throw new Error("too many entries for a non-ZIP64 archive");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...filesUnder(full));
        else if (entry.isFile()) out.push(full);
    }
    return out.sort();
}

/**
 * Zip every file under `sourceDir` (except `exclude`) into `outputPath`, each entry
 * prefixed with `prefix/` so the archive unpacks into one folder.
 */
export function zipDirectory(sourceDir: string, outputPath: string, prefix: string, exclude: (path: string) => boolean = () => false): void {
    const entries = filesUnder(sourceDir).filter((f) => !exclude(f)).map((f) => ({
        name: `${prefix}/${relative(sourceDir, f)}`,
        data: readFileSync(f),
        modified: statSync(f).mtime,
    }));
    writeFileSync(outputPath, buildZip(entries));
}
