import { test, expect, type Page } from "@playwright/test";

interface FixtureWindow extends Window {
    __ready: boolean;
    __submits: number;
    __instance: { revealed: boolean; reveal(next?: boolean): void; destroy(): void; };
}

async function open(page: Page, params: Record<string, string> = {}): Promise<void> {
    const query = new URLSearchParams(params);
    await page.goto(`/test/fixture/input.html?${query}`);
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
}

const password = "[data-testid=password]";
const toggle = '[data-enigma-input-action="reveal"]';

test.describe("input", () => {
    test("a password field gets a reveal toggle and a plain field does not", async ({ page }) => {
        await open(page);
        expect(await page.locator(toggle).count()).toBe(1);
        // The second instance is bound to a type=text field.
        expect(await page.locator("[data-testid=text] ~ [data-enigma-input-actions] button").count()).toBe(0);
    });

    test("revealing shows the value and hides it again", async ({ page }) => {
        await open(page);
        await expect(page.locator(password)).toHaveAttribute("type", "password");

        await page.click(toggle);
        await expect(page.locator(password)).toHaveAttribute("type", "text");
        await expect(page.locator(toggle)).toHaveAttribute("aria-pressed", "true");

        await page.click(toggle);
        await expect(page.locator(password)).toHaveAttribute("type", "password");
        await expect(page.locator(toggle)).toHaveAttribute("aria-pressed", "false");
    });

    test("the toggle never submits the form it lives in", async ({ page }) => {
        await open(page);
        await page.click(toggle);
        await page.click(toggle);
        // A button without type="button" defaults to submit, which posts a half-filled
        // sign-in form the moment someone looks at their password.
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__submits)).toBe(0);

        await page.click("[data-testid=submit]");
        expect(await page.evaluate(() => (window as unknown as FixtureWindow).__submits)).toBe(1);
    });

    test("the caret stays where it was across the type switch", async ({ page }) => {
        await open(page);
        await page.focus(password);
        await page.evaluate(() => {
            const field = document.querySelector<HTMLInputElement>("[data-testid=password]")!;
            field.setSelectionRange(3, 3);
        });

        await page.click(toggle);
        // Chromium clobbers the caret one macrotask after a type switch made inside a
        // click handler, so the settled value is the one worth asserting.
        await page.waitForTimeout(50);

        const selection = await page.evaluate(() => {
            const field = document.querySelector<HTMLInputElement>("[data-testid=password]")!;
            return { start: field.selectionStart, end: field.selectionEnd, focused: document.activeElement === field };
        });
        expect(selection).toEqual({ start: 3, end: 3, focused: true });
    });

    test("the accessible name says what the button will do", async ({ page }) => {
        await open(page);
        await expect(page.locator(toggle)).toHaveAttribute("aria-label", "Show password");
        await page.click(toggle);
        await expect(page.locator(toggle)).toHaveAttribute("aria-label", "Hide password");
    });

    test("the reveal can be turned off entirely", async ({ page }) => {
        await open(page, { reveal: "off" });
        expect(await page.locator(toggle).count()).toBe(0);
    });

    test("the icons and labels can be replaced", async ({ page }) => {
        await open(page, { icons: "custom" });
        await expect(page.locator(`${toggle} [data-custom]`)).toHaveText("show");
        await expect(page.locator(toggle)).toHaveAttribute("aria-label", "Reveal it");
        await page.click(toggle);
        await expect(page.locator(`${toggle} [data-custom]`)).toHaveText("hide");
        await expect(page.locator(toggle)).toHaveAttribute("aria-label", "Conceal it");
    });

    test("the actions can be moved before the field", async ({ page }) => {
        await open(page, { position: "start" });
        const before = await page.evaluate(() => {
            const field = document.querySelector("[data-testid=password]")!;
            const actions = document.querySelector("[data-enigma-input-actions]")!;
            // Node.DOCUMENT_POSITION_FOLLOWING = the field comes after the actions.
            return Boolean(actions.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        expect(before).toBe(true);
    });

    test("another action can be added and hides itself when it does not apply", async ({ page }) => {
        await open(page, { extra: "clear" });
        const clear = '[data-enigma-input-action="clear"]';
        await expect(page.locator(clear)).toBeVisible();

        await page.click(clear);
        await expect(page.locator(password)).toHaveValue("");
        await expect(page.locator(clear)).toBeHidden();
    });

    test("destroy puts a revealed field back to password", async ({ page }) => {
        await open(page);
        await page.click(toggle);
        await expect(page.locator(password)).toHaveAttribute("type", "text");

        await page.evaluate(() => (window as unknown as FixtureWindow).__instance.destroy());
        // Leaving it as text would show the password to whoever sees the screen next.
        await expect(page.locator(password)).toHaveAttribute("type", "password");
        expect(await page.locator(toggle).count()).toBe(0);
    });
});
