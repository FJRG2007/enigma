import test from "node:test";
import assert from "node:assert/strict";
import { createContextMenu } from "../dist/index.js";

/** A menu with every shape in it: furniture, a disabled row, a submenu and a fetched one. */
const ITEMS = [
    { id: "open", label: "Open", shortcut: "Enter" },
    { id: "rename", label: "Rename", shortcut: "F2" },
    { type: "separator" },
    { id: "share", label: "Share", items: [
        { id: "link", label: "Copy link" },
        { id: "email", label: "Email" }
    ] },
    { id: "locked", label: "Move", disabled: true },
    { type: "separator" },
    { id: "delete", label: "Delete", destructive: true, shortcut: "Delete" }
];

const point = { x: 10, y: 10 };
const make = (options = {}) => createContextMenu({ items: ITEMS, ...options });

/** The row at a position in the deepest level, whatever kind it is. */
function row(menu, level = menu.state.levels.length - 1) {
    const open = menu.state.levels[level];
    return open.visible[open.active];
}

test("a menu with nothing to show does not open", () => {
    const empty = createContextMenu({ items: [] });
    assert.equal(empty.open(point), false);
    assert.equal(empty.state.open, false);

    // Furniture is not something to show: a menu of two separators is still empty.
    const furniture = createContextMenu({ items: [{ type: "separator" }, { type: "label", label: "Nothing" }] });
    assert.equal(furniture.open(point), false, "separators and captions are not rows");

    const real = make();
    assert.equal(real.open(point), true);
    assert.equal(real.state.open, true);
});

test("an open menu is not closed by a press that could not open one", () => {
    const menu = make();
    menu.open(point);
    menu.update({ items: [] });
    // The root level is rebuilt empty, but the menu it was already showing stays put rather
    // than vanishing halfway through a click.
    assert.equal(menu.open({ x: 40, y: 40 }), false);
    assert.equal(menu.state.open, true);
});

test("the highlight skips furniture and disabled rows", () => {
    const menu = make();
    menu.open(point);
    menu.move("ArrowDown");
    assert.equal(row(menu).id, "open", "the first press lands on the first row, not on -1 + 1");
    menu.move("ArrowDown");
    assert.equal(row(menu).id, "rename");
    menu.move("ArrowDown");
    assert.equal(row(menu).id, "share", "the separator is stepped over");
    menu.move("ArrowDown");
    assert.equal(row(menu).id, "delete", "so is the row that cannot be chosen");
    menu.move("ArrowDown");
    assert.equal(row(menu).id, "open", "and the walk wraps rather than stopping");
});

test("ArrowUp from nothing highlighted lands on the last row", () => {
    const menu = make();
    menu.open(point);
    // A menu opened at the pointer highlights nothing, so the first ArrowUp is the End key:
    // the row before "the row before the first" is the LAST one, not the one above it.
    menu.move("ArrowUp");
    assert.equal(row(menu).id, "delete");
    menu.move("ArrowUp");
    assert.equal(row(menu).id, "share", "and the one that cannot be chosen is stepped over");
});

test("a disabled row is listed, never invoked", () => {
    const chosen = [];
    const menu = make({ onSelect: (item) => chosen.push(item.id) });
    menu.open(point);
    const index = menu.state.levels[0].visible.findIndex((entry) => entry.id === "locked");
    menu.select(0, index);
    assert.deepEqual(chosen, [], "a click that got through still must not invoke it");
    assert.equal(menu.state.open, true, "and it does not close the menu either");
});

test("choosing a row closes the menu before the handler runs", () => {
    let openWhenHandled = null;
    const menu = createContextMenu({
        items: ITEMS,
        // The handler usually opens a dialog or moves focus, and a menu still on screen
        // underneath it steals the next Escape.
        onSelect: () => { openWhenHandled = menu.state.open; }
    });
    menu.open(point);
    menu.select(0, 0);
    assert.equal(openWhenHandled, false);
    assert.equal(menu.state.levels.length, 0);
});

test("a submenu is a level, and Left goes back to the row that opened it", () => {
    const menu = make();
    menu.open(point);
    const share = menu.state.levels[0].visible.findIndex((entry) => entry.id === "share");
    menu.openSubmenu(0, share);
    assert.equal(menu.state.levels.length, 2);
    assert.deepEqual(menu.state.levels[1].path, ["share"]);

    menu.leaveSubmenu();
    assert.equal(menu.state.levels.length, 1);
    assert.equal(row(menu).id, "share", "and the highlight is back where it came from");
});

test("a submenu the pointer opened highlights nothing; one the keyboard opened does", () => {
    const hovered = make();
    hovered.open(point);
    const share = hovered.state.levels[0].visible.findIndex((entry) => entry.id === "share");
    hovered.openSubmenu(0, share);
    // A row that looks hovered before the pointer has reached it reads as the menu having
    // chosen something on your behalf.
    assert.equal(hovered.state.levels[1].active, -1);
    // And the arrows still start at the top from there, rather than at nothing.
    hovered.move("ArrowDown");
    assert.equal(row(hovered).id, "link");

    const keyed = make();
    keyed.open(point);
    keyed.move("ArrowDown");
    keyed.move("ArrowDown");
    keyed.move("ArrowDown");
    keyed.enterSubmenu();
    assert.equal(row(keyed).id, "link", "ArrowRight has to land somewhere");
});

test("a fetched submenu highlights a row only when the keyboard asked for it", async () => {
    const rows = [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }];
    const hovered = createContextMenu({ items: [{ id: "tags", label: "Tags", loadItems: async () => rows }] });
    hovered.open(point);
    hovered.openSubmenu(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Decided when the branch was ASKED for, not when it answered - by then nobody knows
    // which of the two opened it.
    assert.equal(hovered.state.levels[1].active, -1);

    const keyed = createContextMenu({ items: [{ id: "tags", label: "Tags", loadItems: async () => rows }] });
    keyed.open(point);
    keyed.move("ArrowDown");
    keyed.enterSubmenu();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(keyed.state.levels[1].active, 0);
});

test("asking again for the branch already open leaves it exactly as it is", async () => {
    const menu = make();
    menu.open(point);
    const share = menu.state.levels[0].visible.findIndex((entry) => entry.id === "share");

    // Choosing the row opens the branch with a row on it, and the hover timer that was
    // already running fires a beat later. It must not undo the press that beat it.
    menu.select(0, share);
    assert.equal(menu.state.levels[1].active, 0);
    menu.setQuery(1, "link");
    menu.openSubmenu(0, share);
    assert.equal(menu.state.levels[1].active, 0, "the highlight survives the late hover");
    assert.equal(menu.state.levels[1].query, "link", "and so does what was typed into it");

    // Clicking the parent of a branch hovering already opened still puts a row under the
    // reader, and the pointer passing back over that parent does not take it away again.
    const hovered = make();
    hovered.open(point);
    hovered.openSubmenu(0, share);
    assert.equal(hovered.state.levels[1].active, -1);
    hovered.select(0, share);
    assert.equal(row(hovered).id, "link", "choosing the row it is on gives the branch a row");
    hovered.openSubmenu(0, share);
    assert.equal(hovered.state.levels[1].active, 0, "a re-hover does not empty that highlight");

    let asked = 0;
    const fetched = createContextMenu({ items: [{ id: "tags", label: "Tags", loadItems: async () => { asked += 1; return [{ id: "red", label: "Red" }]; } }] });
    fetched.open(point);
    fetched.openSubmenu(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fetched.openSubmenu(0, 0);
    assert.equal(fetched.state.levels[1].loading, false, "the answered branch is not put back into loading");
    assert.equal(asked, 1, "and the request is not made twice");
});

test("an empty items list is not a submenu", () => {
    const menu = createContextMenu({ items: [{ id: "share", label: "Share", items: [] }, { id: "open", label: "Open" }] });
    menu.open(point);
    menu.openSubmenu(0, 0);
    assert.equal(menu.state.levels.length, 1, "there is nothing to open, so nothing opens");
});

test("a fetched submenu is asked for once and cached", async () => {
    let calls = 0;
    const menu = createContextMenu({
        items: [{ id: "tags", label: "Tags", loadItems: async () => { calls++; return [{ id: "red", label: "Red" }]; } }]
    });

    menu.open(point);
    menu.openSubmenu(0, 0);
    assert.equal(menu.state.levels[1].loading, true, "loading, not empty - the two look identical otherwise");

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(menu.state.levels[1].loading, false);
    assert.equal(menu.state.levels[1].visible[0].id, "red");

    // Closed and reopened: the rows are already there, so the branch never flashes a spinner
    // for something it fetched a moment ago.
    menu.close();
    menu.open(point);
    menu.openSubmenu(0, 0);
    assert.equal(menu.state.levels[1].loading, false, "the cache answers before the promise would");
    assert.equal(calls, 1);

    menu.invalidate(["tags"]);
    menu.close();
    menu.open(point);
    menu.openSubmenu(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 2, "invalidating is what makes the next open ask again");
});

test("a submenu that rejects says so instead of showing nothing", async () => {
    const menu = createContextMenu({
        items: [{ id: "tags", label: "Tags", loadItems: async () => { throw new Error("Offline"); } }]
    });
    menu.open(point);
    menu.openSubmenu(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(menu.state.levels[1].error?.message, "Offline");

    // Not cached: a failure that stuck would leave the branch broken until the page reloads.
    menu.close();
    menu.open(point);
    menu.openSubmenu(0, 0);
    assert.equal(menu.state.levels[1].loading, true, "the retry is the next open");
});

test("the filter keeps only the furniture that still divides something", () => {
    const many = Array.from({ length: 14 }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}` }));
    const menu = createContextMenu({
        items: [{ type: "label", label: "Recent" }, ...many, { type: "separator" }, { id: "other", label: "Something else" }]
    });
    menu.open(point);
    assert.equal(menu.state.levels[0].searchable, true, "fifteen rows is past the point a filter earns its space");

    menu.setQuery(0, "Row 3");
    const visible = menu.state.levels[0].visible;
    assert.deepEqual(visible.map((entry) => entry.id ?? entry.type), ["label", "row-3"]);
    // The separator introduced a block that is gone, so drawing it would be a rule with
    // nothing on either side of it.
    assert.equal(visible.some((entry) => entry.type === "separator"), false);

    menu.setQuery(0, "nothing at all");
    assert.equal(menu.state.levels[0].visible.length, 0);
    assert.equal(menu.state.levels[0].active, -1, "and the highlight is nowhere rather than on row 0");
});

test("typeahead walks the rows starting with the letter", () => {
    const menu = createContextMenu({
        items: [{ id: "a", label: "Rename" }, { id: "b", label: "Refresh" }, { id: "c", label: "Delete" }]
    });
    menu.open(point);
    menu.typeahead("r");
    assert.equal(row(menu).id, "a");
    menu.typeahead("r");
    assert.equal(row(menu).id, "b", "the same letter again walks to the next one");
    menu.typeahead("d");
    assert.equal(row(menu).id, "b", "a buffer that matches nothing leaves the highlight where it was");

    // A word refines rather than cycling: "de" is Delete, and it is found from the top.
    const word = createContextMenu({
        items: [{ id: "a", label: "Rename" }, { id: "b", label: "Refresh" }, { id: "c", label: "Delete" }]
    });
    word.open(point);
    word.typeahead("d");
    word.typeahead("e");
    assert.equal(row(word).id, "c");
});

test("reopening starts clean", () => {
    const menu = make();
    menu.open(point);
    const share = menu.state.levels[0].visible.findIndex((entry) => entry.id === "share");
    menu.openSubmenu(0, share);
    menu.close();

    menu.open({ x: 90, y: 90 });
    assert.equal(menu.state.levels.length, 1, "a menu that comes back with a branch still expanded is one you have to reset");
    assert.deepEqual(menu.state.point, { x: 90, y: 90 });
});

test("a title is the level's, and a submenu can carry its own", () => {
    const menu = createContextMenu({
        title: "report.pdf",
        items: [{ id: "share", label: "Share", title: "Share report.pdf", items: [{ id: "link", label: "Copy link" }] }]
    });
    menu.open(point);
    assert.equal(menu.state.levels[0].title, "report.pdf");
    menu.openSubmenu(0, 0);
    assert.equal(menu.state.levels[1].title, "Share report.pdf");
});

/**
 * A filter is chrome until there are enough rows to be worth filtering.
 *
 * The threshold used to be eight, which is a menu you can still read at a glance - the video
 * player's own menu, at nine rows, grew a search field nobody asked for. And the ROOT level had
 * no way to be told either way: only a submenu's item could carry `searchable`, so a menu whose
 * rows are fetched could not ask for one before it had them.
 */
test("the filter arrives when there are enough rows, or when it is asked for", () => {
    const rows = (count) => Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}` }));
    const searchable = (options) => {
        const menu = createContextMenu(options);
        menu.open(point);
        return menu.state.levels[0].searchable;
    };

    assert.equal(searchable({ items: rows(9) }), false, "nine rows is a shape, not a list");
    assert.equal(searchable({ items: rows(12) }), true);
    // Whatever the count, both ways.
    assert.equal(searchable({ items: rows(3), searchable: true }), true, "a menu that is about to fill itself");
    assert.equal(searchable({ items: rows(30), searchable: false }), false, "and one that would rather not");
});

test("the root's filter can be turned on after it is open", () => {
    const menu = createContextMenu({ items: [{ id: "one", label: "One" }] });
    menu.open(point);
    assert.equal(menu.state.levels[0].searchable, false);

    menu.update({ items: [{ id: "one", label: "One" }], searchable: true });
    assert.equal(menu.state.levels[0].searchable, true);
});
