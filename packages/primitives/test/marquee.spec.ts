import { test, expect, type Page } from "@playwright/test";
import { sampleTransform, toSpeeds, median, largestFrameStep, period } from "./measure";

const CRUISE = 80;

interface FixtureWindow extends Window {
    __navigations: number;
    __clicks: number;
    __ready: boolean;
}

async function open(page: Page, params: Record<string, string | number> = {}): Promise<void> {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    await page.goto(`/test/fixture/index.html?${query}`);
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
    // The lap is read once the copies are in and the fonts have settled.
    await expect.poll(() => period(page)).toBeGreaterThan(0);
}

async function laneCentre(page: Page): Promise<{ x: number; y: number; }> {
    const box = await page.getByTestId("lane").boundingBox();
    if (!box) throw new Error("lane has no box");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A real touch drag, dispatched through the browser's input pipeline.
 *
 * Playwright's touchscreen only taps, and a wheel does not consult `touch-action`,
 * so neither can tell whether the lane still lets the page scroll.
 */
async function touchSwipe(page: Page, from: { x: number; y: number; }, to: { x: number; y: number; }, steps = 12): Promise<void> {
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
    for (let step = 1; step <= steps; step++) {
        await client.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{
                x: from.x + ((to.x - from.x) * step) / steps,
                y: from.y + ((to.y - from.y) * step) / steps
            }]
        });
        await page.waitForTimeout(16);
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await client.detach();
}

/** A hard flick: several real frames of movement, then a release. */
async function flick(page: Page, distancePerFrame: number, frames: number): Promise<void> {
    const start = await laneCentre(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let index = 1; index <= frames; index++) {
        await page.mouse.move(start.x + distancePerFrame * index, start.y);
        await page.waitForTimeout(16);
    }
    await page.mouse.up();
}

test.describe("marquee", () => {
    test("runs at the same speed regardless of the item count", async ({ page }) => {
        const measured: number[] = [];
        for (const items of [2, 9, 11, 20]) {
            await open(page, { items, speed: CRUISE });
            // The same easing that softens a release also softens the start:
            // 0.12^t leaves under 1% of the gap after ~2.2s.
            await page.waitForTimeout(2600);
            const lap = await period(page);
            measured.push(median(toSpeeds(await sampleTransform(page, 700), lap)));
        }
        for (const speed of measured) expect(Math.abs(speed - CRUISE) / CRUISE).toBeLessThan(0.01);
    });

    test("a 200px swipe moves the row 200px", async ({ page }) => {
        await open(page, { speed: 0 });
        const start = await laneCentre(page);
        const before = await page.evaluate(() =>
            new DOMMatrixReadOnly(getComputedStyle(document.querySelector("[data-testid=track]")!).transform).m41);

        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        // Leftwards, so the offset grows and the assertion is not chasing a wrap.
        await page.mouse.move(start.x - 200, start.y, { steps: 20 });
        const after = await page.evaluate(() =>
            new DOMMatrixReadOnly(getComputedStyle(document.querySelector("[data-testid=track]")!).transform).m41);
        await page.mouse.up();

        expect(Math.abs(after - before)).toBeGreaterThan(199);
        expect(Math.abs(after - before)).toBeLessThan(201);
    });

    test("a release decays onto the cruise speed without a sign flip", async ({ page }) => {
        await open(page, { speed: CRUISE });
        await page.waitForTimeout(400);
        await flick(page, -24, 8);

        const lap = await period(page);
        const speeds = toSpeeds(await sampleTransform(page, 3000), lap);
        const bucket = Math.floor(speeds.length / 6);
        const at = (index: number) => median(speeds.slice(index * bucket, (index + 1) * bucket));

        expect(at(0)).toBeGreaterThan(CRUISE * 3);
        expect(at(0)).toBeGreaterThan(at(1));
        expect(at(1)).toBeGreaterThan(at(2));
        expect(at(2)).toBeGreaterThan(at(4));
        // Settles exactly on cruise, and never crosses zero on the way.
        expect(Math.abs(at(5) - CRUISE) / CRUISE).toBeLessThan(0.05);
        for (const speed of speeds) expect(speed).toBeGreaterThan(0);
    });

    test("four viewport resizes produce no anomalous frame", async ({ page }) => {
        await open(page, { speed: CRUISE });
        await page.waitForTimeout(400);
        const lap = await period(page);

        const sampling = sampleTransform(page, 3000);
        for (const width of [900, 500, 1200, 700]) {
            await page.setViewportSize({ width, height: 720 });
            await page.waitForTimeout(120);
        }
        const samples = await sampling;

        // One frame of ordinary cruising, at the clamped maximum delta.
        expect(largestFrameStep(samples, lap)).toBeLessThanOrEqual(CRUISE * 0.05 + 0.5);
    });

    test("a drag that ends on a link opens nothing", async ({ page }) => {
        await open(page, { speed: 0 });
        const target = page.getByTestId("item-2");
        const box = await target.boundingBox();
        if (!box) throw new Error("item has no box");

        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 12 });
        await page.mouse.up();
        await page.waitForTimeout(100);

        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__navigations)).toBe(0);
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__clicks)).toBe(0);
    });

    test("a plain click on a link opens it once", async ({ page }) => {
        await open(page, { speed: 0 });
        await page.getByTestId("item-2").click();
        await page.waitForTimeout(100);

        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__navigations)).toBe(1);
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__clicks)).toBe(1);
    });

    test("a pointer held still before release throws nothing", async ({ page }) => {
        await open(page, { speed: 0 });
        const start = await laneCentre(page);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x - 100, start.y, { steps: 10 });
        // Long enough that the last movement is stale.
        await page.waitForTimeout(300);
        await page.mouse.up();

        const lap = await period(page);
        const samples = await sampleTransform(page, 800);
        expect(largestFrameStep(samples, lap)).toBeLessThan(0.5);
    });
});

test.describe("marquee under reduced motion", () => {
    test("does not drift when idle but still drags", async ({ page }) => {
        // Emulated on the page rather than through test.use, which the project's
        // device descriptor was observed to win over.
        await page.emulateMedia({ reducedMotion: "reduce" });
        await open(page, { speed: CRUISE });
        // An emulation that silently did not apply would make this test a false pass.
        expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
        await page.waitForTimeout(300);

        const lap = await period(page);
        const samples = await sampleTransform(page, 1200);
        expect(Math.abs(samples.at(-1)!.value - samples[0].value)).toBeLessThan(0.01);

        const start = await laneCentre(page);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x - 150, start.y, { steps: 15 });
        const dragged = await page.evaluate(() =>
            new DOMMatrixReadOnly(getComputedStyle(document.querySelector("[data-testid=track]")!).transform).m41);
        await page.mouse.up();

        expect(Math.abs(dragged - samples[0].value)).toBeGreaterThan(140);
        expect(lap).toBeGreaterThan(0);
    });
});

test.describe("marquee on a phone", () => {
    test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

    test("a tap on a link opens it once", async ({ page }) => {
        await open(page, { speed: 0 });
        await page.getByTestId("item-1").tap();
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__navigations)).toBe(1);
    });

    test("a tap does not leave the row stuck at the hover speed", async ({ page }) => {
        await open(page, { speed: CRUISE, hoverScale: 0 });
        // Tapped by coordinate: a locator tap waits for the element to stop moving,
        // and a marquee never does.
        const centre = await laneCentre(page);
        await page.touchscreen.tap(centre.x, centre.y);
        await page.waitForTimeout(2600);

        const lap = await period(page);
        const speed = median(toSpeeds(await sampleTransform(page, 700), lap));
        // A hover gate that ignores pointerType leaves this at 0 for good.
        expect(Math.abs(speed - CRUISE) / CRUISE).toBeLessThan(0.05);
    });

    test("a vertical swipe on the row still scrolls the page", async ({ page }) => {
        await open(page, { speed: CRUISE });
        await page.evaluate(() => window.scrollTo(0, 0));
        const start = await laneCentre(page);

        // A real touch sequence, not a wheel: a wheel bypasses touch-action
        // entirely, so it would pass even with `touch-action: none` on the lane.
        await touchSwipe(page, start, { x: start.x, y: start.y - 220 });
        await page.waitForTimeout(300);

        expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    });
});
