/**
 * ID, timestamp, and null-coercion helpers shared by the gate db CRUD modules.
 *
 * `newId` generates monotonic ULIDs (Crockford base32, 48-bit millisecond time +
 * 80-bit randomness) without an external dependency, mirroring no-mistakes' use
 * of `oklog/ulid` with `ulid.Monotonic`: IDs created within the same millisecond
 * are strictly increasing, so they stay lexicographically sortable by creation.
 */

import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MASK80 = (1n << 80n) - 1n;

let lastTime = -1;
let lastRand = 0n;

/** Returns a cryptographically random unsigned BigInt of the given bit width. */
function randomBigInt(bits: number): bigint {
    const bytes = randomBytes(Math.ceil(bits / 8));
    let value = 0n;
    for (const b of bytes) value = (value << 8n) | BigInt(b);
    return value & ((1n << BigInt(bits)) - 1n);
}

/** Encodes an unsigned integer into `length` Crockford base32 characters. */
function encodeBase32(value: bigint, length: number): string {
    let out = "";
    let v = value;
    for (let i = 0; i < length; i++) {
        out = CROCKFORD[Number(v & 31n)] + out;
        v >>= 5n;
    }
    return out;
}

/** Generates a new monotonic ULID string. */
export function newId(): string {
    const ms = Date.now();
    let stamp: number;
    if (ms > lastTime) {
        lastTime = ms;
        lastRand = randomBigInt(80);
        stamp = ms;
    } else {
        // Same millisecond (or a clock regression): keep the previous time and
        // advance the randomness so ordering remains strictly increasing.
        stamp = lastTime;
        lastRand = (lastRand + randomBigInt(16) + 1n) & MASK80;
    }
    return encodeBase32(BigInt(stamp), 10) + encodeBase32(lastRand, 16);
}

/** Returns the current unix timestamp in seconds. */
export function now(): number {
    return Math.floor(Date.now() / 1000);
}

/** Trims a string, returning null for an empty result so it stores as SQL NULL. */
export function nullableString(s: string): string | null {
    const t = s.trim();
    return t === "" ? null : t;
}
