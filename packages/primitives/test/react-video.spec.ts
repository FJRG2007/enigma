import { test, expect, type Page } from "@playwright/test";

/**
 * The video player, in a real browser.
 *
 * The element is stubbed rather than fed a file: `play()` and `pause()` are replaced with the
 * events a real one fires, and the duration is defined on the element. That keeps the suite
 * measuring the PLAYER - its controls, their state, the shortcuts - instead of waiting on a
 * decoder, and it is the only way to drive a paused/playing cycle with no media at all.
 */

interface FixtureWindow extends Window {
    __ready: boolean;
}

const player = "[data-testid=player] [data-enigma-video]";
/** The one sized too small to hold its own settings panel. */
const short = "[data-testid=short-player] [data-enigma-video]";
const video = "[data-testid=player-video]";
const controls = "[data-enigma-video-controls]";

/**
 * Replaces the media element's playback with something deterministic, before the page's own
 * script runs - a stub installed after React mounted would be a different element.
 */
async function stub(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const proto = HTMLMediaElement.prototype;
        Object.defineProperty(proto, "duration", { configurable: true, get: () => 120 });
        Object.defineProperty(proto, "paused", { configurable: true, get(this: HTMLMediaElement) { return !(this as unknown as { __playing: boolean; }).__playing; } });
        proto.play = function play(this: HTMLMediaElement) {
            (this as unknown as { __playing: boolean; }).__playing = true;
            this.dispatchEvent(new Event("play"));
            this.dispatchEvent(new Event("playing"));
            return Promise.resolve();
        };
        proto.pause = function pause(this: HTMLMediaElement) {
            (this as unknown as { __playing: boolean; }).__playing = false;
            this.dispatchEvent(new Event("pause"));
        };
    });
}

async function open(page: Page): Promise<void> {
    await stub(page);
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
    await page.locator(player).scrollIntoViewIfNeeded();
}

test.describe("Video", () => {
    test("the controls are the ones a video is expected to have", async ({ page }) => {
        await open(page);
        await expect(page.locator(`${player} ${controls}`)).toBeVisible();

        for (const label of ["Play", "Mute", "Settings", "Fullscreen"]) {
            // Scoped to the bar: the overlay carries a Play of its own while paused, and both
            // being there is the point rather than a duplicate.
            await expect(page.locator(`${player} ${controls} [aria-label="${label}"]`)).toHaveCount(1);
        }
        await expect(page.locator(`${player} [data-enigma-video-big][aria-label=Play]`)).toHaveCount(1);
        // The scrubber is a slider a screen reader can read and a keyboard can drive, not a
        // div with a click handler.
        const seek = page.locator(`${player} [aria-label=Seek]`);
        await expect(seek).toHaveAttribute("role", "slider");
        await expect(seek).toHaveAttribute("aria-valuemin", "0");
        // Captions only because the fixture passes a track: no tracks, no button.
        await expect(page.locator(`${player} [aria-label=Captions]`)).toHaveCount(1);
    });

    test("the big button plays, and the bar's own button then pauses", async ({ page }) => {
        await open(page);
        await expect(page.locator(`${player} [data-enigma-video-big]`)).toBeVisible();

        await page.click(`${player} [data-enigma-video-big]`);
        await expect(page.locator(player)).toHaveAttribute("data-playing", "");
        // The overlay button is gone while playing: it covers the picture, and the bar has one.
        await expect(page.locator(`${player} [data-enigma-video-big]`)).toHaveCount(0);

        await page.click(`${player} [aria-label=Pause]`);
        await expect(page.locator(player)).not.toHaveAttribute("data-playing", "");
        await expect(page.locator(`${player} [data-enigma-video-big]`)).toBeVisible();
    });

    test("the clock and the scrubber follow the time", async ({ page }) => {
        await open(page);
        await expect(page.locator(`${player} [data-enigma-video-time]`).last()).toHaveText("2:00");

        // A press halfway along the rail is a seek to halfway, which the clock reports.
        const box = await page.locator(`${player} [aria-label=Seek]`).boundingBox();
        if (!box) throw new Error("the rail has no box");
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(page.locator(`${player} [data-enigma-video-time]`).first()).toHaveText("1:00");
        await expect(page.locator(`${player} [aria-label=Seek]`)).toHaveAttribute("aria-valuenow", "50");
    });

    test("the shortcuts are the platform's, and only inside the player", async ({ page }) => {
        await open(page);
        await page.locator(player).focus();

        await page.keyboard.press("k");
        await expect(page.locator(player)).toHaveAttribute("data-playing", "");
        await page.keyboard.press("k");
        await expect(page.locator(player)).not.toHaveAttribute("data-playing", "");

        // A digit seeks to that tenth of the video: 2 of 120 seconds is 0:24.
        await page.keyboard.press("2");
        await expect(page.locator(`${player} [data-enigma-video-time]`).first()).toHaveText("0:24");

        await page.keyboard.press("ArrowRight");
        await expect(page.locator(`${player} [data-enigma-video-time]`).first()).toHaveText("0:29");

        await page.keyboard.press("m");
        await expect(page.locator(`${player} [aria-label=Unmute]`)).toHaveCount(1);
    });

    test("a shortcut pressed in a field belongs to the field", async ({ page }) => {
        await open(page);
        // The fixture's own password input, inside the same form: a space there is a space,
        // not a pause.
        const field = page.locator("[data-testid=password]");
        await field.focus();
        await field.press("k");
        await expect(page.locator(player)).not.toHaveAttribute("data-playing", "");
    });

    test("the settings menu offers the speeds and applies one", async ({ page }) => {
        await open(page);
        await page.click(`${player} [aria-label=Settings]`);

        const panel = page.locator("[data-enigma-video-panel]");
        await expect(panel).toBeVisible();
        await expect(panel.locator("[data-enigma-video-option=speed]")).toHaveCount(7);
        await expect(panel.locator("[data-enigma-video-option=speed][aria-checked=true]")).toHaveText("Normal");

        await panel.locator("[data-enigma-video-option=speed]", { hasText: "1.5x" }).click();
        await expect(panel).toHaveCount(0);
        expect(await page.locator(video).evaluate((node: HTMLVideoElement) => node.playbackRate)).toBe(1.5);
    });

    test("the volume control mutes, unmutes and reports where it is", async ({ page }) => {
        await open(page);
        const rail = page.locator(`${player} [aria-label=Volume]`);
        await expect(rail).toHaveAttribute("aria-valuenow", "100");

        await page.click(`${player} [aria-label=Mute]`);
        await expect(rail).toHaveAttribute("aria-valuenow", "0");
        expect(await page.locator(video).evaluate((node: HTMLVideoElement) => node.muted)).toBe(true);

        // Unmuting a video whose volume is at zero has to give it something to be heard at.
        await page.locator(video).evaluate((node: HTMLVideoElement) => { node.volume = 0; });
        await page.click(`${player} [aria-label=Unmute]`);
        expect(await page.locator(video).evaluate((node: HTMLVideoElement) => node.volume)).toBeGreaterThan(0);
    });

    test("the bar hides while playing and comes back on a pointer move", async ({ page }) => {
        await open(page);
        await page.click(`${player} [data-enigma-video-big]`);
        // The fixture's player runs on the standard delay: waited for rather than hurried, so
        // the test measures the behaviour that ships.
        await expect(page.locator(player)).toHaveAttribute("data-hidden", "", { timeout: 6000 });

        const box = await page.locator(player).boundingBox();
        if (!box) throw new Error("the player has no box");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await expect(page.locator(player)).not.toHaveAttribute("data-hidden", "");
    });

    /**
     * The button reports the ELEMENT, which is the whole point of the control.
     *
     * The fixture's first track carries `default`, so the browser is already drawing it before
     * anything is pressed. A player keeping its own `captions` flag said "off" over a picture
     * with subtitles on it, and took two presses to turn them off - which is what this asserts
     * against.
     */
    test("the captions button reports what the element is showing", async ({ page }) => {
        await open(page);
        const button = page.locator(`${player} [aria-label=Captions]`);
        const mode = (at: number) => page.locator(video).evaluate((node: HTMLVideoElement, index) => node.textTracks[index]?.mode, at);

        await expect(button).toHaveAttribute("aria-pressed", "true");
        expect(await mode(0)).toBe("showing");

        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "false");
        expect(await mode(0)).toBe("disabled");

        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "true");
        expect(await mode(0)).toBe("showing");
    });

    test("the panel picks a language, and the button comes back to that one", async ({ page }) => {
        await open(page);
        const mode = (at: number) => page.locator(video).evaluate((node: HTMLVideoElement, index) => node.textTracks[index]?.mode, at);
        await page.click(`${player} [aria-label=Settings]`);

        const panel = page.locator("[data-enigma-video-panel]");
        // Off, plus the two the fixture ships.
        await expect(panel.locator("[data-enigma-video-option=captions]")).toHaveCount(3);

        await panel.locator("[data-enigma-video-option=captions]", { hasText: "Espanol" }).click();
        expect(await mode(1)).toBe("showing");
        // One at a time: two showing tracks stack two languages over the picture.
        expect(await mode(0)).toBe("disabled");

        // And the button comes back to the language that was CHOSEN, not to the first in the
        // list - which is what makes C usable once somebody has picked one.
        const button = page.locator(`${player} [aria-label=Captions]`);
        await button.click();
        expect(await mode(1)).toBe("disabled");
        await button.click();
        expect(await mode(1)).toBe("showing");
    });

    /**
     * The panel opens upward inside a player that clips its own overflow, so a list taller than
     * the picture used to be a list with its top cut off - which is every player under about
     * 300px once the languages are in there beside the speeds.
     */
    test("the settings panel stays inside the player and scrolls", async ({ page }) => {
        await open(page);
        await page.locator(short).scrollIntoViewIfNeeded();
        await page.click(`${short} [aria-label=Settings]`);

        const panel = page.locator("[data-enigma-video-panel]");
        const box = await panel.boundingBox();
        const frame = await page.locator(short).boundingBox();
        if (!box || !frame) throw new Error("the panel or the player has no box");

        expect(box.y).toBeGreaterThanOrEqual(frame.y);
        expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
        // Not merely cropped: what does not fit is reachable.
        const overflow = await panel.evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight }));
        expect(overflow.scroll).toBeGreaterThan(overflow.client);
    });

    /**
     * An icon drawn outside its 24x24 box cannot be centred by the button holding it. The gear
     * used to carry absolute V21/H4 commands and hung off the bottom of its own control.
     */
    test("every control's icon is inside the button it sits in", async ({ page }) => {
        await open(page);
        const buttons = page.locator(`${player} ${controls} [data-enigma-video-button]`);
        const count = await buttons.count();
        expect(count).toBeGreaterThan(3);

        for (let at = 0; at < count; at += 1) {
            const button = buttons.nth(at);
            const glyph = button.locator("svg");
            if (await glyph.count() === 0) continue;
            const [outer, inner] = [await button.boundingBox(), await glyph.boundingBox()];
            if (!outer || !inner) throw new Error("a control has no box");
            const label = await button.getAttribute("aria-label");
            expect(inner.x, `${label} draws left of its button`).toBeGreaterThanOrEqual(outer.x - 0.5);
            expect(inner.y, `${label} draws above its button`).toBeGreaterThanOrEqual(outer.y - 0.5);
            expect(inner.x + inner.width, `${label} draws past its button`).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
            expect(inner.y + inner.height, `${label} draws below its button`).toBeLessThanOrEqual(outer.y + outer.height + 0.5);
        }
    });

    test("fullscreen fills the screen and keeps the bar on it", async ({ page }) => {
        await open(page);
        await page.click(`${player} [aria-label=Fullscreen]`);
        await expect(page.locator(player)).toHaveAttribute("data-fullscreen", "");

        const bar = await page.locator(`${player} ${controls}`).boundingBox();
        const view = page.viewportSize();
        if (!bar || !view) throw new Error("no bar, or no viewport");
        expect(bar.y).toBeGreaterThanOrEqual(0);
        expect(bar.y + bar.height).toBeLessThanOrEqual(view.height + 1);
        await expect(page.locator(`${player} [aria-label="Exit fullscreen"]`)).toBeVisible();
    });

    /**
     * The bar does not go away under the pointer that is on its way to a button.
     *
     * This is the fullscreen complaint: the controls hid on their timer while the cursor was
     * resting on them, which reads as the buttons disappearing rather than as a bar getting
     * out of the way - and fullscreen is where the trip to the button is longest.
     */
    test("the bar stays while the pointer is on it", async ({ page }) => {
        await open(page);
        await page.click(`${player} [data-enigma-video-big]`);

        const bar = await page.locator(`${player} ${controls}`).boundingBox();
        if (!bar) throw new Error("the bar has no box");
        await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height - 8);

        // Well past the delay the same suite waits out when the pointer is elsewhere.
        await page.waitForTimeout(4000);
        await expect(page.locator(player)).not.toHaveAttribute("data-hidden", "");
    });

    test("a key brings the bar back, not only a pointer", async ({ page }) => {
        await open(page);
        await page.locator(player).focus();
        await page.keyboard.press("k");
        await expect(page.locator(player)).toHaveAttribute("data-hidden", "", { timeout: 6000 });

        // Seeking from the keyboard with the bar gone showed nothing at all: no clock, no
        // scrubber, no feedback that the press did anything.
        await page.keyboard.press("ArrowRight");
        await expect(page.locator(player)).not.toHaveAttribute("data-hidden", "");
    });

    test("a right-click opens the player's own menu, and its rows act on the video", async ({ page }) => {
        await open(page);
        const box = await page.locator(player).boundingBox();
        if (!box) throw new Error("the player has no box");

        // The menu's chunk is fetched when a pointer arrives, which is what happens before any
        // second button is pressed. The player says so on itself, and until it does a
        // right-click is deliberately left to the browser.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
        await expect(page.locator(player)).toHaveAttribute("data-menu", "");
        const panel = page.locator("[data-enigma-menu-panel]");
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3, { button: "right" });
        await expect(panel).toBeVisible();

        for (const label of ["Loop", "Speed", "Subtitles", "Copy video URL"]) {
            await expect(panel.locator("[data-enigma-menu-item]", { hasText: label }).first()).toBeVisible();
        }

        // Nine rows is a menu you read at a glance: a filter field there is chrome, a focus
        // stop and a taller panel in exchange for nothing.
        await expect(panel.locator("[data-enigma-menu-search]")).toHaveCount(0);

        /**
         * Every label starts at the same place.
         *
         * Loop and Cast carry a tick as well as an icon and their neighbours carry only the
         * icon, so drawn per row the checkable ones sat a whole column further right. A level
         * with one checkable row reserves the column for all of them, the way a desktop menu
         * does.
         */
        // One snapshot, not one measurement per row: the panel settles into its final place
        // over a frame or two, so reading the rows one at a time measures the settling and not
        // the alignment - which is a test that fails for a reason it is not about.
        const lefts = await page.evaluate(() => {
            const open = document.querySelector("[data-enigma-menu-panel]");
            return [...(open?.querySelectorAll("[data-enigma-menu-item-label]") ?? [])].map((label) => label.getBoundingClientRect().x);
        });
        expect(lefts.length).toBeGreaterThan(4);
        expect(Math.max(...lefts) - Math.min(...lefts), "the rows do not line up").toBeLessThan(0.5);

        await panel.locator("[data-enigma-menu-item]", { hasText: "Loop" }).first().click();
        expect(await page.locator(video).evaluate((node: HTMLVideoElement) => node.loop)).toBe(true);
        await expect(panel).toHaveCount(0);
    });

    test("the cast control appears where there is a screen for it, and opens the picker", async ({ page }) => {
        // The Remote Playback API, stubbed: a real one needs a device on the network. What is
        // under test is that the control follows availability and calls prompt().
        await page.addInitScript(() => {
            Object.defineProperty(HTMLMediaElement.prototype, "remote", {
                configurable: true,
                get(this: HTMLMediaElement) {
                    const self = this as unknown as { __remote?: unknown; };
                    self.__remote ??= {
                        state: "disconnected",
                        watchAvailability: (callback: (available: boolean) => void) => {
                            setTimeout(() => callback(true), 0);
                            return Promise.resolve(1);
                        },
                        cancelWatchAvailability: () => Promise.resolve(),
                        prompt: () => {
                            (window as unknown as { __castPrompted: boolean; }).__castPrompted = true;
                            return Promise.resolve();
                        },
                        addEventListener: () => { /* no connection to report */ },
                        removeEventListener: () => { /* the same */ }
                    };
                    return self.__remote;
                }
            });
        });
        await open(page);

        const button = page.locator(`${player} [aria-label="Play on a TV"]`);
        await expect(button).toBeVisible();
        await button.click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { __castPrompted?: boolean; }).__castPrompted)).toBe(true);
    });
});
