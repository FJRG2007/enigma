import test from "node:test";
import assert from "node:assert/strict";
import { createSelect } from "../dist/index.js";

/** The list the tests read: two groups, one row that cannot be chosen, one with a synonym. */
const OPTIONS = [
    { value: "es", label: "Spain", group: "Europe", keywords: ["espana"] },
    { value: "fr", label: "France", group: "Europe" },
    { value: "de", label: "Germany", group: "Europe", disabled: true },
    { value: "us", label: "United States", group: "Americas", description: "USA" },
    { value: "mx", label: "Mexico", group: "Americas" }
];

const make = (options = {}) => createSelect({ options: OPTIONS, ...options });

test("one value replaces, many values toggle", () => {
    const single = make();
    single.select("es");
    single.select("fr");
    assert.deepEqual(single.state.value, ["fr"], "a second choice replaces the first");

    const many = make({ multiple: true });
    many.select("es");
    many.select("fr");
    assert.deepEqual(many.state.value, ["es", "fr"]);
    many.select("es");
    assert.deepEqual(many.state.value, ["fr"], "choosing a chosen row takes it off");
});

test("the change reports a string for one value and a list for many", () => {
    const seen = [];
    const single = make({ onValueChange: (value) => seen.push(value) });
    single.select("es");

    const many = make({ multiple: true, onValueChange: (value) => seen.push(value) });
    many.select("es");
    many.select("fr");

    assert.deepEqual(seen, ["es", ["es"], ["es", "fr"]]);
});

test("a disabled option is listed, never chosen and never highlighted", () => {
    const select = make();
    select.select("de");
    assert.deepEqual(select.state.value, [], "a click that got through still must not choose it");

    select.setOpen(true);
    // Spain, France, then Germany - which is skipped, so the third press lands on the US.
    select.move("ArrowDown");
    select.move("ArrowDown");
    assert.equal(select.state.visible[select.state.active].value, "us");
    assert.equal(select.state.visible.length, OPTIONS.length, "skipped, not hidden");
});

test("the highlight wraps rather than stopping at the end", () => {
    const select = make();
    select.setOpen(true);
    select.move("End");
    assert.equal(select.state.visible[select.state.active].value, "mx");
    select.move("ArrowDown");
    assert.equal(select.state.visible[select.state.active].value, "es", "past the last row is the first");
    select.move("ArrowUp");
    assert.equal(select.state.visible[select.state.active].value, "mx");
});

test("opening lands on what is already chosen", () => {
    // A select that reopens on the first row makes you find your own value again.
    const select = make({ value: "us" });
    select.setOpen(true);
    assert.equal(select.state.visible[select.state.active].value, "us");
});

test("the filter reads the label, the description, the group and the synonyms", () => {
    const select = make({ searchable: true });
    select.setOpen(true);

    select.setQuery("spa");
    assert.deepEqual(select.state.visible.map((option) => option.value), ["es"]);

    select.setQuery("USA");
    assert.deepEqual(select.state.visible.map((option) => option.value), ["us"], "the description counts");

    select.setQuery("espana");
    assert.deepEqual(select.state.visible.map((option) => option.value), ["es"], "and a keyword does");

    select.setQuery("americas");
    assert.deepEqual(select.state.visible.map((option) => option.value), ["us", "mx"], "and so does the group");

    select.setQuery("");
    assert.equal(select.state.visible.length, OPTIONS.length, "an empty query in a select is everything");
});

test("a query that matches nothing reports empty rather than the whole list", () => {
    const select = make({ searchable: true });
    select.setQuery("qqqq");
    assert.deepEqual(select.state.visible, []);
    assert.equal(select.state.empty, true);
    assert.equal(select.state.active, -1, "nothing to highlight, and no index into an empty list");
});

test("the filter is not applied to a select that has no field", () => {
    // The query only exists where there is something to type into: a select without a
    // filter must not end up with a hidden one that empties its list.
    const select = make({ searchable: false });
    select.setQuery("spa");
    assert.equal(select.state.visible.length, OPTIONS.length);
});

test("typing jumps to the row, and typing the same letter again walks through them", () => {
    const select = make();
    select.setOpen(true);
    select.typeahead("m");
    assert.equal(select.state.visible[select.state.active].value, "mx");

    const two = make();
    two.setOpen(true);
    two.typeahead("f");
    assert.equal(two.state.visible[two.state.active].value, "fr");

    // A longer buffer refines rather than jumping: "un" is the United States, not France.
    const word = make();
    word.setOpen(true);
    word.typeahead("u");
    word.typeahead("n");
    assert.equal(word.state.visible[word.state.active].value, "us");
});

test("closing on a choice is the default for one value and not for many", () => {
    const single = make();
    single.setOpen(true);
    single.select("es");
    assert.equal(single.state.open, false);

    const many = make({ multiple: true });
    many.setOpen(true);
    many.select("es");
    assert.equal(many.state.open, true, "picking three things means the panel stays");

    const forced = make({ multiple: true, closeOnSelect: true });
    forced.setOpen(true);
    forced.select("es");
    assert.equal(forced.state.open, false);
});

test("a tag comes off, and clear empties the lot", () => {
    const select = make({ multiple: true, value: ["es", "fr"] });
    select.remove("es");
    assert.deepEqual(select.state.value, ["fr"]);
    select.clear();
    assert.deepEqual(select.state.value, []);
    assert.deepEqual(select.state.selected, []);
});

test("an empty string is nothing chosen, not a value", () => {
    // `value=""` is how React writes an empty controlled field and how HTML writes a
    // placeholder option. Kept as a value it leaves a select showing its placeholder while
    // holding something: a clear button for nothing, and an empty entry posted with the form.
    const select = make({ value: "" });
    assert.deepEqual(select.state.value, []);
    assert.deepEqual(select.state.selected, []);

    const many = make({ multiple: true, value: ["es", ""] });
    assert.deepEqual(many.state.value, ["es"]);
});

test("a value with no option left disappears instead of rendering blank", () => {
    // The list reloaded and the id is gone: the value stays as data, the tag does not.
    const select = make({ multiple: true, value: ["es", "zz"] });
    assert.deepEqual(select.state.selected.map((option) => option.label), ["Spain"]);
    assert.deepEqual(select.state.value, ["es", "zz"]);
});

test("the highlight stays on its row while the filter narrows around it", () => {
    const select = make({ searchable: true });
    select.setOpen(true);
    select.setQuery("m");
    const before = select.state.visible[select.state.active].value;
    select.setQuery("me");
    assert.equal(select.state.visible[select.state.active].value, before, "one more letter is not a reason to move");
});

test("new options reach the list and the filter that searches it", () => {
    const select = make({ searchable: true });
    select.update({ options: [...OPTIONS, { value: "jp", label: "Japan", group: "Asia" }] });
    select.setQuery("jap");
    assert.deepEqual(select.state.visible.map((option) => option.value), ["jp"]);
});

test("an update that changes nothing reports nothing", () => {
    // A renderer subscribes to this and pushes its props back in on every render, so an
    // emit per update is a render per render - the loop, closed here rather than in the
    // one adapter that happened to notice it.
    const select = make({ searchable: true });
    let emits = 0;
    select.subscribe(() => { emits++; });

    select.update({ options: OPTIONS, searchKeys: ["label"], fuseOptions: { threshold: 0.3 } });
    assert.equal(emits, 0, "the same list and a fresh options object are not a change");

    select.update({ options: [...OPTIONS, { value: "jp", label: "Japan" }] });
    assert.equal(emits, 1, "a list that really changed still reports");
});

test("highlighting the row that is already highlighted reports nothing", () => {
    // This arrives from `pointermove`, which fires on every pixel: emitting there redraws
    // the whole panel sixty times a second for a highlight that has not moved.
    const select = make();
    select.setOpen(true);
    let emits = 0;
    select.subscribe(() => { emits++; });

    select.setActive(1);
    select.setActive(1);
    assert.equal(emits, 1);
});

test("every row disabled leaves the highlight nowhere rather than spinning", () => {
    const select = createSelect({ options: [{ value: "a", label: "A", disabled: true }, { value: "b", label: "B", disabled: true }] });
    select.setOpen(true);
    assert.equal(select.state.active, -1);
    select.move("ArrowDown");
    assert.equal(select.state.active, -1);
});
