import { test, expect } from "@playwright/test";
import { createButton } from "../src/core/button";

test.describe("button", () => {
    test("an href makes it a link, nothing else does", () => {
        expect(createButton().state.element).toBe("button");
        expect(createButton({ href: "/x" }).state.element).toBe("a");
    });

    test("disabled, loading and a cooldown all mean the same thing to a renderer", async () => {
        expect(createButton({ disabled: true }).state.available).toBe(false);
        expect(createButton({ loading: true }).state.available).toBe(false);

        const button = createButton({ cooldown: 400, onPress: () => { /* sync */ } });
        expect(button.state.available).toBe(true);
        await button.press();
        expect(button.state.available).toBe(false);
        expect(button.state.cooldown).toBeGreaterThan(0);

        await new Promise((resolve) => setTimeout(resolve, 460));
        expect(button.state.available).toBe(true);
        expect(button.state.cooldown).toBe(0);
        button.destroy();
    });

    test("a press while unavailable does nothing", async () => {
        let presses = 0;
        const button = createButton({ cooldown: 1000, onPress: () => { presses++; } });
        await button.press();
        await button.press();
        await button.press();
        // The cooldown is the point: three clicks, one action.
        expect(presses).toBe(1);
        button.destroy();
    });

    test("async work flips loading, and the cooldown starts when it finishes", async () => {
        const seen: boolean[] = [];
        const button = createButton({
            cooldown: 300,
            onPress: () => new Promise((resolve) => setTimeout(resolve, 120)),
            onChange: (state) => seen.push(state.loading)
        });

        const pending = button.press();
        expect(button.state.loading).toBe(true);
        await pending;

        expect(button.state.loading).toBe(false);
        // Starting it at request time would let a slow call eat its own cooldown.
        expect(button.state.cooldown).toBeGreaterThan(250);
        expect(seen).toContain(true);
        button.destroy();
    });

    test("reset clears a cooldown early", async () => {
        const button = createButton({ cooldown: 5000, onPress: () => { /* sync */ } });
        await button.press();
        expect(button.state.available).toBe(false);
        button.reset();
        expect(button.state.available).toBe(true);
        button.destroy();
    });
});

test.describe("button in a page", () => {
    test("a shortcut fires it, but never while typing or with a modifier", async ({ page }) => {
        await page.goto("/test/fixture/input.html");
        const result = await page.evaluate(async () => {
            const module = await import("/dist/index.js");
            let presses = 0;
            const button = module.createButton({ shortcut: "r", onPress: () => { presses++; } });

            const key = (init: KeyboardEventInit & { target?: HTMLElement; }) => {
                const event = new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true, ...init });
                (init.target ?? document.body).dispatchEvent(event);
            };

            key({});
            const afterPlain = presses;
            key({ ctrlKey: true });
            key({ metaKey: true });
            const afterModifiers = presses;
            key({ target: document.querySelector("[data-testid=password]") as HTMLElement });
            const afterTyping = presses;

            button.destroy();
            return { afterPlain, afterModifiers, afterTyping };
        });

        expect(result.afterPlain).toBe(1);
        // A modifier belongs to a real shortcut, and typing must reach the field.
        expect(result.afterModifiers).toBe(1);
        expect(result.afterTyping).toBe(1);
    });

    test("a cooldown with a key survives a reload", async ({ page }) => {
        await page.goto("/test/fixture/input.html");
        await page.evaluate(async () => {
            const module = await import("/dist/index.js");
            const button = module.createButton({ cooldown: { ms: 5000, key: "reload-test", storage: "session" }, onPress: () => { /* sync */ } });
            await button.press();
            button.destroy();
        });

        await page.reload();
        const restored = await page.evaluate(async () => {
            const module = await import("/dist/index.js");
            const button = module.createButton({ cooldown: { ms: 5000, key: "reload-test", storage: "session" } });
            const state = { available: button.state.available, cooldown: button.state.cooldown };
            button.destroy();
            return state;
        });

        // Without persistence a refresh is a free retry, which defeats the cooldown.
        expect(restored.available).toBe(false);
        expect(restored.cooldown).toBeGreaterThan(3000);
    });
});
