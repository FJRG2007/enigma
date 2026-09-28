import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * The popups that hang from a trigger, inside the containers that used to cut them off.
 *
 * The select and the colour picker used to be absolutely positioned children of their field,
 * so any `overflow: hidden` ancestor - a card, a dialog body, a scrolling table - clipped
 * them. They are portaled now and placed in viewport coordinates, and what these prove is
 * the part a unit test cannot: where the panel is in the DOM, that it is on screen and on
 * top, that it flips near the bottom of the window, and that it still works inside a modal
 * `<dialog>`, where everything outside the dialog is inert.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
}

const clipped = "[data-testid=clipped]";
const trigger = "[data-enigma-select-trigger]";
const content = "[data-enigma-select-content]";
const options = "[data-enigma-select-option]";
const colourPanel = "[data-enigma-color-panel]";

async function open(page: Page): Promise<void> {
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
}

/** Whether the element is what a press at its middle would reach - nothing painted over it. */
async function topmost(locator: Locator): Promise<boolean> {
    return locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return Boolean(hit && element.contains(hit));
    });
}

test.describe("Floating panels", () => {
    test("the select's panel mounts in <body>, outside the card that clips, and is chosen from", async ({ page }) => {
        await open(page);
        await page.locator(`${clipped} ${trigger}`).scrollIntoViewIfNeeded();
        await page.locator(`${clipped} ${trigger}`).click();

        const panel = page.locator(content);
        await expect(panel).toBeVisible();
        expect(await panel.evaluate((element) => element.parentElement === document.body)).toBe(true);
        expect(await page.locator(clipped).evaluate((card) => card.querySelector("[data-enigma-select-content]"))).toBeNull();

        // Taller than the card it was opened from: in the tree, this is the part that was cut.
        const card = (await page.locator(clipped).boundingBox())!;
        const box = (await panel.boundingBox())!;
        expect(box.height).toBeGreaterThan(card.height);
        // Nothing paints over the last row, which is what "not clipped" means to a pointer.
        const last = page.locator(options).last();
        await last.scrollIntoViewIfNeeded();
        expect(await topmost(last)).toBe(true);

        // At least as wide as the trigger and no wider than its content needs - not the 28rem
        // cap it would stretch to if its width came from the window it is now positioned in.
        const triggerBox = (await page.locator(`${clipped} ${trigger}`).boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(triggerBox.width - 0.5);
        expect(box.width).toBeLessThan(triggerBox.width * 1.5);

        await page.locator(options).filter({ hasText: "Mexico" }).click();
        await expect(panel).toBeHidden();
        await expect(page.locator(`${clipped} ${trigger}`)).toContainText("Mexico");
    });

    test("near the bottom of the window it opens upwards, and stays on screen", async ({ page }) => {
        await open(page);
        // The window ends just under the trigger: no room below it, plenty above.
        const below = (await page.locator(`${clipped} ${trigger}`).boundingBox())!;
        const height = Math.ceil(below.y + below.height + 16);
        await page.setViewportSize({ width: 1280, height });
        await page.locator(`${clipped} ${trigger}`).click();

        const panel = page.locator(content);
        await expect(panel).toHaveAttribute("data-side", "top");
        const box = (await panel.boundingBox())!;
        const triggerBox = (await page.locator(`${clipped} ${trigger}`).boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual(triggerBox.y);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
    });

    test("in a window too short for the list, the list is capped and scrolls inside the panel", async ({ page }) => {
        await open(page);
        await page.setViewportSize({ width: 800, height: 220 });
        await page.locator(clipped).evaluate((card) => card.scrollIntoView({ block: "center" }));
        await page.locator(`${clipped} ${trigger}`).click();

        const panel = page.locator(content);
        await expect(panel).toBeVisible();
        const box = (await panel.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(220);
        const list = page.locator("[data-enigma-select-list]");
        expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    });

    test("it follows its trigger when the page scrolls under it", async ({ page }) => {
        await open(page);
        await page.locator(clipped).evaluate((card) => card.scrollIntoView({ block: "center" }));
        await page.locator(`${clipped} ${trigger}`).click();
        const panel = page.locator(content);
        await expect(panel).toBeVisible();

        const gap = async (): Promise<number> => {
            const [a, b] = [await panel.boundingBox(), await page.locator(`${clipped} ${trigger}`).boundingBox()];
            return Math.round(a!.y - (b!.y + b!.height));
        };
        // 4px under the trigger once the opening slide has settled, and still 4px after the
        // page has moved 40px under it - which a fixed panel that was not re-placed is not.
        await expect.poll(gap).toBe(4);
        const top = (await page.locator(`${clipped} ${trigger}`).boundingBox())!.y;
        await page.evaluate(() => window.scrollBy(0, 40));
        await expect.poll(async () => Math.round(top - (await page.locator(`${clipped} ${trigger}`).boundingBox())!.y)).toBe(40);
        await expect.poll(gap).toBe(4);
    });

    test("Tab off the portaled search field goes to what follows the trigger, Shift+Tab to the trigger", async ({ page }) => {
        await open(page);
        const many = "[data-testid=many]";
        await page.locator(`${many} ${trigger}`).click();
        await expect(page.locator("[data-enigma-select-search]")).toBeFocused();

        await page.keyboard.press("Shift+Tab");
        await expect(page.locator(`${many} ${trigger}`)).toBeFocused();
        await expect(page.locator(content)).toBeHidden();

        await page.keyboard.press("Enter");
        await expect(page.locator("[data-enigma-select-search]")).toBeFocused();
        await page.keyboard.press("Tab");
        // The next select in the fixture, exactly where Tab went when the panel sat in the tree.
        await expect(page.locator(`[data-testid=inline] ${trigger}`)).toBeFocused();
    });

    test("the colour picker escapes the same card, and a press inside it does not close it", async ({ page }) => {
        await open(page);
        await page.locator(`${clipped} [data-enigma-color-swatch]`).scrollIntoViewIfNeeded();
        await page.locator(`${clipped} [data-enigma-color-swatch]`).click();

        const panel = page.locator(colourPanel);
        await expect(panel).toBeVisible();
        expect(await panel.evaluate((element) => element.parentElement === document.body)).toBe(true);
        expect(await topmost(page.locator(`${colourPanel} [data-enigma-color-rail=hue]`))).toBe(true);

        await page.locator(`${colourPanel} [data-enigma-color-preset][title="#22c55e"]`).click();
        await expect(panel).toBeVisible();
        await expect(page.locator("[data-testid=clipped-colour]")).toHaveValue("#22c55e");

        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);
        await expect(page.locator(`${clipped} [data-enigma-color-swatch]`)).toBeFocused();
    });

    test("inside a modal <dialog> the panel goes into the dialog, where it can be pressed", async ({ page }) => {
        await open(page);
        await page.locator("[data-testid=open-dialog]").click();
        const dialog = page.locator("[data-testid=dialog]");
        await expect(dialog).toBeVisible();

        await dialog.locator(trigger).click();
        const panel = page.locator(content);
        await expect(panel).toBeVisible();
        expect(await panel.evaluate((element) => element.parentElement?.getAttribute("data-testid"))).toBe("dialog");
        // Out of the 60px scrolling region it was opened from.
        const region = (await dialog.locator("div").first().boundingBox())!;
        expect((await panel.boundingBox())!.height).toBeGreaterThan(region.height);

        await page.locator(options).filter({ hasText: "France" }).click();
        await expect(page.locator("[data-testid=dialog-picked]")).toHaveText("fr");
        // The dialog is still open: the press was inside it, not outside.
        await expect(dialog).toBeVisible();
    });
});
