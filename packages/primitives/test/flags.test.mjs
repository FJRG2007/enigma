import test from "node:test";
import assert from "node:assert/strict";
import { flagSrc, flagView, flagAttributes, flagName, normalizeFlagCode, configureFlags, resetFlagConfig } from "../dist/index.js";

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

test("an ordinary word is refused rather than turned into a file name", () => {
    // The defect this replaced: any lowercase word passed as a "file code" and rendered as a
    // 404 with no alt text, which is worse than no flag at all.
    for (const value of ["banana", "unknown", "none", "null", "x"]) {
        assert.equal(normalizeFlagCode(value), null, `${value} is not a country`);
    }
    // And a two-letter code has to be a region the runtime actually knows.
    assert.equal(normalizeFlagCode("zz"), null, "ZZ is the unknown region by definition");
    assert.equal(normalizeFlagCode("qq"), null);
});

test("the country's name resolves, which is what a database column holds", () => {
    assert.equal(normalizeFlagCode("Spain"), "es");
    assert.equal(normalizeFlagCode("spain"), "es");
    assert.equal(normalizeFlagCode("  United States  "), "us");
    // Accents are folded, and so is the typographic apostrophe an API tends to send.
    assert.equal(normalizeFlagCode("Cote d'Ivoire"), "ci");
    assert.equal(normalizeFlagCode("Côte d’Ivoire"), "ci");
});

test("the spellings a form and a database actually use resolve too", () => {
    // CLDR writes "St. Lucia" and "Trinidad & Tobago"; everything else writes these.
    assert.equal(normalizeFlagCode("Saint Lucia"), "lc");
    assert.equal(normalizeFlagCode("St. Lucia"), "lc");
    assert.equal(normalizeFlagCode("Trinidad and Tobago"), "tt");
    assert.equal(normalizeFlagCode("Trinidad & Tobago"), "tt");
    assert.equal(normalizeFlagCode("The Netherlands"), "nl");
});

test("a name resolves in the language you ask for", () => {
    assert.equal(normalizeFlagCode("España", "es"), "es");
    assert.equal(normalizeFlagCode("Alemania", "es"), "de");
    assert.equal(normalizeFlagCode("Allemagne", "fr"), "de");
});

test("an alias code reaches the file the country is actually filed under", () => {
    // UK is not the ISO code for the United Kingdom, GB is - and `uk.svg` does not exist.
    assert.equal(normalizeFlagCode("uk"), "gb");
    assert.equal(normalizeFlagCode("UK"), "gb");
    assert.equal(normalizeFlagCode("United Kingdom"), "gb");
    // Same class: the Netherlands Antilles became Curaçao, the USSR became Russia.
    assert.equal(normalizeFlagCode("an"), "cw");
    assert.equal(normalizeFlagCode("su"), "ru");
});

test("every shape is served from enigma's own tree, in one layout", () => {
    // One layout everywhere is what makes a mirror the same string with a different host.
    assert.match(flagSrc("es"), /\/assets\/flags\/rect\/es\.svg$/);
    assert.match(flagSrc("es", { shape: "square" }), /\/assets\/flags\/square\/es\.svg$/);
    assert.match(flagSrc("es", { shape: "circle" }), /\/assets\/flags\/circle\/es\.svg$/);
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

test("the accessible name is automatic, in the reader's language", () => {
    // From Intl.DisplayNames, so no table of 250 country names ships with the component.
    assert.equal(flagName("es", "en"), "Spain");
    assert.equal(flagName("es", "es"), "España");
    assert.equal(flagName("fr", "en"), "France");

    const bare = flagAttributes("es", { locale: "en" });
    assert.equal(bare.alt, "Spain");
    assert.equal("aria-hidden" in bare, false, "a flag that names itself is content, not decoration");
});

test("a name is never invented for something the platform cannot name", () => {
    // gb-eng is England: falling back to the region would say "United Kingdom", which is
    // confidently wrong. No name at all is the honest answer.
    assert.equal(flagName("gb-eng"), null);
    assert.equal(flagName("easter_island"), null);
    const attributes = flagAttributes("gb-eng");
    assert.equal(attributes.alt, "");
    assert.equal(attributes["aria-hidden"], "true");
});

test("the name is on title as well, because that is the half a pointer can see", () => {
    // `alt` is read out and shown when the image fails; a hover tooltip comes from `title`
    // and from nothing else, and a flag is often the only thing in its cell.
    const named = flagAttributes("es", { locale: "en" });
    assert.equal(named.title, "Spain");
    assert.equal(named.alt, named.title);

    const decoration = flagAttributes("es", { decorative: true });
    assert.equal("title" in decoration, false, "decoration has nothing to say on hover either");
});

test("an explicit label wins, and decorative drops the name entirely", () => {
    assert.equal(flagAttributes("es", { label: "Spanish" }).alt, "Spanish");

    // Beside a country name already on screen, repeating it makes a reader say it twice.
    const decoration = flagAttributes("es", { decorative: true, locale: "en" });
    assert.equal(decoration.alt, "");
    assert.equal(decoration["aria-hidden"], "true");
});
