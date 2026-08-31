import { test, expect, type Page } from "@playwright/test";

interface FixtureWindow extends Window {
    __ready: boolean;
    __submits: number;
    __value: string;
    __strength: { score: number; bits: number; warnings: string[]; empty: boolean; } | null;
    __breach: { status: string; count: number; } | null;
    __breachCalls: string[];
}

async function open(page: Page): Promise<void> {
    await page.goto("/test/fixture/react.html");
    await page.waitForFunction(() => (window as unknown as FixtureWindow).__ready === true);
}

const field = "[data-testid=password]";
// Scoped to the password field's own root: the fixture renders more than one field, and a
// bare attribute selector would match whichever came first.
const root = "[data-enigma-input-root]:has([data-testid=password])";
const reveal = '[data-enigma-input-action="reveal"]';
const generate = '[data-enigma-input-action="generate"]';

/** Read one value the fixture published on `window`. */
async function read<K extends keyof FixtureWindow>(page: Page, key: K): Promise<FixtureWindow[K]> {
    return page.evaluate((name) => (window as unknown as Record<string, unknown>)[name], key) as Promise<FixtureWindow[K]>;
}

test.describe("Input (React)", () => {
    test("a password field renders its own buttons, in React", async ({ page }) => {
        await open(page);
        await expect(page.locator(generate)).toHaveCount(1);
        await expect(page.locator(reveal)).toHaveCount(1);
        // Rendered by React inside the field row, not appended to the document by a side
        // effect - which is what made the imperative version awkward to compose with.
        await expect(page.locator(`${root} [data-enigma-input-field] ${reveal}`)).toHaveCount(1);
    });

    test("a generated password reaches a controlled field", async ({ page }) => {
        await open(page);
        await page.click(generate);

        // The assertion that matters: React's own state has the value. Assigning
        // input.value directly would leave the DOM and the state disagreeing, the next
        // render would wipe it, and nothing would report the loss.
        const value = await read(page, "__value");
        expect(value).toHaveLength(24);
        await expect(page.locator(field)).toHaveValue(value);

        expect(value).toMatch(/[a-z]/);
        expect(value).toMatch(/[A-Z]/);
        expect(value).toMatch(/\d/);
        expect(value).toMatch(/[^\w]/);
    });

    test("two generated passwords are not the same one", async ({ page }) => {
        await open(page);
        await page.click(generate);
        const first = await read(page, "__value");
        await page.click(generate);
        expect(await read(page, "__value")).not.toBe(first);
    });

    test("generating reveals what it generated", async ({ page }) => {
        await open(page);
        await expect(page.locator(field)).toHaveAttribute("type", "password");
        await page.click(generate);
        // A password nobody can read is one nobody can write down.
        await expect(page.locator(field)).toHaveAttribute("type", "text");
        await expect(page.locator(reveal)).toHaveAttribute("aria-pressed", "true");
    });

    test("the caret stays where it was across the type switch", async ({ page }) => {
        await open(page);
        await page.fill(field, "correct horse");
        await page.focus(field);
        await page.evaluate(() => document.querySelector<HTMLInputElement>("[data-testid=password]")!.setSelectionRange(3, 3));

        await page.click(reveal);
        // Chromium moves the caret one macrotask after a type switch made inside a click
        // handler, so this has to be read after the task boundary or it passes on a value
        // that is about to be thrown away.
        await page.waitForTimeout(50);
        const caret = await page.evaluate(() => document.querySelector<HTMLInputElement>("[data-testid=password]")!.selectionStart);
        expect(caret).toBe(3);
    });

    test("neither button submits the form it lives in", async ({ page }) => {
        await open(page);
        await page.click(generate);
        await page.click(reveal);
        // A button with no explicit type defaults to submit, which posts a half-filled
        // registration form the moment someone asks for a password.
        expect(await read(page, "__submits")).toBe(0);

        await page.click("[data-testid=submit]");
        expect(await read(page, "__submits")).toBe(1);
    });

    test("the meter scores what was typed, and fills one more bar than the score", async ({ page }) => {
        await open(page);
        await expect(page.locator("[data-enigma-password-strength][data-empty]")).toHaveCount(1);

        await page.fill(field, "aaaaaa");
        await expect(page.locator(root)).toHaveAttribute("data-score", "0");
        // An empty track beside a filled field reads as "not measured", not as "bad".
        await expect(page.locator("[data-enigma-password-strength-segment][data-filled]")).toHaveCount(1);

        await page.click(generate);
        await expect(page.locator(root)).toHaveAttribute("data-score", "4");
        await expect(page.locator("[data-enigma-password-strength-segment][data-filled]")).toHaveCount(5);
    });

    test("a password built out of something already on the form is called out", async ({ page }) => {
        await open(page);
        await page.fill(field, "Ada@example.com1!");
        const report = await read(page, "__strength");
        expect(report?.score).toBeLessThanOrEqual(1);
        // No character-class rule catches this one: it has four classes and sixteen
        // characters, and anyone looking at the sign-up form can guess it.
        expect(report?.warnings.join(" ")).toContain("already typed");
    });

    test("a breached password is reported as state, not as an error message", async ({ page }) => {
        await open(page);
        await page.fill(field, "password");
        await expect(page.locator(`${root}[data-breached]`)).toHaveCount(1);

        const state = await read(page, "__breach");
        expect(state?.status).toBe("breached");
        expect(state?.count).toBeGreaterThan(0);
        // The component renders no message of its own: what a breach means is the form's
        // decision, and every form makes it differently.
        await expect(page.locator(root)).not.toContainText("breach");
    });

    test("a password that is not in the corpus comes back safe", async ({ page }) => {
        await open(page);
        await page.fill(field, "a-password-nobody-has-used");
        await expect.poll(async () => (await read(page, "__breach"))?.status).toBe("safe");
        await expect(page.locator(`${root}[data-breached]`)).toHaveCount(0);
    });

    test("typing does not fire a check per keystroke, and a stale answer cannot land", async ({ page }) => {
        await open(page);
        await page.click(field);
        await page.keyboard.type("hunter2", { delay: 5 });

        await expect.poll(async () => (await read(page, "__breach"))?.status).toBe("breached");
        const calls = await read(page, "__breachCalls");
        // Seven keystrokes, and the debounce means far fewer requests than that.
        expect(calls.length).toBeLessThan(4);
        // Whatever was asked, the answer showing is the answer for the value in the field.
        expect(calls[calls.length - 1]).toBe("hunter2");
    });
});
