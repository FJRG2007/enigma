import test from "node:test";
import assert from "node:assert/strict";
import { flagSrc, flagView, flagAttributes, normalizeFlagCode, configureFlags, resetFlagConfig } from "../dist/index.js";

/** The emoji is built from code points so this file never contains one. */
const emoji = (a, b) => String.fromCodePoint(0x1f1e6 + a, 0x1f1e6 + b);

test.afterEach(() => resetFlagConfig());

test("a bare code, an uppercase one and a locale tag all resolve to the country", () => {
    assert.equal(normalizeFlagCode("es"), "es");
    assert.equal(normalizeFlagCode(" ES "), "es");
    assert.equal(normalizeFlagCode("en-GB"), "gb");
    assert.equal(normalizeFlagCode("es_ES"), "es");
});

test("a lowercase subdivision is a file name, not a locale", () => {
    // The whole discriminator is the casing of the second part, read before lowercasing:
    // es-ES is Spanish-in-Spain, es-ct is Catalonia and both sets publish it.
    assert.equal(normalizeFlagCode("es-ct"), "es-ct");
    assert.equal(normalizeFlagCode("es-ES"), "es");
    assert.equal(normalizeFlagCode("gb-eng"), "gb-eng");
    assert.equal(normalizeFlagCode("east_african_federation"), "east_african_federation");
});

test("the emoji it replaces is accepted as a code", () => {
    assert.equal(normalizeFlagCode(emoji(4, 18)), "es");
    assert.equal(normalizeFlagCode(emoji(5, 17)), "fr");
});

test("a code that resolves to nothing is null, never a guess", () => {
    for (const value of ["", "  ", null, undefined, "e", "12", "not a country!"]) {
        assert.equal(normalizeFlagCode(value), null, `${JSON.stringify(value)} is not a flag`);
    }
    assert.equal(flagSrc("not a country!"), null);
    assert.equal(flagView("not a country!"), null);
    assert.equal(flagAttributes("not a country!"), null);
});

test("each shape points at the set that publishes it", () => {
    assert.match(flagSrc("es"), /flag-icons@[\d.]+\/flags\/4x3\/es\.svg$/);
    assert.match(flagSrc("es", { shape: "square" }), /flag-icons@[\d.]+\/flags\/1x1\/es\.svg$/);
    assert.match(flagSrc("es", { shape: "circle" }), /circle-flags@gh-pages\/flags\/es\.svg$/);
});

test("a raster format asked of the CDN is served as SVG rather than as a 404", () => {
    // Neither upstream publishes anything but SVG, so honouring the request literally
    // would produce a broken image on every flag.
    assert.match(flagSrc("es", { format: "webp" }), /\.svg$/);
});

test("a local set keeps the format, and the layout matches what the downloader writes", () => {
    assert.equal(flagSrc("es", { source: "local", format: "webp" }), "/flags/rect/es.webp");
    assert.equal(flagSrc("es", { source: "local", shape: "circle", basePath: "/assets/flags/" }), "/assets/flags/circle/es.svg");
    assert.equal(flagSrc("es", { source: "https://cdn.example.com/f", shape: "square", format: "png" }), "https://cdn.example.com/f/square/es.png");
});

test("configureFlags moves every flag at once, and reset puts it back", () => {
    configureFlags({ source: "local", shape: "circle" });
    assert.equal(flagSrc("fr"), "/flags/circle/fr.svg");
    resetFlagConfig();
    assert.match(flagSrc("fr"), /^https:\/\/cdn\.jsdelivr\.net\//);
});

test("the box is sized from the shape, not assumed square", () => {
    assert.deepEqual(
        { width: flagView("es", { size: 15 }).width, height: flagView("es", { size: 15 }).height },
        { width: 20, height: 15 }
    );
    const circle = flagView("es", { shape: "circle", size: 24 });
    assert.deepEqual({ width: circle.width, height: circle.height }, { width: 24, height: 24 });
});

test("a flag with no label is decorative, and a labelled one is not", () => {
    const bare = flagAttributes("es");
    assert.equal(bare.alt, "");
    assert.equal(bare["aria-hidden"], "true");

    const named = flagAttributes("es", { label: "Spain" });
    assert.equal(named.alt, "Spain");
    assert.equal("aria-hidden" in named, false, "a named flag is content, not decoration");
});
