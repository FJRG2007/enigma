import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * The colour picker, in a real browser.
 *
 * The assertions that matter are the ones a unit test cannot make: that a drag on the square
 * does not reset the hue rail, that the value reaches a CONTROLLED field, and that the panel
 * behaves like a popup - Escape, a press outside, and focus that comes back where it started.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
    __color: string;
    __submits: number;
}

async function open(page: Page): Promise<void> {
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
}

const scope = "[data-testid=colour]";
const field = "[data-testid=colour-field]";
const swatch = `${scope} [data-enigma-color-swatch]`;
const panel = `${scope} [data-enigma-color-panel]`;
const area = `${scope} [data-enigma-color-area]`;
const hue = `${scope} [data-enigma-color-rail=hue]`;
const alpha = `${scope} [data-enigma-color-rail=alpha]`;

async function colour(page: Page): Promise<string> {
    return page.evaluate(() => (window as unknown as FixtureWindow).__color);
}

/**
 * Press at a point given as a fraction of the element's own box, and release there.
 *
 * Kept a pixel inside on every side: `box.y + box.height` is the row BELOW the element, so a
 * press at the bottom edge lands on whatever is under it and the control never sees it.
 */
async function pressAt(page: Page, locator: Locator, x: number, y: number): Promise<void> {
    const box = await locator.boundingBox();
    if (!box) throw new Error("the control has no box to press");
    const inside = (start: number, size: number, at: number): number => start + Math.min(Math.max(size * at, 1), size - 1);
    await page.mouse.move(inside(box.x, box.width, x), inside(box.y, box.height, y));
    await page.mouse.down();
    await page.mouse.up();
}

test.describe("Input type=color (React)", () => {
    test("the field is a text input holding the canonical value, with a swatch beside it", async ({ page }) => {
        await open(page);
        // Never the native `type="color"`: its popup is the operating system's, and its value
        // can only ever be six digits.
        await expect(page.locator(field)).toHaveAttribute("type", "text");
        await expect(page.locator(field)).toHaveValue("#3b82f6");
        await expect(page.locator(`${scope} [data-enigma-input-field] [data-enigma-color-swatch]`)).toHaveCount(1);
        await expect(page.locator(panel)).toHaveCount(0);
    });

    test("the swatch opens the panel without submitting the form around it", async ({ page }) => {
        await open(page);
        await page.click(swatch);
        await expect(page.locator(panel)).toBeVisible();
        // A bare <button> inside a form defaults to submit: opening a picker would post the
        // half-filled form. The same trap the password reveal has.
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__submits)).toBe(0);
        await expect(page.locator(swatch)).toHaveAttribute("aria-expanded", "true");
    });

    test("Escape closes it and hands focus back to the swatch", async ({ page }) => {
        await open(page);
        await page.click(swatch);
        // Focus goes into the panel on open, so the arrows drive the square straight away.
        await expect(page.locator(area)).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator(panel)).toHaveCount(0);
        await expect(page.locator(swatch)).toBeFocused();
    });

    test("a press outside closes it; a press on the panel's own padding does not", async ({ page }) => {
        await open(page);
        await page.click(swatch);
        // The gap between the square and the rails is not "outside": treating the blur it
        // causes as leaving would shut the panel whenever somebody clicks a gap.
        await pressAt(page, page.locator(panel), 0.5, 0.99);
        await expect(page.locator(panel)).toBeVisible();

        await page.click("[data-testid=submit]", { force: true, position: { x: 1, y: 1 } });
        await expect(page.locator(panel)).toHaveCount(0);
    });

    test("dragging the hue rail writes the new colour into the controlled field", async ({ page }) => {
        await open(page);
        await page.click(swatch);
        await pressAt(page, page.locator(hue), 0.33, 0.5);

        const next = await colour(page);
        expect(next).not.toBe("#3b82f6");
        // React's own state has it - the value went through the prototype's setter and a real
        // input event, which is what makes a controlled field see it at all.
        await expect(page.locator(field)).toHaveValue(next);
        await expect(page.locator(hue)).toHaveAttribute("aria-valuenow", /^1[12]\d$/);
    });

    test("the hue survives a trip through black, which is the bug this component exists for", async ({ page }) => {
        await open(page);
        await page.click(swatch);
        const before = await page.locator(hue).getAttribute("aria-valuenow");
        expect(Number(before)).toBeGreaterThan(200);

        // Bottom left: no saturation and no brightness, so every channel is the same byte.
        // A grey has no hue to recover, and a picker that re-derives it from the RGB shows
        // red from here on - the rail jumping under the finger that put it there.
        // Not the exact corner: the square is rounded, so the last few pixels of one fall
        // outside its own shape and the press lands on the panel behind it.
        await pressAt(page, page.locator(area), 0.03, 0.97);
        const grey = await colour(page);
        const channels = [1, 3, 5].map((at) => Number.parseInt(grey.slice(at, at + 2), 16));
        expect(Math.max(...channels)).toBeLessThan(16);
        await expect(page.locator(hue)).toHaveAttribute("aria-valuenow", before ?? "");

        // And back out: the same hue as before, not red.
        await pressAt(page, page.locator(area), 0.97, 0.03);
        await expect(page.locator(hue)).toHaveAttribute("aria-valuenow", before ?? "");
        const back = await colour(page);
        expect(back).not.toBe("#ff0000");
    });

    test("the arrows drive the square and the rails, and the hue wraps", async ({ page }) => {
        await open(page);
        await page.click(swatch);

        await page.locator(area).focus();
        const saturation = Number(await page.locator(area).getAttribute("aria-valuenow"));
        await page.keyboard.press("ArrowRight");
        expect(Number(await page.locator(area).getAttribute("aria-valuenow"))).toBe(saturation + 1);

        await page.locator(hue).focus();
        await page.keyboard.press("Home");
        await expect(page.locator(hue)).toHaveAttribute("aria-valuenow", "0");
        // The spectrum is a circle: stopping at red on one side makes half the wheel a walk.
        await page.keyboard.press("ArrowLeft");
        await expect(page.locator(hue)).toHaveAttribute("aria-valuenow", "359");
    });

    test("the alpha rail writes the eighth and ninth digits, and only when it is asked for", async ({ page }) => {
        await open(page);
        await page.click(swatch);
        await pressAt(page, page.locator(alpha), 0.5, 0.5);
        expect(await colour(page)).toMatch(/^#[0-9a-f]{6}[0-9a-f]{2}$/);
    });

    test("a preset is chosen as a colour, not as a string", async ({ page }) => {
        await open(page);
        await page.click(swatch);
        await page.click(`${scope} [data-enigma-color-preset][title="#22c55e"]`);
        expect(await colour(page)).toBe("#22c55e");
        await expect(page.locator(`${scope} [data-enigma-color-preset][title="#22c55e"]`)).toHaveAttribute("aria-pressed", "true");
    });

    test("what was typed is normalized on blur, and never while it is being typed", async ({ page }) => {
        await open(page);
        await page.fill(field, "rgb(255, 0, 0)");
        // Still exactly what was typed: rewriting mid-keystroke fights the caret.
        await expect(page.locator(field)).toHaveValue("rgb(255, 0, 0)");
        await page.locator(field).blur();
        await expect(page.locator(field)).toHaveValue("#ff0000");
        expect(await colour(page)).toBe("#ff0000");
    });

    test("an unparseable value leaves the swatch empty rather than stale", async ({ page }) => {
        await open(page);
        await page.fill(field, "#3b8");
        await expect(page.locator(swatch)).not.toHaveAttribute("data-invalid", "");
        await page.fill(field, "not a colour");
        // A swatch still showing the last good colour says the field is fine when it is not.
        await expect(page.locator(swatch)).toHaveAttribute("data-invalid", "");
    });
});
