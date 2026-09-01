import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * The selection list, driven the way a file manager is: clicked with Ctrl and Shift held,
 * walked with the arrows, and dragged over with a rubber band.
 *
 * The set arithmetic is in `selection.test.mjs`, where it needs no browser. What is here is
 * what only a real page can answer: whether the modifiers survive the round trip through a
 * pointer event, whether the container keeps the keyboard, and whether a band drawn over the
 * rows selects the rows it covers.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
    __picked: string[];
    __commands: string[];
}

const files = '[data-testid="files"]';
const list = "[data-enigma-selection-list]";
const item = "[data-enigma-selection-item]";
const selected = "[data-enigma-selection-item][data-selected]";

async function open(page: Page): Promise<void> {
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
}

async function read<K extends keyof FixtureWindow>(page: Page, key: K): Promise<FixtureWindow[K]> {
    return page.evaluate((name) => (window as unknown as Record<string, unknown>)[name], key) as Promise<FixtureWindow[K]>;
}

const row = (page: Page, index: number): Locator => page.locator(`${files} ${item}`).nth(index);

test.describe("Selection list", () => {
    test("a plain click replaces, Ctrl adds, Shift takes the range", async ({ page }) => {
        await open(page);
        await row(page, 1).click();
        expect(await read(page, "__picked")).toEqual(["f1"]);

        await row(page, 5).click({ modifiers: ["ControlOrMeta"] });
        expect(await read(page, "__picked")).toEqual(["f1", "f5"]);

        await row(page, 7).click({ modifiers: ["Shift"] });
        expect(await read(page, "__picked")).toEqual(["f5", "f6", "f7"]);

        await row(page, 0).click();
        expect(await read(page, "__picked")).toEqual(["f0"]);
        await expect(page.locator(`${files} ${selected}`)).toHaveCount(1);
    });

    test("the state is on the row, for the stylesheet to read", async ({ page }) => {
        await open(page);
        await row(page, 2).click();
        await expect(row(page, 2)).toHaveAttribute("data-selected", "");
        await expect(row(page, 2)).toHaveAttribute("aria-selected", "true");
        await expect(row(page, 2)).toHaveAttribute("data-cursor", "");
        await expect(row(page, 3)).toHaveAttribute("data-disabled", "");
    });

    test("Ctrl+A takes everything the list can select and Escape drops it", async ({ page }) => {
        await open(page);
        await page.locator(`${files} ${list}`).focus();
        await page.keyboard.press("ControlOrMeta+a");
        // Nine, not ten: one row cannot be selected, and select-all does not make it so.
        await expect(page.locator(`${files} ${selected}`)).toHaveCount(9);

        await page.keyboard.press("Escape");
        await expect(page.locator(`${files} ${selected}`)).toHaveCount(0);
    });

    test("the arrows move the selection and Shift extends it", async ({ page }) => {
        await open(page);
        await row(page, 0).click();
        await page.keyboard.press("ArrowDown");
        expect(await read(page, "__picked")).toEqual(["f1"]);

        await page.keyboard.press("Shift+ArrowDown");
        await page.keyboard.press("Shift+ArrowDown");
        expect(await read(page, "__picked")).toEqual(["f1", "f2", "f4"], "and it steps over the row that cannot be selected");
    });

    test("the list is one tab stop, with the cursor announced inside it", async ({ page }) => {
        await open(page);
        const container = page.locator(`${files} ${list}`);
        // Two hundred rows that are each tabbable is a list nobody can tab past.
        await expect(container).toHaveAttribute("tabindex", "0");
        await expect(container).toHaveAttribute("aria-multiselectable", "true");
        await row(page, 4).click();
        await expect(container).toHaveAttribute("aria-activedescendant", await row(page, 4).getAttribute("id") ?? "");
    });

    test("a rebound command answers its new key and a removed one answers nothing", async ({ page }) => {
        await open(page);
        await row(page, 1).click();
        await page.keyboard.press("F2");
        await page.keyboard.press("F3");
        await page.keyboard.press("ControlOrMeta+c");
        await page.keyboard.press("Delete");
        // Rename moved to F3, copy was removed outright, and everything untouched still works.
        expect(await read(page, "__commands")).toEqual(["rename", "delete"]);
    });

    test("a key the list has not claimed is left to the page", async ({ page }) => {
        await open(page);
        await row(page, 1).click();
        await page.keyboard.press("q");
        expect(await read(page, "__commands")).toEqual([]);
    });

    test("a band dragged over empty space selects what it covers", async ({ page }) => {
        await open(page);
        const container = (await page.locator(`${files} ${list}`).boundingBox())!;
        const first = (await row(page, 0).boundingBox())!;
        const third = (await row(page, 2).boundingBox())!;

        // Started to the right of the rows, which is empty space: a press that lands ON a row
        // is that row's click and must not begin a band.
        const x = container.x + container.width - 8;
        await page.mouse.move(x, first.y + 2);
        await page.mouse.down();
        await page.mouse.move(first.x + 4, third.y + third.height - 2, { steps: 8 });
        await expect(page.locator("[data-enigma-selection-marquee]")).toBeVisible();
        await page.mouse.up();

        expect(await read(page, "__picked")).toEqual(["f0", "f1", "f2"]);
        await expect(page.locator("[data-enigma-selection-marquee]")).toHaveCount(0);
    });

    test("a right-click outside the selection moves it, and one inside leaves the group alone", async ({ page }) => {
        await open(page);
        await row(page, 1).click();
        await row(page, 2).click({ modifiers: ["ControlOrMeta"] });

        await row(page, 6).click({ button: "right" });
        expect(await read(page, "__picked")).toEqual(["f6"], "acting on a row outside the group selects it first");

        await row(page, 1).click();
        await row(page, 2).click({ modifiers: ["ControlOrMeta"] });
        await row(page, 2).click({ button: "right" });
        expect(await read(page, "__picked")).toEqual(["f1", "f2"], "and inside it the group survives");
    });
});
