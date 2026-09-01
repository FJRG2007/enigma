import test from "node:test";
import assert from "node:assert/strict";
import { shortenQuery } from "../dist/index.js";

/** The query goes back on screen in every empty state, and what was typed is arbitrary. */

test("a short query is given back as it was, trimmed", () => {
    assert.equal(shortenQuery("cafe"), "cafe");
    assert.equal(shortenQuery("  cafe  "), "cafe");
    assert.equal(shortenQuery(""), "");
});

test("a long one is cut, because the panel is what it would stretch", () => {
    const long = "i".repeat(80);
    const short = shortenQuery(long);
    assert.equal(short.length, 32, "the cut is the budget, ellipsis included");
    assert.equal(short.endsWith("…"), true);
    assert.equal(short.startsWith("i".repeat(31)), true, "the start is what identifies the typo");
});

test("the budget is the caller's", () => {
    assert.equal(shortenQuery("abcdefghij", 5), "abcd…");
    assert.equal(shortenQuery("abcdefghij", 10), "abcdefghij");
});

test("a cut that lands on a space does not leave one before the ellipsis", () => {
    assert.equal(shortenQuery("hello world again", 12), "hello world…");
});
