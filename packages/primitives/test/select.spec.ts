import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * The select, driven the way the native one is: with the keyboard, and with the mouse, and
 * with neither of them able to reach a row that is disabled.
 *
 * A listbox that replaces `<select>` has to give back everything the platform was doing for
 * free - the typeahead, the arrow keys, the value the form posts, the announcement - so
 * that is what these assert. The look is not tested here beyond the one thing that is not
 * cosmetic: the panel has to be drawn at all, because an unstyled popup is unreadable.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
    __country: string;
    __stack: string[];
    __renders: number;
}

const single = '[data-testid="country"]';
const multi = '[data-testid="stack"]';
const many = '[data-testid="many"]';
const inline = '[data-testid="inline"]';
const trigger = "[data-enigma-select-trigger]";
const content = "[data-enigma-select-content]";
const options = "[data-enigma-select-option]";
const active = "[data-enigma-select-option][data-active]";
const search = "[data-enigma-select-search]";

async function open(page: Page): Promise<void> {
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
}

async function read<K extends keyof FixtureWindow>(page: Page, key: K): Promise<FixtureWindow[K]> {
    return page.evaluate((name) => (window as unknown as Record<string, unknown>)[name], key) as Promise<FixtureWindow[K]>;
}

const at = (page: Page, root: string, selector: string): Locator => page.locator(`${root} ${selector}`);

test.describe("Select", () => {
    test("the panel is closed until the trigger is pressed, and Escape puts focus back", async ({ page }) => {
        await open(page);
        await expect(at(page, single, content)).toHaveCount(0);

        await at(page, single, trigger).click();
        await expect(at(page, single, content)).toBeVisible();
        await expect(at(page, single, trigger)).toHaveAttribute("aria-expanded", "true");

        await page.keyboard.press("Escape");
        await expect(at(page, single, content)).toBeHidden();
        // Focus on the body would leave a keyboard visitor tabbing from the top of the page.
        await expect(at(page, single, trigger)).toBeFocused();
    });

    test("a choice replaces the value and closes the panel", async ({ page }) => {
        await open(page);
        await at(page, single, trigger).click();
        await at(page, single, options).filter({ hasText: "France" }).click();

        expect(await read(page, "__country")).toBe("fr");
        await expect(at(page, single, content)).toBeHidden();
        await expect(at(page, single, trigger)).toContainText("France");
    });

    test("the arrow keys skip the disabled row, and Enter takes the highlighted one", async ({ page }) => {
        await open(page);
        await at(page, single, trigger).focus();
        await page.keyboard.press("ArrowDown");
        await expect(at(page, single, content)).toBeVisible();

        // Spain is where it opens; the next two presses are France and then Portugal,
        // because Germany is disabled and the highlight does not stop there.
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await expect(at(page, single, active)).toContainText("Portugal");

        await page.keyboard.press("Enter");
        expect(await read(page, "__country")).toBe("pt");
    });

    test("a disabled row cannot be chosen by clicking it either", async ({ page }) => {
        await open(page);
        await at(page, single, trigger).click();
        // Forced past Playwright's own actionability check, which is the point: the
        // component has to refuse the click rather than rely on the pointer never arriving.
        await at(page, single, options).filter({ hasText: "Germany" }).click({ force: true });

        expect(await read(page, "__country")).toBe("");
        await expect(at(page, single, content)).toBeVisible();
    });

    test("typing jumps to the option, the way the native control does", async ({ page }) => {
        await open(page);
        await at(page, single, trigger).focus();
        await page.keyboard.press("m");
        await expect(at(page, single, content)).toBeVisible();
        await expect(at(page, single, active)).toContainText("Mexico");
    });

    test("many values keep the panel open, and each one becomes a tag", async ({ page }) => {
        await open(page);
        await at(page, multi, trigger).click();
        await at(page, multi, options).filter({ hasText: "Spain" }).click();
        await at(page, multi, options).filter({ hasText: "Mexico" }).click();

        await expect(at(page, multi, content)).toBeVisible();
        expect(await read(page, "__stack")).toEqual(["es", "mx"]);
        await expect(at(page, multi, "[data-enigma-select-tag]")).toHaveCount(2);
    });

    test("the × on a tag removes that value without opening the panel", async ({ page }) => {
        await open(page);
        await at(page, multi, trigger).click();
        await at(page, multi, options).filter({ hasText: "Spain" }).click();
        await page.keyboard.press("Escape");
        await expect(at(page, multi, content)).toBeHidden();

        await at(page, multi, "[data-enigma-select-tag-remove]").first().click();
        expect(await read(page, "__stack")).toEqual([]);
        await expect(at(page, multi, content)).toBeHidden();
    });

    test("a long enough list brings its own filter, and the filter narrows the list", async ({ page }) => {
        await open(page);
        await at(page, multi, trigger).click();
        // Nine options: past the threshold, so the field is there without being asked for.
        await expect(at(page, multi, search)).toBeVisible();
        await expect(at(page, multi, search)).toBeFocused();

        await at(page, multi, search).fill("bra");
        await expect(at(page, multi, options)).toHaveCount(1);
        await expect(at(page, multi, options)).toContainText("Brazil");

        await at(page, multi, search).fill("qqq");
        await expect(at(page, multi, "[data-enigma-select-empty]")).toBeVisible();
    });

    test("a shorter list has no filter, so the panel is the list", async ({ page }) => {
        await open(page);
        await at(page, single, trigger).click();
        await expect(at(page, single, search)).toHaveCount(0);
    });

    test("the value reaches a plain form as a hidden field", async ({ page }) => {
        await open(page);
        await at(page, single, trigger).click();
        await at(page, single, options).filter({ hasText: "Italy" }).click();

        const posted = await page.locator(`${single} input[type="hidden"]`).inputValue();
        expect(posted).toBe("it");
        expect(await page.locator(`${single} input[type="hidden"]`).getAttribute("name")).toBe("country");
    });

    test("the panel is drawn, not left transparent over the page", async ({ page }) => {
        await open(page);
        await at(page, single, trigger).click();

        const panel = at(page, single, content);
        const background = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
        // The one visual assertion worth making: a popup with no background is text lying
        // on top of the page, which is broken rather than merely unstyled.
        expect(background).not.toBe("rgba(0, 0, 0, 0)");
        await expect(page.locator("head [data-enigma-select-styles]")).toHaveCount(1);
    });

    test("the listbox says what it is, and the options say whether they are chosen", async ({ page }) => {
        await open(page);
        await at(page, multi, trigger).click();

        const list = at(page, multi, "[data-enigma-select-list]");
        await expect(list).toHaveAttribute("role", "listbox");
        await expect(list).toHaveAttribute("aria-multiselectable", "true");

        const spain = at(page, multi, options).filter({ hasText: "Spain" });
        await expect(spain).toHaveAttribute("aria-selected", "false");
        await spain.click();
        await expect(spain).toHaveAttribute("aria-selected", "true");
        await expect(at(page, multi, options).filter({ hasText: "Germany" })).toHaveAttribute("aria-disabled", "true");
    });

    test("a long list reaches the document a window at a time", async ({ page }) => {
        await open(page);
        await at(page, many, trigger).click();

        // Two hundred options with an icon each: rendering the lot is what made the panel
        // slow to open, and only about seven of them can be seen.
        const rows = at(page, many, options);
        await expect(rows).toHaveCount(40);

        // Scrolling to the end of what is rendered brings the next chunk.
        await at(page, many, "[data-enigma-select-list]").evaluate((list) => { list.scrollTop = list.scrollHeight; });
        await expect(rows).not.toHaveCount(40);
    });

    test("the keyboard reaches a row the scroll never rendered", async ({ page }) => {
        await open(page);
        await at(page, many, trigger).click();
        // PageDown moves five at a time; ten of them is row 50, well past the first window
        // and reached without scrolling at all.
        for (let press = 0; press < 10; press++) await page.keyboard.press("PageDown");
        await expect(at(page, many, active)).toContainText("Row 50");
    });

    test("options written inline do not send the page into a render loop", async ({ page }) => {
        await open(page);
        // `options={[...]}` is a new array of new objects on every render. Pushing that into
        // the instance on identity would emit a new state, render again, and never stop.
        await at(page, inline, trigger).click();
        const first = await read(page, "__renders");
        await page.waitForTimeout(400);
        expect(await read(page, "__renders")).toBe(first);
    });

    test("a click outside closes it without choosing anything", async ({ page }) => {
        await open(page);
        await at(page, single, trigger).click();
        await expect(at(page, single, content)).toBeVisible();

        await page.locator("body").click({ position: { x: 5, y: 5 } });
        await expect(at(page, single, content)).toBeHidden();
        expect(await read(page, "__country")).toBe("");
    });
});
