import test from "node:test";
import assert from "node:assert/strict";
import { createCache } from "../dist/index.js";
import { setTimeout as delay } from "node:timers/promises";

test("concurrent reads of one key call the loader once", async () => {
    const cache = createCache({ ttl: 1000 });
    let calls = 0;
    const loader = async () => { calls++; await delay(20); return "value"; };

    const results = await Promise.all([
        cache.read("k", loader),
        cache.read("k", loader),
        cache.read("k", loader)
    ]);

    assert.deepEqual(results, ["value", "value", "value"]);
    assert.equal(calls, 1, "the in-flight request should be shared");
});

test("a fresh entry is served without calling the loader", async () => {
    const cache = createCache({ ttl: 1000 });
    let calls = 0;
    const loader = async () => { calls++; return calls; };

    assert.equal(await cache.read("k", loader), 1);
    assert.equal(await cache.read("k", loader), 1);
    assert.equal(calls, 1);
});

test("an expired entry is reloaded", async () => {
    const cache = createCache({ ttl: 20 });
    let calls = 0;
    const loader = async () => { calls++; return calls; };

    assert.equal(await cache.read("k", loader), 1);
    await delay(40);
    assert.equal(await cache.read("k", loader), 2);
});

test("a rejection is never cached", async () => {
    const cache = createCache({ ttl: 1000 });
    let calls = 0;
    const loader = async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return "recovered";
    };

    await assert.rejects(() => cache.read("k", loader));
    assert.equal(await cache.read("k", loader), "recovered");
});

test("a trailing star invalidates the whole prefix", () => {
    const cache = createCache({ ttl: 1000 });
    cache.set("user:1", "a");
    cache.set("user:2", "b");
    cache.set("post:1", "c");

    cache.invalidate("user:*");

    assert.equal(cache.get("user:1"), undefined);
    assert.equal(cache.get("user:2"), undefined);
    assert.equal(cache.get("post:1"), "c");
});

test("subscribers are told which key changed", () => {
    const cache = createCache();
    const seen = [];
    const unsubscribe = cache.subscribe(key => seen.push(key));

    cache.set("a", 1);
    cache.invalidate("a");
    unsubscribe();
    cache.set("b", 2);

    assert.deepEqual(seen, ["a", "a"]);
});
