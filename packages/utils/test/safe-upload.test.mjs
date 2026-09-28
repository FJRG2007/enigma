import test from "node:test";
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { inspectUpload, sniffFileType, storageName, resolveInside, downloadHeaders, UploadRefusedError } from "../dist/server/index.js";

const bytes = (...parts) => new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part, "latin1")] : part)));
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "rest");
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], "rest");
const PDF = bytes("%PDF-1.7\n...");
const text = (value) => new TextEncoder().encode(value);

test("the type comes from the bytes", () => {
    assert.equal(sniffFileType(PNG), "png");
    assert.equal(sniffFileType(JPEG), "jpeg");
    assert.equal(sniffFileType(bytes("GIF89a", "rest")), "gif");
    assert.equal(sniffFileType(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")), "webp");
    assert.equal(sniffFileType(bytes([0, 0, 0, 0x1c], "ftypavif")), "avif");
    assert.equal(sniffFileType(bytes([0, 0, 0, 0x1c], "ftypisom")), "mp4");
    assert.equal(sniffFileType(PDF), "pdf");
    assert.equal(sniffFileType(bytes([0x50, 0x4b, 0x03, 0x04], "rest")), "zip");
    assert.equal(sniffFileType(text("just some notes\nsecond line")), "text");
    assert.equal(sniffFileType(bytes([0x00, 0x01, 0x02, 0xfe])), null);
});

test("markup is never plain text: SVG and HTML are recognised so they can be refused", () => {
    assert.equal(sniffFileType(text("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")), "svg");
    assert.equal(sniffFileType(text("<?xml version=\"1.0\"?>\n<!-- x -->\n<svg></svg>")), "svg");
    assert.equal(sniffFileType(text("\uFEFF  <!doctype html><p>hi")), "html");
    assert.equal(sniffFileType(text("<html><body>x</body></html>")), "html");
    assert.equal(sniffFileType(text("notes... <script>fetch('/api')</script>")), "html");
    // Prose that merely mentions a tag stays text.
    assert.equal(sniffFileType(text("use the <a> element for links")), "text");
});

test("inspectUpload accepts only what the allowlist names, whatever the upload claimed", () => {
    assert.deepEqual(inspectUpload(PNG, { allow: ["png", "jpeg"], maxBytes: 1000 }), { kind: "png", mime: "image/png", extension: "png" });
    const refused = (data, options, reason) => assert.throws(() => inspectUpload(data, options), (error) => error instanceof UploadRefusedError && error.reason === reason);
    // An SVG renamed to .png and sent as image/png is still an SVG.
    refused(text("<svg><script>alert(1)</script></svg>"), { allow: ["png"], maxBytes: 1000 }, "type-not-allowed");
    refused(text("<html>"), { allow: ["text"], maxBytes: 1000 }, "type-not-allowed");
    refused(new Uint8Array(0), { allow: ["png"], maxBytes: 1000 }, "empty");
    refused(PNG, { allow: ["png"], maxBytes: 4 }, "too-large");
    refused(bytes([0x00, 0x01, 0x02]), { allow: ["png"], maxBytes: 1000 }, "unknown-type");
});

test("storage names are random and carry the extension the bytes earned", () => {
    const a = storageName("png");
    const b = storageName("png");
    assert.match(a, /^[0-9a-f-]{36}\.png$/);
    assert.notEqual(a, b);
    assert.match(storageName("jpeg"), /\.jpg$/);
});

test("resolveInside keeps a path under its root", () => {
    const root = resolve("uploads-root");
    assert.equal(resolveInside(root, "team", "a.png"), `${root}${sep}team${sep}a.png`);
    assert.equal(resolveInside(root, "team/../b.png"), `${root}${sep}b.png`);
    for (const escape of [["../etc/passwd"], ["team", "../../x"], ["/etc/passwd"], [".."], ["."], ["a\0b"]]) {
        assert.throws(() => resolveInside(root, ...escape), RangeError, escape.join(","));
    }
    if (process.platform === "win32") assert.throws(() => resolveInside(root, "C:\\Windows\\x"), RangeError);
});

test("downloadHeaders: nosniff always, sandbox except PDF, attachment unless passive and asked inline", () => {
    const svg = downloadHeaders({ name: "logo.svg", type: "image/svg+xml", inline: true });
    assert.equal(svg["content-disposition"].startsWith("attachment;"), true);
    assert.equal(svg["x-content-type-options"], "nosniff");
    assert.equal(svg["content-security-policy"], "default-src 'none'; sandbox");

    const html = downloadHeaders({ name: "x.html", type: "text/html", inline: true });
    assert.equal(html["content-disposition"].startsWith("attachment;"), true);
    assert.equal(html["content-security-policy"], "default-src 'none'; sandbox");

    const png = downloadHeaders({ name: "a.png", type: "image/png", inline: true });
    assert.equal(png["content-disposition"].startsWith("inline;"), true);
    assert.equal(png["content-type"], "image/png");

    const pdf = downloadHeaders({ name: "a.pdf", type: "application/pdf", inline: true });
    assert.equal(pdf["content-security-policy"], undefined);
    assert.equal(pdf["x-content-type-options"], "nosniff");

    const unknown = downloadHeaders({ name: "a.bin", type: "application/x-whatever" });
    assert.equal(unknown["content-type"], "application/octet-stream");
    assert.equal(unknown["content-disposition"].startsWith("attachment;"), true);
});

test("the file name cannot break out of the header", () => {
    const headers = downloadHeaders({ name: "evil\"\r\nSet-Cookie: a=1; x.png", type: "image/png" });
    const value = headers["content-disposition"];
    assert.doesNotMatch(value, /[\r\n]/);
    assert.match(value, /filename="evil_+Set-Cookie: a=1; x\.png"/);
    assert.match(value, /filename\*=UTF-8''evil/);
    assert.match(downloadHeaders({ name: "résumé.pdf", type: "application/pdf" })["content-disposition"], /filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
});
