import test from "node:test";
import { createElement } from "react";
import assert from "node:assert/strict";
import { Toaster } from "../dist/react/index.js";
import { createNotifications } from "../dist/index.js";
import { renderToStaticMarkup } from "react-dom/server";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("update patches a live notification in place, keeping its slot", async () => {
    const queue = createNotifications();
    const id = queue.notify({ title: "Uploading", tone: "loading" });
    queue.update(id, { title: "Uploaded", tone: "success" });

    assert.equal(queue.items.length, 1, "an update must not stack a second toast");
    assert.equal(queue.items[0].id, id);
    assert.equal(queue.items[0].title, "Uploaded");
    assert.equal(queue.items[0].tone, "success");
    queue.destroy();
});

test("a loading notification is sticky, and stops being sticky when it resolves", () => {
    const queue = createNotifications({ duration: 50 });
    const id = queue.notify({ title: "Working", tone: "loading" });
    // Sticky by definition: it ends when the work ends, not on a clock.
    assert.equal(queue.items[0].duration, Infinity);

    queue.update(id, { title: "Done", tone: "success" });
    assert.equal(queue.items[0].duration, 50, "otherwise a finished toast never leaves");
    queue.destroy();
});

test("update on an id that is gone does nothing", () => {
    const queue = createNotifications();
    const id = queue.notify({ title: "Gone" });
    queue.dismiss(id);
    queue.update(id, { title: "Back" });
    assert.equal(queue.items.length, 0, "an update must never resurrect a dismissed toast");
    queue.destroy();
});

test("promise runs loading -> success in ONE slot", async () => {
    const queue = createNotifications();
    const seen = [];
    queue.subscribe((items) => seen.push(items.map((item) => `${item.tone}:${item.title}`)));

    const value = await queue.promise(Promise.resolve(42), {
        loading: "Saving...",
        success: (result) => `Saved ${result}`,
        error: "Failed"
    });

    assert.equal(value, 42, "the resolved value has to pass through untouched");
    assert.deepEqual(seen.at(-1), ["success:Saved 42"]);
    // Three toasts for one action is the thing this exists to prevent.
    assert.ok(seen.every((frame) => frame.length <= 1), `stacked: ${JSON.stringify(seen)}`);
    queue.destroy();
});

test("promise rethrows, so a failed call is not a silent success downstream", async () => {
    const queue = createNotifications();
    const failure = new Error("no");
    await assert.rejects(
        () => queue.promise(Promise.reject(failure), { loading: "Saving...", success: "Saved", error: (error) => `Failed: ${error.message}` }),
        (error) => error === failure
    );
    assert.equal(queue.items[0].tone, "error");
    assert.equal(queue.items[0].title, "Failed: no");
    // An error stays until it is dismissed - the one message nobody should miss.
    assert.equal(queue.items[0].duration, Infinity);
    queue.destroy();
});

test("an action rides along on the notification", () => {
    const queue = createNotifications();
    let undone = false;
    queue.notify({ title: "Deleted", action: { label: "Undo", onSelect: () => { undone = true; } } });
    queue.items[0].action.onSelect();
    assert.equal(undone, true);
    queue.destroy();
});

test("the toaster renders nothing when the queue is empty", () => {
    const queue = createNotifications();
    // An empty fixed-position region still intercepts pointer events in some layouts.
    assert.equal(renderToStaticMarkup(createElement(Toaster, { queue })), "");
    queue.destroy();
});

test("a toast carries its tone, its state and the right live region", async () => {
    const queue = createNotifications();
    queue.notify({ title: "Saved", body: "Two files", tone: "success" });
    queue.notify({ title: "Broke", tone: "error" });

    const html = renderToStaticMarkup(createElement(Toaster, { queue, position: "top-center" }));
    assert.match(html, /data-position="top-center"/);
    assert.match(html, /data-tone="success"[^>]*data-state="open"/);
    assert.match(html, /<p data-enigma-toast-title="">Saved<\/p>/);
    assert.match(html, /<p data-enigma-toast-body="">Two files<\/p>/);
    assert.match(html, /aria-label="Dismiss"/);

    // An error interrupts; anything else waits its turn rather than talking over whatever
    // a screen reader is already reading.
    assert.match(html, /role="alert"[^>]*aria-live="assertive"/);
    assert.match(html, /role="status"[^>]*aria-live="polite"/);
    await settle();
    queue.destroy();
});

test("the stack is seeded from the queue, so a toast raised before it mounted is not lost", () => {
    const queue = createNotifications();
    // A notify() during a redirect, or from a module that runs early, arrives before the
    // Toaster exists. Starting from an empty list would drop it for a frame.
    queue.notify({ title: "Signed out" });
    assert.match(renderToStaticMarkup(createElement(Toaster, { queue })), /Signed out/);
    queue.destroy();
});
