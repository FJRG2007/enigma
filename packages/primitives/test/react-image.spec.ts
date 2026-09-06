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

interface Rect { x: number; y: number; width: number; height: number; }

/**
 * Where the picture actually IS on each animation frame for the next `ms`.
 *
 * The rectangle rather than the scale: a thumbnail the same size as the fitted picture flies
 * without changing size at all, so a scale-only sampler would have called that no animation.
 * Measured off the element, and started before the press that begins the flight - the rule the
 * marquee's measurements are written under.
 */
async function flightPath(page: Page, ms: number): Promise<Rect[]> {
    return page.evaluate((duration) => new Promise<Rect[]>((resolve) => {
        const seen: Rect[] = [];
        const started = performance.now();
        const sample = (): void => {
            const picture = document.querySelector("[data-enigma-image-frame] img");
            // Only frames the reader can see: the picture is in the DOM before it has been
            // measured, and where it sits then is not where it is drawn.
            if (picture && getComputedStyle(picture).visibility !== "hidden") {
                const box = picture.getBoundingClientRect();
                seen.push({ x: box.x, y: box.y, width: box.width, height: box.height });
            }
            if (performance.now() - started < duration) requestAnimationFrame(sample);
            else resolve(seen);
        };
        requestAnimationFrame(sample);
    }), ms);
}

/** How far two rectangles are from being the same one. */
function apart(a: Rect, b: Rect): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
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

    /**
     * The picture flies out of the page rather than a dialog appearing over it.
     *
     * FLIP: the full-size image is laid out where it belongs, measured, then drawn back ON the
     * thumbnail and released - so what is asserted is that the first frames are the thumbnail's
     * scale and the last is the fitted one.
     */
    test("the picture flies out of the thumbnail and back into it", async ({ page }) => {
        await open(page);
        // Measured where it will BE when it is pressed: a press scrolls the trigger into view,
        // and a rectangle read at another scroll position is a rectangle from another page.
        await page.locator(`${plain} [data-enigma-image-trigger]`).scrollIntoViewIfNeeded();
        const thumbnail = await page.locator(`${plain} img`).first().boundingBox();
        if (!thumbnail) throw new Error("the thumbnail has no box");

        const sampling = flightPath(page, 600);
        await page.click(`${plain} [data-enigma-image-trigger]`);
        const opening = await sampling;

        expect(opening.length).toBeGreaterThan(5);
        // It travelled, and it settled somewhere else: that is the trip.
        const landed = opening[opening.length - 1]!;
        const trip = apart(landed, thumbnail);
        expect(trip).toBeGreaterThan(20);

        // And the first frame anybody sees is essentially ON the thumbnail, which is the whole
        // trick - without it the picture simply appears in the middle of a dialog. A fraction
        // rather than a pixel: the first visible frame is a frame or two into a 300ms
        // transition, and pinning it exactly would be timing the machine rather than the code.
        expect(apart(opening[0]!, thumbnail)).toBeLessThan(trip / 4);
        await expect(page.locator(viewer)).toHaveAttribute("data-state", "open");

        const closing = flightPath(page, 600);
        await page.keyboard.press("Escape");
        const back = await closing;
        // And on the way out it goes home before the dialog does.
        expect(apart(back[back.length - 1]!, thumbnail)).toBeLessThan(trip / 4);
        await expect(page.locator(viewer)).toHaveCount(0);
    });

    test("a reader who asked for less movement gets no flight at all", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page);
        // Asserted, not assumed: the project's device descriptor has swallowed this emulation
        // before, and a preference that never applied would make the rest of this a false pass.
        expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

        await page.click(`${plain} [data-enigma-image-trigger]`);
        // Open outright: no "opening" phase to pass through, and the picture is where it
        // belongs from the first frame rather than on its way there.
        await expect(page.locator(viewer)).toHaveAttribute("data-state", "open");
        expect(await scale(page)).toBeCloseTo(1, 2);

        await page.keyboard.press("Escape");
        await expect(page.locator(viewer)).toHaveCount(0);
    });

    /**
     * The cursor says what a press does, which in a lightbox is three different things: the
     * thumbnail enlarges, the empty part of the frame closes, and the picture zooms - then
     * becomes something you drag.
     */
    test("the cursor says what each part of the viewer does", async ({ page }) => {
        await open(page);
        const cursor = (selector: string) => page.locator(selector).first().evaluate((node) => getComputedStyle(node).cursor);

        expect(await cursor(`${plain} img`)).toBe("zoom-in");

        await page.click(`${plain} [data-enigma-image-trigger]`);
        await expect(page.locator(viewer)).toHaveAttribute("data-state", "open");
        expect(await cursor(frame)).toBe("zoom-out");
        expect(await cursor(`${frame} img`)).toBe("zoom-in");

        await wheelOverFrame(page, -240);
        expect(await scale(page)).toBeGreaterThan(1);
        // Once there is somewhere to pan to, the gesture is a drag.
        expect(await cursor(`${frame} img`)).toBe("grab");
    });

    test("the picture is announced, and the page behind it cannot scroll", async ({ page }) => {
        await open(page);
        await expect(page.locator(`${plain} [data-enigma-image-trigger]`)).toHaveAttribute("aria-label", "On its own");

        await page.click(`${plain} [data-enigma-image-trigger]`);
        await page.waitForSelector(frame);
        expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
        await page.keyboard.press("Escape");
        // Given back when the dialog actually goes, which is the end of the flight home.
        await expect(page.locator(viewer)).toHaveCount(0);
        expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    });
});
