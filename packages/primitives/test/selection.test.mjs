import test from "node:test";
import assert from "node:assert/strict";
import { createSelection, DEFAULT_SELECTION_SHORTCUTS } from "../dist/index.js";

/** Ten rows, one of which cannot be selected. */
const FILES = Array.from({ length: 10 }, (_, index) => ({ id: `f${index}`, name: `File ${index}` }));

const make = (options = {}) => createSelection({
    items: FILES,
    getId: (file) => file.id,
    ...options
});

const press = (key, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers });

test("a plain click replaces, Ctrl toggles, Shift takes the range", () => {
    const list = make();

    list.click(2);
    assert.deepEqual(list.state.selected, ["f2"]);

    list.click(5);
    assert.deepEqual(list.state.selected, ["f5"], "a plain click replaces rather than adding");

    list.click(7, { ctrlKey: true });
    assert.deepEqual(list.state.selected, ["f5", "f7"]);
    list.click(7, { ctrlKey: true });
    assert.deepEqual(list.state.selected, ["f5"], "and toggles the row back off");

    // The anchor is where the last plain or Ctrl click landed, not where the pointer was.
    list.click(2);
    list.click(4, { shiftKey: true });
    assert.deepEqual(list.state.selected, ["f2", "f3", "f4"]);
});

test("Shift+click measures from the anchor every time, not from the last click", () => {
    const list = make();
    list.click(4);
    list.click(7, { shiftKey: true });
    assert.deepEqual(list.state.selected, ["f4", "f5", "f6", "f7"]);

    // Dragging the shift-click back shrinks the SAME range instead of leaving a trail of
    // rows behind - which is the bug in every hand-rolled version of this.
    list.click(5, { shiftKey: true });
    assert.deepEqual(list.state.selected, ["f4", "f5"]);

    // And the other side of the anchor works the same way.
    list.click(2, { shiftKey: true });
    assert.deepEqual(list.state.selected, ["f2", "f3", "f4"]);
});

test("Ctrl+Shift adds the range to what was already selected", () => {
    const list = make();
    list.click(0);
    list.click(8, { ctrlKey: true });
    list.click(9, { ctrlKey: true, shiftKey: true });
    assert.deepEqual(list.state.selected, ["f0", "f8", "f9"], "the first row survives the range");

    // The base is captured once per run: growing the range must not fold the previous
    // extension into the base and leave rows stranded behind it.
    list.click(6, { ctrlKey: true, shiftKey: true });
    assert.deepEqual(list.state.selected, ["f0", "f6", "f7", "f8"]);
});

test("Ctrl+A takes everything, Escape drops it, and both are commands", () => {
    const list = make();
    assert.equal(list.keyDown(press("a", { ctrlKey: true })), true);
    assert.equal(list.state.count, 10);
    assert.equal(list.state.allSelected, true);

    assert.equal(list.keyDown(press("Escape")), true);
    assert.equal(list.state.count, 0);

    assert.equal(list.keyDown(press("q")), false, "an unbound key is not the list's to take");
});

test("a disabled row is never selected, by click, by range or by select-all", () => {
    const list = make({ disabled: (file) => file.id === "f3" });
    list.click(3);
    assert.deepEqual(list.state.selected, [], "a click that got through still must not select it");

    list.click(2);
    list.click(4, { shiftKey: true });
    assert.deepEqual(list.state.selected, ["f2", "f4"], "a range steps over it");

    list.selectAll();
    assert.equal(list.state.selected.includes("f3"), false);
    assert.equal(list.state.allSelected, true, "and a list of nine selectable rows is fully selected at nine");
});

test("arrows move the cursor and Shift extends from the anchor", () => {
    const list = make();
    list.keyDown(press("ArrowDown"));
    assert.deepEqual(list.state.selected, ["f0"]);
    list.keyDown(press("ArrowDown"));
    assert.deepEqual(list.state.selected, ["f1"], "a plain arrow moves the selection with the cursor");

    list.keyDown(press("ArrowDown", { shiftKey: true }));
    assert.deepEqual(list.state.selected, ["f1", "f2"]);
    list.keyDown(press("ArrowDown", { shiftKey: true }));
    assert.deepEqual(list.state.selected, ["f1", "f2", "f3"], "and the anchor stays put while it grows");

    list.keyDown(press("ArrowUp", { shiftKey: true }));
    assert.deepEqual(list.state.selected, ["f1", "f2"], "shrinking is the same range measured back");
});

test("the cursor stops at the ends rather than wrapping", () => {
    const list = make();
    list.keyDown(press("Home"));
    assert.deepEqual(list.state.selected, ["f0"]);
    list.keyDown(press("ArrowUp"));
    assert.deepEqual(list.state.selected, ["f0"], "a list is long: wrapping to the bottom loses your place");
    list.keyDown(press("End"));
    assert.deepEqual(list.state.selected, ["f9"]);
    list.keyDown(press("ArrowDown"));
    assert.deepEqual(list.state.selected, ["f9"]);
});

test("Ctrl+arrow moves the cursor alone, and Ctrl+Space adds where it lands", () => {
    const list = make();
    list.click(0);
    list.keyDown(press("ArrowDown", { ctrlKey: true }));
    list.keyDown(press("ArrowDown", { ctrlKey: true }));
    assert.deepEqual(list.state.selected, ["f0"], "the selection stays where it was");
    assert.equal(list.state.cursor, 2);

    list.keyDown(press(" ", { ctrlKey: true }));
    assert.deepEqual(list.state.selected, ["f0", "f2"]);
});

test("a command is reported before the list acts, and can be stopped", () => {
    const seen = [];
    const list = make({ onCommand: (event) => { seen.push(event.command); if (event.command === "selectAll") event.preventDefault(); } });

    list.keyDown(press("a", { ctrlKey: true }));
    assert.deepEqual(seen, ["selectAll"]);
    assert.equal(list.state.count, 0, "prevented, so the list did not select anything");

    list.click(4);
    seen.length = 0;
    list.keyDown(press("F2"));
    list.keyDown(press("Delete"));
    assert.deepEqual(seen, ["rename", "delete"], "renaming and deleting are reported, never performed");
    assert.deepEqual(list.state.selected, ["f4"], "and the selection is left alone");
});

test("a command with nothing selected applies to the row under the cursor", () => {
    let reported = null;
    const list = make({ onCommand: (event) => { reported = event; } });
    list.keyDown(press("ArrowDown"));
    list.keyDown(press("Escape"));
    list.keyDown(press("Delete"));
    // The file-manager rule: Delete with one row focused and none selected deletes that row.
    assert.deepEqual(reported.ids, ["f0"]);
    assert.equal(reported.cursorIndex, 0);
});

test("the more specific binding wins", () => {
    const seen = [];
    const list = make({ onCommand: (event) => seen.push(event.command) });
    list.click(1);
    list.keyDown(press("Delete"));
    list.keyDown(press("Delete", { shiftKey: true }));
    assert.deepEqual(seen, ["delete", "deletePermanent"], "Shift+Delete is not Delete with a modifier ignored");
});

test("a binding can be rebound, removed one at a time, or turned off altogether", () => {
    const seen = [];
    const rebound = make({ shortcuts: { rename: "F3", delete: false, star: "Mod+D" }, onCommand: (event) => seen.push(event.command) });

    assert.equal(rebound.keyDown(press("F2")), false, "the old binding is gone with the new one in place");
    rebound.keyDown(press("F3"));
    assert.equal(rebound.keyDown(press("Delete")), false, "false removes that one command");
    rebound.keyDown(press("d", { ctrlKey: true }));
    assert.deepEqual(seen, ["rename", "star"], "a binding of your own is matched and reported the same way");

    // Everything the list did not touch keeps its default.
    assert.equal(rebound.binding("selectAll"), DEFAULT_SELECTION_SHORTCUTS.selectAll);
    assert.equal(rebound.binding("delete"), false);

    const silent = make({ shortcuts: false });
    assert.equal(silent.keyDown(press("a", { ctrlKey: true })), false, "and false on the options removes the lot");
    assert.deepEqual(silent.bindings(), {});
});

test("one row at a time ignores Ctrl and Shift", () => {
    const list = make({ multiple: false });
    list.click(1);
    list.click(4, { ctrlKey: true });
    assert.deepEqual(list.state.selected, ["f4"]);
    list.click(6, { shiftKey: true });
    assert.deepEqual(list.state.selected, ["f6"]);
    list.selectAll();
    assert.deepEqual(list.state.selected, ["f6"], "select-all has no meaning here");
});

test("what an action applies to is the selection, or the row outside it", () => {
    const list = make();
    list.click(2);
    list.click(3, { ctrlKey: true });
    assert.deepEqual(list.targets(3).map((file) => file.id), ["f2", "f3"], "a row inside the selection acts on all of it");
    assert.deepEqual(list.targets(8).map((file) => file.id), ["f8"], "and one outside it acts on itself");
});

test("a rubber band adds to its base and reports the set once", () => {
    let emissions = 0;
    const list = make({ onSelectionChange: () => emissions++ });
    list.click(0);
    emissions = 0;

    list.beginMarquee(true);
    list.marqueeTo([2, 3]);
    list.marqueeTo([2, 3]);
    assert.equal(emissions, 1, "a drag fires on every pixel; an unchanged set must not redraw the list");
    assert.deepEqual(list.state.selected, ["f0", "f2", "f3"]);

    list.endMarquee();
    assert.equal(list.state.marquee, false);

    // Without the modifier the band starts from nothing, the way dragging on empty space does.
    list.beginMarquee(false);
    list.marqueeTo([5]);
    assert.deepEqual(list.state.selected, ["f5"]);
});

test("rows that are gone are dropped from the selection", () => {
    const list = make();
    list.selectAll();
    list.update({ items: FILES.slice(0, 3) });
    assert.deepEqual(list.state.selected, ["f0", "f1", "f2"], "a selection holding deleted rows reports a count nobody can see");
    assert.equal(list.state.cursor <= 2, true);
});

test("the selection reads in list order, not in the order it was clicked", () => {
    const list = make();
    list.click(7);
    list.click(2, { ctrlKey: true });
    list.click(5, { ctrlKey: true });
    assert.deepEqual(list.state.selected, ["f2", "f5", "f7"]);
});
