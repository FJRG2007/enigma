import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * The context menu, driven the way a desktop one is: opened with a right-click at the
 * pointer, walked with the arrows, crossed diagonally into a submenu, and dismissed by
 * pressing somewhere else.
 *
 * What is asserted here is what a DOM cannot be faked into: where the panel is placed against
 * the window, whether it survives the pointer crossing a sibling row on the way to it, and
 * whether the press that opened it also chose something. The rules that are arithmetic - the
 * highlight, the filter, the cache - are in `context-menu.test.mjs`, where they need no browser.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
    __chosen: string[];
    __menuLoads: number;
}

const area = '[data-testid="menu-area"]';
const emptyArea = '[data-testid="empty-menu-area"]';
const panel = "[data-enigma-menu-panel]";
const item = "[data-enigma-menu-item]";

async function open(page: Page): Promise<void> {
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
}

async function read<K extends keyof FixtureWindow>(page: Page, key: K): Promise<FixtureWindow[K]> {
    return page.evaluate((name) => (window as unknown as Record<string, unknown>)[name], key) as Promise<FixtureWindow[K]>;
}

/** Right-click inside the trigger, at a point in the window rather than at its centre. */
async function rightClick(page: Page, selector: string, position?: { x: number; y: number; }): Promise<void> {
    await page.locator(`${selector} [data-enigma-menu-trigger]`).click({ button: "right", position });
}

const row = (page: Page, label: string): Locator => page.locator(item).filter({ hasText: label }).first();

test.describe("Context menu", () => {
    test("a right-click opens it at the pointer and a press elsewhere dismisses it", async ({ page }) => {
        await open(page);
        await expect(page.locator(panel)).toHaveCount(0);

        await rightClick(page, area, { x: 30, y: 20 });
        const menu = page.locator(panel).first();
        await expect(menu).toBeVisible();

        // At the pointer, not at the corner of the element and not at 0,0: the whole point of
        // a context menu is that it appears where the press was.
        const trigger = await page.locator(`${area} [data-enigma-menu-trigger]`).boundingBox();
        const box = await menu.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(trigger!.x + 30 - 2);
        expect(box!.y).toBeGreaterThanOrEqual(trigger!.y + 20 - 2);

        await page.mouse.click(5, 5);
        await expect(page.locator(panel)).toHaveCount(0);
    });

    test("the heading names what the menu acts on", async ({ page }) => {
        await open(page);
        await rightClick(page, area);
        await expect(page.locator("[data-enigma-menu-title]")).toHaveText("report.pdf");
        // The panel is named by its heading, so a screen reader says what the rows apply to.
        await expect(page.locator(panel).first()).toHaveAttribute("aria-label", "report.pdf");
    });

    test("a menu with nothing to show does not open at all", async ({ page }) => {
        await open(page);
        await rightClick(page, emptyArea);
        // No empty box, and no swallowed press either: with nothing to offer, the browser's
        // own menu is better than ours.
        await expect(page.locator(panel)).toHaveCount(0);
    });

    test("the press that opened it does not also choose a row", async ({ page }) => {
        await open(page);
        // The menu appears under the pointer on `contextmenu`, and the release of that same
        // press lands on whatever row is now beneath it.
        await rightClick(page, area, { x: 10, y: 10 });
        await expect(page.locator(panel).first()).toBeVisible();
        expect(await read(page, "__chosen")).toEqual([]);
    });

    test("a row is chosen on the release, and the menu closes with it", async ({ page }) => {
        await open(page);
        await rightClick(page, area);
        await row(page, "Rename").click();
        expect(await read(page, "__chosen")).toEqual(["rename"]);
        await expect(page.locator(panel)).toHaveCount(0);
    });

    test("a disabled row is listed, announced and never chosen", async ({ page }) => {
        await open(page);
        await rightClick(page, area);
        const locked = row(page, "Move");
        await expect(locked).toBeVisible();
        await expect(locked).toHaveAttribute("aria-disabled", "true");
        await locked.click({ force: true });
        expect(await read(page, "__chosen")).toEqual([]);
        await expect(page.locator(panel).first()).toBeVisible();
    });

    test("the shortcut is printed on the right of its row", async ({ page }) => {
        await open(page);
        await rightClick(page, area);
        const rename = row(page, "Rename");
        await expect(rename.locator("[data-enigma-menu-shortcut]")).toHaveText("F2");
        // Announced through the attribute rather than the glyphs, which are decoration.
        await expect(rename).toHaveAttribute("aria-keyshortcuts", "F2");

        const label = await rename.locator("[data-enigma-menu-item-label]").boundingBox();
        const shortcut = await rename.locator("[data-enigma-menu-shortcut]").boundingBox();
        expect(shortcut!.x).toBeGreaterThan(label!.x + label!.width);
    });

    test("a submenu opens on a hover and survives the pointer crossing a sibling", async ({ page }) => {
        await open(page);
        await rightClick(page, area);
        const share = row(page, "Share");
        await share.hover();
        await expect(page.locator(panel)).toHaveCount(2);

        const submenu = page.locator(panel).nth(1);
        const link = submenu.locator(item).first();
        const box = await link.boundingBox();

        // The way out of a submenu passes over its siblings. Closing on the first crossing is
        // what makes a nested menu impossible to reach diagonally, so this is the assertion
        // the hover delay exists for.
        const tags = await row(page, "Tags").boundingBox();
        await page.mouse.move(tags!.x + tags!.width - 4, tags!.y + tags!.height / 2);
        await page.mouse.move(box!.x + 10, box!.y + box!.height / 2);
        await expect(page.locator(panel)).toHaveCount(2);

        await link.click();
        expect(await read(page, "__chosen")).toEqual(["share/link"]);
    });

    test("a fetched submenu says it is loading, then caches what it got", async ({ page }) => {
        await open(page);
        await rightClick(page, area);
        await row(page, "Tags").hover();

        await expect(page.locator("[data-enigma-menu-status]")).toHaveText("Loading...");
        await expect(page.locator(panel).nth(1).locator(item).first()).toHaveText("Red");
        expect(await read(page, "__menuLoads")).toBe(1);

        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await rightClick(page, area);
        await row(page, "Tags").hover();
        // The rows are there before the promise would have resolved, which is what makes a
        // slow branch bearable the second time.
        await expect(page.locator(panel).nth(1).locator(item).first()).toHaveText("Red");
        expect(await read(page, "__menuLoads")).toBe(1);
    });

    test("the keyboard walks the rows, opens a submenu with Right and goes back with Left", async ({ page }) => {
        await open(page);
        await rightClick(page, area);

        await page.keyboard.press("ArrowDown");
        await expect(page.locator(`${item}[data-active]`)).toHaveText(/Open/);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        // Move is disabled, so the third press is on Share rather than on it.
        await expect(page.locator(`${item}[data-active]`)).toHaveText(/Share/);

        await page.keyboard.press("ArrowRight");
        await expect(page.locator(panel)).toHaveCount(2);
        await page.keyboard.press("ArrowLeft");
        await expect(page.locator(panel)).toHaveCount(1);

        // Enter on a row that HAS a submenu opens it rather than invoking it - there is
        // nothing to invoke, and every desktop menu treats the two keys the same way here.
        await page.keyboard.press("Enter");
        await expect(page.locator(panel)).toHaveCount(2);
        await page.keyboard.press("Enter");
        expect(await read(page, "__chosen")).toEqual(["share/link"]);
    });

    test("Escape closes one level at a time and hands focus back", async ({ page }) => {
        await open(page);
        await rightClick(page, area);
        await row(page, "Share").hover();
        await expect(page.locator(panel)).toHaveCount(2);

        await page.keyboard.press("Escape");
        await expect(page.locator(panel)).toHaveCount(1, { timeout: 2000 });
        await page.keyboard.press("Escape");
        await expect(page.locator(panel)).toHaveCount(0);
        // Focus on the body would leave a keyboard visitor tabbing from the top of the page.
        await expect(page.locator(`${area} [data-enigma-menu-trigger]`)).toBeFocused();
    });

    test("Shift+F10 opens it without a pointer", async ({ page }) => {
        await open(page);
        await page.locator(`${area} [data-enigma-menu-trigger]`).focus();
        await page.keyboard.press("Shift+F10");
        // A menu only a right-click can open is one a keyboard user cannot open at all.
        await expect(page.locator(panel).first()).toBeVisible();
    });

    test("it opens upwards and leftwards rather than off the screen", async ({ page }) => {
        await open(page);
        const size = page.viewportSize()!;
        const trigger = page.locator(`${area} [data-enigma-menu-trigger]`);
        const box = (await trigger.boundingBox())!;

        // Scrolled so the trigger sits at the bottom right, then right-clicked in its far
        // corner: placed naively the panel would hang off both edges and be unreachable.
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.mouse.move(box.x, box.y);
        await trigger.click({ button: "right", position: { x: box.width - 1, y: box.height - 1 } });

        const panelBox = (await page.locator(panel).first().boundingBox())!;
        expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(size.width);
        expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(size.height);
    });
});
