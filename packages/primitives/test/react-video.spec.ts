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
        await expect(page.locator(controls)).toBeVisible();

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
        await expect(panel.locator("[data-enigma-video-option]")).toHaveCount(7);
        await expect(panel.locator("[aria-checked=true]")).toHaveText("Normal");

        await panel.locator("[data-enigma-video-option]", { hasText: "1.5x" }).click();
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

    test("captions are off until asked for, and the button says which", async ({ page }) => {
        await open(page);
        const button = page.locator(`${player} [aria-label=Captions]`);
        await expect(button).toHaveAttribute("aria-pressed", "false");

        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "true");
        expect(await page.locator(video).evaluate((node: HTMLVideoElement) => node.textTracks[0]?.mode)).toBe("showing");

        await button.click();
        expect(await page.locator(video).evaluate((node: HTMLVideoElement) => node.textTracks[0]?.mode)).toBe("disabled");
    });
});
