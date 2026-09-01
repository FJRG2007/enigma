import test from "node:test";
import assert from "node:assert/strict";
import { parseShortcut, matchesShortcut, shortcutTokens, shortcutText, typeaheadStep, TYPEAHEAD_MS } from "../dist/index.js";

/** A key press, as the DOM reports one. */
const press = (key, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers });

test("a spec is read whichever way it is written", () => {
    assert.deepEqual(parseShortcut("Mod+A"), { key: "a", mod: true });
    assert.deepEqual(parseShortcut("ctrl-shift-n"), { key: "n", ctrl: true, shift: true });
    assert.deepEqual(parseShortcut("F2"), { key: "f2" });
    assert.deepEqual(parseShortcut("Esc"), { key: "escape" }, "the aliases resolve to what the DOM calls the key");
    assert.deepEqual(parseShortcut("Space"), { key: " " });
    // The space bar reports its key as a single space, so a matcher that trims turns
    // Ctrl+Space into Ctrl+nothing and the binding never fires.
    assert.equal(matchesShortcut(press(" ", { ctrlKey: true }), "Mod+Space", false), true);
});

test("a separator can also be the key", () => {
    // `Ctrl++` is a real shortcut - zooming in - and splitting on every + would leave it
    // with no key at all.
    assert.deepEqual(parseShortcut("Ctrl++"), { key: "+", ctrl: true });
    assert.deepEqual(parseShortcut("Ctrl+-"), { key: "-", ctrl: true });
});

test("Mod is Command on an Apple keyboard and Control everywhere else", () => {
    assert.equal(matchesShortcut(press("a", { metaKey: true }), "Mod+A", true), true);
    assert.equal(matchesShortcut(press("a", { ctrlKey: true }), "Mod+A", true), false, "Ctrl+A on a Mac belongs to the terminal, not to us");
    assert.equal(matchesShortcut(press("a", { ctrlKey: true }), "Mod+A", false), true);
    assert.equal(matchesShortcut(press("a", { metaKey: true }), "Mod+A", false), false);
});

test("a modifier the shortcut did not ask for is a different press", () => {
    // Shift+Delete means "delete for good" in every file manager there is, so plain Delete
    // must not answer to it.
    assert.equal(matchesShortcut(press("Delete"), "Delete"), true);
    assert.equal(matchesShortcut(press("Delete", { shiftKey: true }), "Delete"), false);
    assert.equal(matchesShortcut(press("Delete", { shiftKey: true }), "Shift+Delete"), true);
});

test("a list of specs is one binding with several presses", () => {
    assert.equal(matchesShortcut(press("Enter"), ["Enter", "F3"]), true);
    assert.equal(matchesShortcut(press("F3"), ["Enter", "F3"]), true);
    assert.equal(matchesShortcut(press("F4"), ["Enter", "F3"]), false);
    assert.equal(matchesShortcut(press("Enter"), false), false, "false is a command with no binding");
});

test("the label is written the way the platform writes it", () => {
    assert.deepEqual(shortcutTokens("Mod+C", false), ["Ctrl", "C"]);
    assert.deepEqual(shortcutTokens("Mod+C", true), ["⌘", "C"]);
    assert.deepEqual(shortcutTokens("Shift+Delete", false), ["Shift", "Del"]);
    assert.equal(shortcutText("Mod+Shift+A", false), "Ctrl+Shift+A");
    assert.equal(shortcutText("Mod+Shift+A", true), "⇧⌘A");
    assert.equal(shortcutText("F2", false), "F2", "a function key is not one capital letter");
});

test("the typeahead buffer refines, cycles on a repeat, and resets after the gap", () => {
    const first = typeaheadStep({ typed: "", at: 0 }, "u", 1000);
    assert.deepEqual([first.typed, first.needle, first.cycle], ["u", "u", true]);

    // A word refines what the last press found: "un" is the United States, not France.
    const word = typeaheadStep(first, "n", 1100);
    assert.deepEqual([word.typed, word.needle, word.cycle], ["un", "un", false]);

    // The same letter again is nobody typing a word - it is walking through the Rs.
    const repeat = typeaheadStep({ typed: "r", at: 1000 }, "r", 1100);
    assert.deepEqual([repeat.typed, repeat.needle, repeat.cycle], ["rr", "r", true]);

    const late = typeaheadStep({ typed: "un", at: 1000 }, "d", 1000 + TYPEAHEAD_MS + 1);
    assert.deepEqual([late.typed, late.needle, late.cycle], ["d", "d", true], "past the window it starts again");
});
