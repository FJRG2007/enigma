import test from "node:test";
import { createElement } from "react";
import assert from "node:assert/strict";
import { RelativeTime } from "../dist/react/index.js";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureZone, normalizeDate, parseDuration, relativeTimeView, relativeTimeAttributes } from "../dist/index.js";

// Everything below is pinned to an instant so a test never depends on when it runs.
const NOW = new Date("2026-08-13T12:00:00Z");

test("a timestamp with no zone is read as UTC, not as local time", () => {
    // The defect this exists for: a database returns `2026-08-13 10:00:00`, `new Date()`
    // reads it in the server's zone, and every reader elsewhere sees a time hours out -
    // silently, because a wrong time is still a valid one.
    assert.equal(ensureZone("2026-08-13 10:00:00"), "2026-08-13T10:00:00Z");
    assert.equal(normalizeDate("2026-08-13 10:00:00").toISOString(), "2026-08-13T10:00:00.000Z");
});

test("a date with no clock is left alone", () => {
    // The naive version of the rule above appends a zone to everything and produces
    // `2026-08-13Z`, which is outside the spec's date-time grammar and so is left to each
    // engine's legacy parser - a portability coin flip on a value that was already UTC.
    assert.equal(ensureZone("2026-08-13"), "2026-08-13");
    assert.equal(normalizeDate("2026-08-13").toISOString(), "2026-08-13T00:00:00.000Z");
});

test("a timestamp that already declares its zone is untouched", () => {
    for (const value of ["2026-08-13T10:00:00Z", "2026-08-13T10:00:00+02:00", "2026-08-13T10:00:00-0500"]) {
        assert.equal(ensureZone(value), value);
    }
    assert.equal(normalizeDate("2026-08-13T10:00:00+02:00").toISOString(), "2026-08-13T08:00:00.000Z");
});

test("unparseable input is null, never an Invalid Date", () => {
    for (const value of [null, undefined, "", "   ", "not a date", Number.NaN, new Date("nope")]) {
        assert.equal(normalizeDate(value), null);
    }
    assert.equal(normalizeDate(1786000000000).getTime(), 1786000000000);
});

test("ISO 8601 durations parse, so the threshold is read rather than guessed", () => {
    assert.equal(parseDuration("P30D"), 30 * 86400000);
    assert.equal(parseDuration("PT1H30M"), 5400000);
    assert.equal(parseDuration("P1Y"), 365 * 86400000);
    assert.equal(parseDuration("P2W"), 14 * 86400000);
    assert.equal(parseDuration("garbage"), 0);
});

test("the threshold decides when a date stops being relative - the real one, not a guess", () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 86400000);
    assert.equal(relativeTimeView(tenDaysAgo, { threshold: "P30D" }, NOW).beyondThreshold, false);
    assert.equal(relativeTimeView(tenDaysAgo, { threshold: "P7D" }, NOW).beyondThreshold, true);
    // A date in the future ages the same way in the other direction.
    const tenDaysAhead = new Date(NOW.getTime() + 10 * 86400000);
    assert.equal(relativeTimeView(tenDaysAhead, { threshold: "P7D" }, NOW).beyondThreshold, true);
});

test("numericBeyondThreshold only takes over once the date is actually beyond it", () => {
    const inside = relativeTimeView(new Date(NOW.getTime() - 3 * 86400000), { numericBeyondThreshold: true, locale: "en-US" }, NOW);
    assert.equal(inside.absoluteOnly, false, "3 days old is still relative");

    const outside = relativeTimeView(new Date("2026-05-05T09:00:00Z"), { numericBeyondThreshold: true, locale: "en-US" }, NOW);
    assert.equal(outside.absoluteOnly, true);
    assert.equal(outside.label, "5/5/2026", "digits, with no prefix in front of them");
});

test("the absolute label carries the prefix, and an empty prefix removes it", () => {
    const date = new Date("2026-05-05T09:00:00Z");
    assert.equal(relativeTimeView(date, { locale: "en-US", timeZone: "UTC" }, NOW).label, "on May 5, 2026");
    assert.equal(relativeTimeView(date, { locale: "en-US", timeZone: "UTC", prefix: "" }, NOW).label, "May 5, 2026");
});

test("attributes are kebab-cased, UTC, and omit whatever was not asked for", () => {
    const view = relativeTimeView("2026-08-13 10:00:00", {}, NOW);
    const attributes = relativeTimeAttributes(view, { formatStyle: "short", locale: "es-ES" });
    assert.equal(attributes.datetime, "2026-08-13T10:00:00.000Z");
    assert.equal(attributes["format-style"], "short");
    assert.equal(attributes.lang, "es-ES");
    assert.equal("no-title" in attributes, false, "an absent boolean attribute must not be written at all");
    assert.equal("tense" in attributes, false);
});

test("no-title is written as a bare attribute, because presence is what a browser reads", () => {
    const view = relativeTimeView(NOW, {}, NOW);
    assert.equal(relativeTimeAttributes(view, { noTitle: true })["no-title"], "", '"false" would still be true');
});

test("a server render produces the date as the element's child, not an empty box", () => {
    // The whole reason the label exists: the custom element cannot upgrade on a server,
    // and will not upgrade at all without JavaScript. Both must still show a real date.
    const html = renderToStaticMarkup(createElement(RelativeTime, { date: "2026-08-13 10:00:00", now: NOW, locale: "en-US", timeZone: "UTC" }));
    assert.match(html, /^<relative-time /);
    assert.match(html, /datetime="2026-08-13T10:00:00\.000Z"/);
    assert.match(html, />on Aug 13, 2026<\/relative-time>$/);
});

test("the capitalize hooks are written only when they are switched on", () => {
    const props = { date: NOW, now: NOW, locale: "en-US" };
    const byDefault = renderToStaticMarkup(createElement(RelativeTime, props));
    assert.match(byDefault, /data-relative-time-capitalize-first-letter="true"/);
    assert.doesNotMatch(byDefault, /data-relative-time-capitalize="true"/);

    const both = renderToStaticMarkup(createElement(RelativeTime, { ...props, capitalize: true, capitalizeFirst: false }));
    assert.match(both, /data-relative-time-capitalize="true"/);
    assert.doesNotMatch(both, /data-relative-time-capitalize-first-letter/);
});

test("past the threshold with numeric dates on, it renders a plain time element", () => {
    const html = renderToStaticMarkup(createElement(RelativeTime, {
        date: "2026-05-05T09:00:00Z", now: NOW, locale: "en-US", timeZone: "UTC", numericBeyondThreshold: true
    }));
    assert.match(html, /^<time /, "there is no relative phrasing left, so there is no element to wait for");
    assert.match(html, />5\/5\/2026<\/time>$/);
});

test("an unparseable date renders the fallback instead of a broken element", () => {
    assert.equal(renderToStaticMarkup(createElement(RelativeTime, { date: "not a date" })), "");
    assert.equal(
        renderToStaticMarkup(createElement(RelativeTime, { date: null, fallback: createElement("span", null, "never") })),
        "<span>never</span>"
    );
});

test("class and the rest of the DOM props reach the element", () => {
    const html = renderToStaticMarkup(createElement(RelativeTime, {
        date: NOW, now: NOW, locale: "en-US", className: "text-sm", "data-testid": "stamp"
    }));
    assert.match(html, /class="text-sm"/);
    assert.match(html, /data-testid="stamp"/);
});
