/**
 * The four decisions a file upload gets wrong, made once.
 *
 * 1. WHAT the file is comes from its bytes, never from its name or the Content-Type the
 *    uploader's browser claimed. `inspectUpload` reads the signature and refuses anything that
 *    is not on the caller's allowlist, or is too large, or is empty.
 * 2. WHERE it is stored is a name this code generates (`storageName`), never one the uploader
 *    typed, so `../../etc/x` and `index.html` are not names a file can have on disk.
 * 3. A path built from input stays under its root (`resolveInside`), or the call throws.
 * 4. HOW it is served back is decided by `downloadHeaders`: `nosniff` always, a sandboxing CSP
 *    so an HTML or SVG file opened on this origin cannot run script as the reader, and
 *    `attachment` unless the type is one a browser renders passively.
 *
 * SVG is deliberately not a raster image here: it is a document that can carry script. It is
 * recognised so it can be refused, or stored and only ever served as an attachment.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The types this module can recognise from their bytes. */
export type FileKind =
    | "png" | "jpeg" | "gif" | "webp" | "avif" | "pdf"
    | "mp4" | "webm" | "mp3" | "wav" | "ogg"
    | "zip" | "text" | "svg" | "html";

interface KindInfo {
    mime: string;
    extension: string;
    /** A browser renders it passively: no script, no navigation. Safe to serve inline. */
    inline: boolean;
}

export const FILE_KINDS: Readonly<Record<FileKind, KindInfo>> = {
    png: { mime: "image/png", extension: "png", inline: true },
    jpeg: { mime: "image/jpeg", extension: "jpg", inline: true },
    gif: { mime: "image/gif", extension: "gif", inline: true },
    webp: { mime: "image/webp", extension: "webp", inline: true },
    avif: { mime: "image/avif", extension: "avif", inline: true },
    pdf: { mime: "application/pdf", extension: "pdf", inline: true },
    mp4: { mime: "video/mp4", extension: "mp4", inline: true },
    webm: { mime: "video/webm", extension: "webm", inline: true },
    mp3: { mime: "audio/mpeg", extension: "mp3", inline: true },
    wav: { mime: "audio/wav", extension: "wav", inline: true },
    ogg: { mime: "audio/ogg", extension: "ogg", inline: true },
    zip: { mime: "application/zip", extension: "zip", inline: false },
    text: { mime: "text/plain; charset=utf-8", extension: "txt", inline: true },
    svg: { mime: "image/svg+xml", extension: "svg", inline: false },
    html: { mime: "text/html; charset=utf-8", extension: "html", inline: false }
};

export type UploadRefusal = "empty" | "too-large" | "unknown-type" | "type-not-allowed";

export class UploadRefusedError extends Error {
    readonly reason: UploadRefusal;

    constructor(reason: UploadRefusal, message: string) {
        super(message);
        this.name = "UploadRefusedError";
        this.reason = reason;
    }
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** How much of a text file is read to decide what it is. */
const TEXT_PROBE = 8192;

/** A first tag that makes a sniffing browser treat text as a document able to run script. */
const ACTIVE_MARKUP = /^<(?:!doctype\s+html|html|head|body|script|iframe|object|embed|math|meta|link|style|form|img|a|b|p|div|table|title|font|br|h1)\b/i;

function looksLikeText(bytes: Uint8Array): string | null {
    const probe = bytes.subarray(0, TEXT_PROBE);
    if (probe.includes(0)) return null;
    try {
        // `fatal` refuses invalid UTF-8; a probe cut mid-character is decoded in stream mode.
        return new TextDecoder("utf-8", { fatal: true }).decode(probe, { stream: probe.length < bytes.length });
    } catch {
        return null;
    }
}

/**
 * What the bytes are, or null when they match nothing in FILE_KINDS. Text is only "text" when
 * a sniffing browser would not render it as a document: an SVG, text that opens with an HTML
 * tag, or text with a `<script>` in it is reported as "svg"/"html" so an allowlist of "text"
 * cannot admit it.
 */
export function sniffFileType(bytes: Uint8Array): FileKind | null {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
    if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "gif";
    if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "webp";
    if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WAVE"), 8)) return "wav";
    if (startsWith(bytes, ascii("ftyp"), 4)) {
        const brand = String.fromCharCode(...bytes.subarray(8, 12));
        if (brand === "avif" || brand === "avis") return "avif";
        if (/^(?:isom|iso[2-9]|mp41|mp42|avc1|dash|M4V |MSNV)$/.test(brand)) return "mp4";
        return null;
    }
    if (startsWith(bytes, ascii("%PDF-"))) return "pdf";
    if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";
    if (startsWith(bytes, ascii("ID3")) || (bytes.length > 1 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "mp3";
    if (startsWith(bytes, ascii("OggS"))) return "ogg";
    if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return "zip";
    const text = looksLikeText(bytes);
    if (text === null) return null;
    const head = text.replace(/^﻿/, "").trimStart();
    if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+svg[^>]*>\s*)?<svg\b/i.test(head)) return "svg";
    // What a sniffing browser would render as HTML: markup at the start (the WHATWG sniffing
    // rule looks at the first tag), or a script element anywhere.
    const leading = head.replace(/^(?:<!--[\s\S]*?-->\s*)+/, "");
    if (/^</.test(leading) && ACTIVE_MARKUP.test(leading.slice(0, 64))) return "html";
    if (/<script\b/i.test(text)) return "html";
    return "text";
}

export interface InspectOptions {
    /** The kinds this upload accepts. Required: there is no safe default list. */
    allow: FileKind[];
    /** Largest accepted size in bytes. */
    maxBytes: number;
}

export interface InspectedUpload {
    kind: FileKind;
    /** The type to store and serve, from the bytes. Never the uploader's claim. */
    mime: string;
    extension: string;
}

/**
 * Accept or refuse an upload by what it IS. The declared name and type are not consulted at
 * all, so there is nothing for an uploader to lie about.
 *
 * @throws UploadRefusedError with a `reason` the caller can map to a message.
 */
export function inspectUpload(bytes: Uint8Array, options: InspectOptions): InspectedUpload {
    if (bytes.byteLength === 0) throw new UploadRefusedError("empty", "The file is empty.");
    if (bytes.byteLength > options.maxBytes) throw new UploadRefusedError("too-large", `The file is larger than ${options.maxBytes} bytes.`);
    const kind = sniffFileType(bytes);
    if (!kind) throw new UploadRefusedError("unknown-type", "The file's type could not be recognised.");
    if (!options.allow.includes(kind)) throw new UploadRefusedError("type-not-allowed", `A ${kind} file is not accepted here.`);
    const { mime, extension } = FILE_KINDS[kind];
    return { kind, mime, extension };
}

/** A storage name nobody chose: a random UUID and the extension the bytes earned. */
export function storageName(kind: FileKind): string {
    return `${randomUUID()}.${FILE_KINDS[kind].extension}`;
}

/**
 * Join path segments that came from input under `root`, and refuse anything that lands
 * outside it (`..`, an absolute segment, a drive letter) or on the root itself. Returns the
 * absolute path.
 * Lexical: a symlink INSIDE root that points out of it is not followed here, so do not let
 * uploads create symlinks.
 */
export function resolveInside(root: string, ...segments: string[]): string {
    if (segments.some((segment) => segment.includes("\0"))) throw new RangeError("A path segment contains a NUL byte.");
    const base = resolve(root);
    const target = resolve(base, ...segments);
    const rel = relative(base, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new RangeError("The path leaves the directory it must stay in.");
    }
    return target;
}

export interface DownloadHeaderOptions {
    /** The name the reader's browser saves it under. Sanitised here. */
    name: string;
    /** The stored type, ideally from inspectUpload. Anything unrecognised is sent as octet-stream. */
    type: string;
    /** Ask to display it in the page. Honoured only for types a browser renders passively. */
    inline?: boolean;
}

/** An ASCII fallback for the `filename=` parameter: no quotes, backslashes, separators or controls. */
function asciiName(name: string): string {
    const cleaned = name.replace(/[\u0000-\u001f\u007f"\\/]/g, "_").replace(/[^\x20-\x7e]/g, "_").trim();
    return cleaned || "download";
}

/**
 * Headers for serving a stored file back from this origin. Spread them into the response.
 *
 * - `X-Content-Type-Options: nosniff` always, so the declared type is the one used.
 * - `Content-Security-Policy: default-src 'none'; sandbox` on everything except PDF, so an
 *   HTML or SVG file opened directly runs no script and gets an opaque origin. PDF is left
 *   without it because a sandboxed PDF will not render in Chromium's viewer, and the viewer
 *   does not run page script on this origin.
 * - `Content-Disposition: attachment` unless `inline` was asked for AND the type is passive.
 */
export function downloadHeaders(options: DownloadHeaderOptions): Record<string, string> {
    const essence = options.type.split(";")[0]!.trim().toLowerCase();
    const known = Object.values(FILE_KINDS).find((info) => info.mime.split(";")[0] === essence);
    const inline = Boolean(options.inline && known?.inline);
    const headers: Record<string, string> = {
        "content-type": known ? known.mime : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName(options.name)}"; filename*=UTF-8''${encodeURIComponent(options.name.replace(/[\u0000-\u001f\u007f/\\]/g, "_"))}`,
        "x-content-type-options": "nosniff"
    };
    if (essence !== "application/pdf") headers["content-security-policy"] = "default-src 'none'; sandbox";
    return headers;
}
