import { test, expect, type Page } from "@playwright/test";

/**
 * The image viewer, in a real browser.
 *
 * What a unit test cannot reach is here: that a wheel notch zooms towards the cursor rather
 * than scrolling the page behind the dialog, that the arrows and the strip agree on which
 * picture is showing, that a discarded image is gone from both, and that the defaults really
 * are only "open it and zoom it".
 */

interface FixtureWindow extends Window {
    __ready: boolean;
    __discarded: string[];
    __imageIndex: number;
}

const gallery = "[data-testid=gallery]";
const plain = "[data-testid=plain-image]";
const viewer = "[data-enigma-image-viewer]";
const frame = "[data-enigma-image-frame]";
const strip = "[data-enigma-image-strip]";

async function open(page: Page): Promise<void> {
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
}

/** The scale currently applied to the picture, read off the element rather than off state. */
async function scale(page: Page): Promise<number> {
    const transform = await page.locator(`${viewer} img`).first().evaluate((node) => getComputedStyle(node).transform);
    if (transform === "none") return 1;
    return Number(transform.slice(transform.indexOf("(") + 1).split(",")[0]);
}

async function wheelOverFrame(page: Page, deltaY: number): Promise<void> {
    const box = await page.locator(frame).boundingBox();
    if (!box) throw new Error("the frame has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, deltaY);
    // The transform is applied on the next frame; without this the read races the render.
    await page.waitForTimeout(60);
}

test.describe("Image", () => {
    test("a press opens the viewer, and Escape closes it and gives focus back", async ({ page }) => {
        await open(page);
        await expect(page.locator(viewer)).toHaveCount(0);

        await page.click(`${plain} [data-enigma-image-trigger]`);
        await expect(page.locator(viewer)).toBeVisible();
        await expect(page.locator(viewer)).toHaveAttribute("aria-modal", "true");

        await page.keyboard.press("Escape");
        await expect(page.locator(viewer)).toHaveCount(0);
        // Focus goes back where the press came from, or the next Tab starts at the top of
        // the page rather than beside the image.
        await expect(page.locator(`${plain} [data-enigma-image-trigger]`)).toBeFocused();
    });

    test("the defaults are the press and the zoom, and nothing else", async ({ page }) => {
        await open(page);
        await page.click(`${plain} [data-enigma-image-trigger]`);

        // Off until asked for: no arrows, no strip, no menu, no discard.
        await expect(page.locator("[data-enigma-image-nav]")).toHaveCount(0);
        await expect(page.locator(strip)).toHaveCount(0);
        await expect(page.locator("[data-enigma-image-menu]")).toHaveCount(0);
        await expect(page.locator("[aria-label='Discard this image']")).toHaveCount(0);
        // On: the zoom controls, and the wheel.
        await expect(page.locator("[aria-label='Zoom in']")).toBeVisible();
        await wheelOverFrame(page, -200);
        expect(await scale(page)).toBeGreaterThan(1);
    });

    test("the wheel zooms the picture instead of scrolling the page behind it", async ({ page }) => {
        await open(page);
        await page.click(`${plain} [data-enigma-image-trigger]`);
        await page.waitForSelector(frame);
        // Read AFTER opening: the press itself scrolls the image into view, and that is the
        // page position the wheel must not move.
        const before = await page.evaluate(() => window.scrollY);
        await wheelOverFrame(page, -240);

        expect(await scale(page)).toBeGreaterThan(1);
        expect(await page.evaluate(() => window.scrollY)).toBe(before);
        await expect(page.locator(frame)).toHaveAttribute("data-zoomed", "");

        // And back out, which is the same gesture: a viewer that only zooms in is a trap.
        await wheelOverFrame(page, 600);
        expect(await scale(page)).toBe(1);
    });

    test("the keyboard zooms and resets", async ({ page }) => {
        await open(page);
        await page.click(`${plain} [data-enigma-image-trigger]`);
        await page.waitForSelector(frame);

        await page.keyboard.press("+");
        expect(await scale(page)).toBeGreaterThan(1);
        await page.keyboard.press("0");
        expect(await scale(page)).toBe(1);
    });

    test("the arrows and the counter move through the set", async ({ page }) => {
        await open(page);
        await page.click(`${gallery} [data-enigma-image-trigger]`);

        await expect(page.locator("[data-enigma-image-counter]").first()).toHaveText("1 of 3");
        await page.click("[data-enigma-image-nav=next]");
        await expect(page.locator("[data-enigma-image-counter]").first()).toHaveText("2 of 3");
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__imageIndex)).toBe(1);

        // The keyboard is the same control, and the ends wrap round.
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("[data-enigma-image-counter]").first()).toHaveText("3 of 3");
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("[data-enigma-image-counter]").first()).toHaveText("1 of 3");
    });

    test("the strip shows every picture and says which one is up", async ({ page }) => {
        await open(page);
        await page.click(`${gallery} [data-enigma-image-trigger]`);

        await expect(page.locator(`${strip} [data-enigma-image-thumb]`)).toHaveCount(3);
        await expect(page.locator("[data-enigma-image-thumb][aria-current=true]")).toHaveAttribute("aria-label", "The first picture");

        await page.click(`${strip} [data-enigma-image-thumb] >> nth=2`);
        await expect(page.locator("[data-enigma-image-thumb][aria-current=true]")).toHaveAttribute("aria-label", "The third picture");
        await expect(page.locator("[data-enigma-image-counter]").first()).toHaveText("3 of 3");
    });

    test("discarding takes the picture out of the set and moves on", async ({ page }) => {
        await open(page);
        await page.click(`${gallery} [data-enigma-image-trigger]`);
        await page.click("[aria-label='Discard this image']");

        // Reported to the caller, who owns the list, and gone from both the counter and the
        // strip - a discarded image that is still in the row was not discarded.
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__discarded)).toEqual(["The first picture"]);
        await expect(page.locator("[data-enigma-image-counter]").first()).toHaveText("1 of 2");
        await expect(page.locator(`${strip} [data-enigma-image-thumb]`)).toHaveCount(2);
        await expect(page.locator("[data-enigma-image-thumb][aria-current=true]")).toHaveAttribute("aria-label", "The second picture");
    });

    test("discarding the last one closes the viewer rather than showing nothing", async ({ page }) => {
        await open(page);
        await page.click(`${gallery} [data-enigma-image-trigger]`);
        for (let at = 0; at < 3; at += 1) await page.click("[aria-label='Discard this image']");
        await expect(page.locator(viewer)).toHaveCount(0);
    });

    test("the menu is the context menu, opened from the dots", async ({ page }) => {
        await open(page);
        await page.click(`${gallery} [data-enigma-image-trigger]`);

        const dots = page.locator("[data-enigma-image-menu]");
        await expect(dots).toBeVisible();
        await expect(dots).toHaveAttribute("aria-haspopup", "menu");
        await dots.click();

        await expect(page.locator("[data-enigma-menu-panel]")).toBeVisible();
        await expect(page.locator("[data-enigma-menu-item]", { hasText: "Download" })).toBeVisible();
        // A lightbox has nothing writable in it, so the menu's own clipboard rows stand down.
        await expect(page.locator("[data-enigma-menu-item]", { hasText: "Paste" })).toHaveCount(0);
    });

    test("a press beside the picture closes it; one on the picture does not", async ({ page }) => {
        await open(page);
        await page.click(`${plain} [data-enigma-image-trigger]`);
        await page.waitForSelector(frame);

        const picture = await page.locator(`${viewer} img`).first().boundingBox();
        if (!picture) throw new Error("the picture has no box");
        await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
        await expect(page.locator(viewer)).toBeVisible();

        // The dark area beside it is the backdrop, whatever element it belongs to: this is
        // how every lightbox is closed, and answering only the few pixels outside the frame
        // is the same as not answering at all.
        const box = await page.locator(frame).boundingBox();
        if (!box) throw new Error("the frame has no box");
        await page.mouse.click(box.x + 6, box.y + box.height / 2);
        await expect(page.locator(viewer)).toHaveCount(0);
    });

    test("the picture is announced, and the page behind it cannot scroll", async ({ page }) => {
        await open(page);
        await expect(page.locator(`${plain} [data-enigma-image-trigger]`)).toHaveAttribute("aria-label", "On its own");

        await page.click(`${plain} [data-enigma-image-trigger]`);
        await page.waitForSelector(frame);
        expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
        await page.keyboard.press("Escape");
        expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    });
});
