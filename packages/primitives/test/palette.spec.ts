import { test, expect, type Page } from "@playwright/test";

/**
 * The palette, driven the way it is actually used: from the keyboard.
 *
 * Every assertion here is about a key doing what the footer says it does. A palette that
 * only works with a mouse is a dropdown with extra steps, and the failures that make one
 * feel broken - Enter opening the wrong row, Escape leaving focus nowhere, the highlight
 * running off the end of a shorter list - are all keyboard failures.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
    __selected: string;
    __presses: number;
}

const content = "[data-enigma-palette-content]";
const field = "[data-enigma-palette-field]";
const items = "[data-enigma-palette-item]";
const active = '[data-enigma-palette-item][data-active="true"]';
const groups = "[data-enigma-palette-group]";

async function open(page: Page): Promise<void> {
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
    // Storage is shared between tests in one browser, and a leftover history changes what
    // the first row is - which is exactly what several of these assert.
    await page.evaluate(() => window.localStorage.removeItem("test:palette"));
}

async function read<K extends keyof FixtureWindow>(page: Page, key: K): Promise<FixtureWindow[K]> {
    return page.evaluate((name) => (window as unknown as Record<string, unknown>)[name], key) as Promise<FixtureWindow[K]>;
}

test.describe("SearchPalette", () => {
    test("nothing of it is in the document until it opens", async ({ page }) => {
        await open(page);
        await expect(page.locator(content)).toHaveCount(0);
    });

    test("the shortcut opens it and Escape closes it", async ({ page }) => {
        await open(page);
        await page.keyboard.press("Control+k");
        await expect(page.locator(content)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator(content)).toHaveCount(0);
    });

    test("closing hands focus back to the trigger", async ({ page }) => {
        await open(page);
        await page.locator("[data-enigma-palette-trigger]").click();
        await expect(page.locator(field)).toBeFocused();
        await page.keyboard.press("Escape");
        // Without this, dismissing from the keyboard drops the visitor at the top of the
        // document with nothing focused.
        await expect(page.locator("[data-enigma-palette-trigger]")).toBeFocused();
    });

    test("typing filters, and the results keep their groups", async ({ page }) => {
        await open(page);
        await page.keyboard.press("Control+k");
        await page.locator(field).fill("in");
        await expect(page.locator(items)).toHaveCount(2);
        await expect(page.locator(groups)).toHaveCount(2);
        // Which group comes first is the engine's ranking, not a contract - only that both
        // are there, and that each row sits under the one it belongs to.
        const labels = await page.locator(groups).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
        expect(new Set(labels)).toEqual(new Set(["Components", "Guides"]));
    });

    test("the arrows move one flat sequence through every group", async ({ page }) => {
        await open(page);
        await page.keyboard.press("Control+k");
        await page.locator(field).fill("in");
        // Rendered order, whatever the ranking put where. The point is that the sequence
        // runs straight through the group boundary between these two rows.
        const rendered = await page.locator(items).allInnerTexts();
        expect(rendered).toHaveLength(2);

        await expect(page.locator(active)).toHaveText(rendered[0]);
        await page.keyboard.press("ArrowDown");
        await expect(page.locator(active)).toHaveText(rendered[1]);
        await page.keyboard.press("ArrowDown");
        // And it wraps: the row after the last one is the first.
        await expect(page.locator(active)).toHaveText(rendered[0]);
        await page.keyboard.press("ArrowUp");
        await expect(page.locator(active)).toHaveText(rendered[1]);
    });

    test("the letters only have to be in order, which is what a palette needs", async ({ page }) => {
        await open(page);
        await page.keyboard.press("Control+k");
        // Not a substring of anything: "cmdplt" is Command palette with the vowels left out,
        // and a substring filter finds nothing at all here.
        await page.locator(field).fill("mrqe");
        await expect(page.locator(items)).toHaveCount(1);
        await expect(page.locator(items).first()).toHaveText(/Marquee/);
    });

    test("the field keeps the caret while the highlight moves", async ({ page }) => {
        await open(page);
        await page.keyboard.press("Control+k");
        await page.locator(field).fill("in");
        await page.keyboard.press("ArrowDown");
        await expect(page.locator(field)).toBeFocused();
        // Which is why the row is announced through the field rather than by focusing it.
        const described = await page.locator(field).getAttribute("aria-activedescendant");
        const activeId = await page.locator(active).getAttribute("id");
        expect(described).toBe(activeId);
    });

    test("Enter runs the highlighted row and closes", async ({ page }) => {
        await open(page);
        await page.keyboard.press("Control+k");
        await page.locator(field).fill("flag");
        await page.keyboard.press("Enter");
        expect(await read(page, "__selected")).toBe("/flags");
        await expect(page.locator(content)).toHaveCount(0);
    });

    test("what was searched is offered again next time", async ({ page }) => {
        await open(page);
        await page.keyboard.press("Control+k");
        await page.locator(field).fill("marquee");
        await page.keyboard.press("Enter");

        await page.keyboard.press("Control+k");
        // An empty query opens on what was chosen before, which is the whole point of
        // keeping it: the second visit is one keystroke shorter than the first.
        await expect(page.locator(groups).first()).toHaveAttribute("aria-label", "Recent");
        await expect(page.locator(items).first()).toHaveText(/Marquee/);
    });

    test("a shorter list never leaves the highlight past its end", async ({ page }) => {
        await open(page);
        await page.keyboard.press("Control+k");
        await page.locator(field).fill("in");
        await page.keyboard.press("ArrowDown");
        await page.locator(field).fill("flags");
        // One row now, so the highlight has to come back to it - otherwise Enter opens
        // nothing and the palette looks broken.
        await expect(page.locator(items)).toHaveCount(1);
        await expect(page.locator(active)).toHaveCount(1);
    });

    test("the pointer moves the same highlight the keyboard uses", async ({ page }) => {
        await open(page);
        await page.keyboard.press("Control+k");
        await page.locator(field).fill("in");
        const second = await page.locator(items).nth(1).innerText();
        await page.locator(items).nth(1).hover();
        // Two highlights on screen is what makes a palette feel unpredictable: Enter then
        // opens the row the mouse is not on.
        await expect(page.locator(active)).toHaveCount(1);
        await expect(page.locator(active)).toHaveText(second);
    });
});

test.describe("Button shortcut hint", () => {
    test("a labelled button shows its key, an icon-only one does not", async ({ page }) => {
        await open(page);
        await expect(page.locator('[data-testid="hinted"] [data-enigma-button-key]')).toHaveText("s");
        await expect(page.locator('[data-testid="icon-only"] [data-enigma-button-key]')).toHaveCount(0);
    });

    test("the key is announced rather than read out as part of the label", async ({ page }) => {
        await open(page);
        const button = page.locator('[data-testid="hinted"]');
        await expect(button).toHaveAttribute("aria-keyshortcuts", "s");
        await expect(button.locator("[data-enigma-button-key]")).toHaveAttribute("aria-hidden", "true");
    });
});
