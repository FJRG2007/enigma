import { test, expect } from "@playwright/test";

/** `<Input type="search">`: the same component, wired by its type. */
test.describe("Input (search)", () => {
    test("typing ranks the list and the clear button appears with the value", async ({ page }) => {
        await page.goto("/test/fixture/react.html");
        await page.waitForFunction(() => (window as unknown as { __ready: boolean; }).__ready === true);

        const field = page.locator('[data-testid="finder"]');
        await expect(page.locator('[data-testid="finder"] ~ * [data-enigma-input-action="clear"]')).toHaveCount(0);

        await field.fill("mar");
        await expect(page.locator('[data-testid="finder-results"] li')).toHaveText(["Marquee"]);
        await expect(page.locator('[data-testid="finder-results"]')).toHaveAttribute("data-query", "mar");
    });

    test("the clear button empties the field and the results with it", async ({ page }) => {
        await page.goto("/test/fixture/react.html");
        await page.waitForFunction(() => (window as unknown as { __ready: boolean; }).__ready === true);

        const field = page.locator('[data-testid="finder"]');
        await field.fill("input");
        await expect(page.locator('[data-testid="finder-results"] li')).toHaveCount(1);

        const root = page.locator("[data-enigma-input-root]").filter({ has: page.locator('[data-testid="finder"]') });
        await root.locator('[data-enigma-input-action="clear"]').click();
        await expect(field).toHaveValue("");
        await expect(page.locator('[data-testid="finder-results"] li')).toHaveCount(0);
    });
});
