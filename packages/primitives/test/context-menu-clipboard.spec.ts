import { test, expect, type Page } from "@playwright/test";

/**
 * Copy, Cut and Paste in the context menu.
 *
 * Every assertion here needs a real browser: what counts as a selection, what a password field
 * refuses, and whether the text actually reached the system clipboard are not things a unit
 * test can answer.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
    __chosen: string[];
}

async function open(page: Page): Promise<void> {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
}

const panel = "[data-enigma-menu-panel]";
const row = "[data-enigma-menu-item]";

/** Every row the open menu shows, in order. */
async function rows(page: Page): Promise<string[]> {
    return page.locator(`${panel} [data-enigma-menu-item-label]`).allInnerTexts();
}

/** Select everything in a field, then right-click it. */
async function openOver(page: Page, selector: string, selectAll = true): Promise<void> {
    await page.click(selector);
    if (selectAll) await page.keyboard.press("ControlOrMeta+a");
    await page.click(selector, { button: "right" });
    await expect(page.locator(panel)).toBeVisible();
}

async function clipboard(page: Page): Promise<string> {
    return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("Context menu: the clipboard rows", () => {
    test("a selection in a writable field gets all three, above the caller's own rows", async ({ page }) => {
        await open(page);
        await openOver(page, "[data-testid=notes]");
        // On top and separated: they act on the SELECTION, not on the thing the menu was
        // opened over, which is what the caller's rows are for.
        expect(await rows(page)).toEqual(["Copy", "Cut", "Paste", "Do something"]);
        await expect(page.locator(`${panel} [data-enigma-menu-separator]`)).toHaveCount(1);
    });

    test("they are off with one prop", async ({ page }) => {
        await open(page);
        await openOver(page, "[data-testid=plain-notes]");
        expect(await rows(page)).toEqual(["Do something"]);
    });

    test("a read-only field can be copied out of, never cut or pasted into", async ({ page }) => {
        await open(page);
        await openOver(page, "[data-testid=frozen]");
        expect(await rows(page)).toEqual(["Copy", "Do something"]);
    });

    test("a password field is pasted into and never copied out of", async ({ page }) => {
        await open(page);
        await openOver(page, "[data-testid=secret]");
        // The clipboard is shared with every application on the machine and is not cleared:
        // a menu that copies a masked value leaks it somewhere nobody can see.
        expect(await rows(page)).toEqual(["Paste", "Do something"]);
    });

    test("plain text offers Copy alone, and only where something is selected", async ({ page }) => {
        await open(page);
        await page.click("[data-testid=prose]", { button: "right" });
        await expect(page.locator(panel)).toBeVisible();
        expect(await rows(page)).toEqual(["Do something"]);
        await page.keyboard.press("Escape");

        await page.locator("[data-testid=prose]").dblclick();
        await page.click("[data-testid=prose]", { button: "right" });
        expect(await rows(page)).toEqual(["Copy", "Do something"]);
    });

    test("Copy puts the selection on the system clipboard, and reports the row", async ({ page }) => {
        await open(page);
        await page.evaluate(() => navigator.clipboard.writeText(""));
        await openOver(page, "[data-testid=notes]");
        await page.click(`${panel} ${row}`, { position: { x: 10, y: 5 } });

        expect(await clipboard(page)).toBe("hello world");
        // Performed by the menu AND reported, so a caller can log it or undo it.
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__chosen)).toContain("enigma:clipboard:copy");
    });

    test("Cut copies and then empties the field, through React's own state", async ({ page }) => {
        await open(page);
        await openOver(page, "[data-testid=notes]");
        await page.click(`${panel} ${row}:nth-of-type(2)`);

        expect(await clipboard(page)).toBe("hello world");
        await expect(page.locator("[data-testid=notes]")).toHaveValue("");
    });

    test("Paste puts the clipboard in at the caret, which the menu had taken focus from", async ({ page }) => {
        await open(page);
        await page.evaluate(() => navigator.clipboard.writeText("pasted"));
        await openOver(page, "[data-testid=notes]");
        await page.click(`${panel} ${row}:nth-of-type(3)`);

        // The whole value: the selection the menu was opened over is what a paste replaces,
        // and restoring it after the panel took focus is the part that is easy to lose.
        await expect(page.locator("[data-testid=notes]")).toHaveValue("pasted");
    });

    test("Paste is greyed rather than dropped when the clipboard is known to be empty", async ({ page }) => {
        await open(page);
        await page.evaluate(() => navigator.clipboard.writeText(""));
        await openOver(page, "[data-testid=notes]");
        // Only knowable because the permission is granted in this test; without it the row
        // stays enabled rather than a prompt being raised to decide how to draw a menu.
        await expect(page.locator(`${panel} ${row}:nth-of-type(3)`)).toHaveAttribute("data-disabled", "", { timeout: 2000 });
    });
});
