import { test, expect, type Page } from "@playwright/test";

interface FixtureWindow extends Window {
    __ready: boolean;
    __presses: number;
    __submits: number;
    __release: () => void;
}

async function open(page: Page): Promise<void> {
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
}

async function read<K extends keyof FixtureWindow>(page: Page, key: K): Promise<FixtureWindow[K]> {
    return page.evaluate((name) => (window as unknown as Record<string, unknown>)[name], key) as Promise<FixtureWindow[K]>;
}

const save = "[data-testid=save]";
const send = "[data-testid=send]";

test.describe("Button (React)", () => {
    test("the short form is a button that works", async ({ page }) => {
        await open(page);
        // The whole call site is <Button onPress={...}>Save</Button> - no hook, no spread.
        await expect(page.locator(save)).toHaveText("Save");
        await page.click(save);
        expect(await read(page, "__presses")).toBe(1);
    });

    test("it defaults to type=button, so it never submits the form it lives in", async ({ page }) => {
        await open(page);
        await expect(page.locator(save)).toHaveAttribute("type", "button");
        await page.click(save);
        // A bare <button> defaults to submit: an action button that forgot it posts the
        // form instead of doing its job.
        expect(await read(page, "__submits")).toBe(0);
    });

    test("an href renders the registered router link, with nothing at the call site", async ({ page }) => {
        await open(page);
        const link = page.locator("[data-testid=link]");
        expect(await link.evaluate((node) => node.tagName)).toBe("A");
        await expect(link).toHaveAttribute("href", "/settings");
        // The fixture called setLinkComponent once. `<Button href>` carries no `as`, so
        // this attribute only exists if the registered link is what rendered.
        await expect(link).toHaveAttribute("data-router-link", "");
    });

    test("without a registered link an href is still a plain anchor", async ({ page }) => {
        await open(page);
        await page.evaluate(() => (window as unknown as { __unsetLink: () => void; }).__unsetLink());
        const link = page.locator("[data-testid=link]");
        expect(await link.evaluate((node) => node.tagName)).toBe("A");
        // Correct everywhere; it just means a full page load under a router.
        await expect(link).not.toHaveAttribute("data-router-link", "");
    });

    test("async work swaps the label, marks it busy, and refuses a second press", async ({ page }) => {
        await open(page);
        await page.click(send);

        await expect(page.locator(send)).toHaveText("Sending...");
        await expect(page.locator(send)).toHaveAttribute("aria-busy", "true");
        await expect(page.locator(send)).toBeDisabled();

        await page.evaluate(() => (window as unknown as FixtureWindow).__release());
        // The cooldown starts when the work FINISHES, so it is still unavailable here.
        await expect(page.locator(send)).toHaveAttribute("aria-busy", "false");
        await expect(page.locator(send)).toContainText(/Wait \ds/);
        await expect(page.locator(send)).toBeDisabled();
    });

    test("the label follows the state through a render prop", async ({ page }) => {
        await open(page);
        await expect(page.locator(send)).toHaveText("Send");
        await page.click(send);
        await page.evaluate(() => (window as unknown as FixtureWindow).__release());
        // Counting down: the seconds shown come off the primitive's own clock.
        await expect(page.locator(send)).toHaveText("Wait 3s");
        await page.waitForTimeout(1200);
        await expect(page.locator(send)).toHaveText("Wait 2s");
    });

    test("the cooldown ends and the button comes back", async ({ page }) => {
        await open(page);
        await page.click(send);
        await page.evaluate(() => (window as unknown as FixtureWindow).__release());
        await expect(page.locator(send)).toBeEnabled({ timeout: 5000 });
        await expect(page.locator(send)).toHaveText("Send");
    });
});
