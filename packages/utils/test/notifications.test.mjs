import test from "node:test";
import assert from "node:assert/strict";
import { createNotifications } from "../dist/index.js";
import { setTimeout as delay } from "node:timers/promises";

test("a repeated key replaces in place instead of stacking", () => {
    const queue = createNotifications();
    queue.notify({ key: "sync", title: "Retrying" });
    queue.notify({ key: "sync", title: "Retrying again" });

    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].title, "Retrying again");
    queue.destroy();
});

test("a notification dismisses itself after its duration", async () => {
    const queue = createNotifications({ duration: 30 });
    queue.notify({ title: "Saved" });
    assert.equal(queue.items.length, 1);

    await delay(60);
    assert.equal(queue.items.length, 0);
    queue.destroy();
});

test("an error stays until it is dismissed", async () => {
    const queue = createNotifications({ duration: 20 });
    const id = queue.notify({ title: "Failed", tone: "error" });

    await delay(50);
    assert.equal(queue.items.length, 1, "an error must not disappear on its own");

    queue.dismiss(id);
    assert.equal(queue.items.length, 0);
    queue.destroy();
});

test("pause holds the remaining time rather than running it", async () => {
    const queue = createNotifications({ duration: 60 });
    queue.notify({ title: "Saved" });

    await delay(30);
    queue.pause();
    await delay(120);
    assert.equal(queue.items.length, 1, "a paused timer must not fire");

    queue.resume();
    await delay(60);
    assert.equal(queue.items.length, 0);
    queue.destroy();
});

test("the oldest dismissable notification makes room, never a sticky one", () => {
    const queue = createNotifications({ max: 2, duration: 5000 });
    queue.notify({ title: "Error", tone: "error" });
    queue.notify({ title: "One" });
    queue.notify({ title: "Two" });

    assert.equal(queue.items.length, 2);
    assert.deepEqual(queue.items.map(item => item.title), ["Error", "Two"]);
    queue.destroy();
});

test("subscribers receive every change", () => {
    const queue = createNotifications();
    const sizes = [];
    const unsubscribe = queue.subscribe(items => sizes.push(items.length));

    const id = queue.notify({ title: "One" });
    queue.notify({ title: "Two" });
    queue.dismiss(id);
    unsubscribe();
    queue.notify({ title: "Three" });

    assert.deepEqual(sizes, [1, 2, 1]);
    queue.destroy();
});
