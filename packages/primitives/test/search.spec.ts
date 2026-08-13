import Fuse from "fuse.js";
import { test, expect } from "@playwright/test";
import { createSearch, type SearchMatch } from "../src/core/search";

interface Doc { title: string; body: string; }

const docs: Doc[] = [
    { title: "Guardrails", body: "Deterministic convention rules" },
    { title: "Recall", body: "Local session memory over transcripts" },
    { title: "Café config", body: "Accents must not break a search" },
    { title: "Dashboard", body: "Loopback control panel" },
    { title: "Quality gate", body: "Review, tests, lint, push" }
];

const titles = (results: SearchMatch<Doc>[]) => results.map((result) => result.item.title);

test.describe("search without any engine", () => {
    test("matches on a substring and ranks the better hit first", () => {
        const search = createSearch<Doc>({ items: docs, keys: ["title", "body"], debounce: 0 });
        expect(titles(search.searchNow("recall"))).toEqual(["Recall"]);
    });

    test("a title hit outranks a body hit", () => {
        const items: Doc[] = [
            { title: "Nothing here", body: "the word gate appears only in the body" },
            { title: "Gate", body: "unrelated" }
        ];
        const search = createSearch<Doc>({ items, keys: ["title", "body"], debounce: 0 });
        expect(titles(search.searchNow("gate"))[0]).toBe("Gate");
    });

    test("an accent does not break a match", () => {
        const search = createSearch<Doc>({ items: docs, keys: ["title"], debounce: 0 });
        // A visitor typing "cafe" must find "Café", or the search reads as broken.
        expect(titles(search.searchNow("cafe"))).toEqual(["Café config"]);
        expect(titles(search.searchNow("café"))).toEqual(["Café config"]);
    });

    test("an empty query returns nothing by default and everything on request", () => {
        const strict = createSearch<Doc>({ items: docs, keys: ["title"], debounce: 0 });
        expect(strict.searchNow("")).toEqual([]);

        const permissive = createSearch<Doc>({ items: docs, keys: ["title"], debounce: 0, empty: "all" });
        expect(permissive.searchNow("")).toHaveLength(docs.length);
    });

    test("the result list can be capped", () => {
        const search = createSearch<Doc>({ items: docs, keys: ["title", "body"], debounce: 0, limit: 2, empty: "all" });
        expect(search.searchNow("")).toHaveLength(2);
    });

    test("minLength holds the search back", () => {
        const search = createSearch<Doc>({ items: docs, keys: ["title"], debounce: 0, minLength: 3 });
        expect(search.searchNow("re")).toEqual([]);
        expect(titles(search.searchNow("rec"))).toEqual(["Recall"]);
    });
});

test.describe("search with Fuse", () => {
    test("a typo still finds the document", () => {
        const strict = createSearch<Doc>({ items: docs, keys: ["title"], debounce: 0 });
        // The substring fallback cannot forgive a typo - that is what Fuse is for.
        expect(strict.searchNow("guardrials")).toEqual([]);

        const fuzzy = createSearch<Doc>({ items: docs, keys: ["title"], debounce: 0, fuse: Fuse as never });
        expect(titles(fuzzy.searchNow("guardrials"))).toContain("Guardrails");
    });

    test("fuseOptions reach Fuse untouched", () => {
        const loose = createSearch<Doc>({ items: docs, keys: ["title"], debounce: 0, fuse: Fuse as never, fuseOptions: { threshold: 0.9 } });
        const tight = createSearch<Doc>({ items: docs, keys: ["title"], debounce: 0, fuse: Fuse as never, fuseOptions: { threshold: 0.0 } });
        expect(loose.searchNow("dashbrd").length).toBeGreaterThan(tight.searchNow("dashbrd").length);
    });
});

test.describe("search wiring", () => {
    test("a custom matcher replaces the engine entirely", () => {
        const search = createSearch<Doc>({
            items: docs,
            debounce: 0,
            fuse: Fuse as never,
            matcher: (query, items) => items
                .filter((item) => item.title.startsWith(query))
                .map((item) => ({ item, score: 0 }))
        });
        // matcher wins over fuse, and only a prefix matches.
        expect(titles(search.searchNow("Da"))).toEqual(["Dashboard"]);
        expect(search.searchNow("ashboard")).toEqual([]);
    });

    test("a burst of keystrokes runs one search", async () => {
        let runs = 0;
        const search = createSearch<Doc>({
            items: docs,
            debounce: 30,
            matcher: (query, items) => { runs++; return items.filter((item) => item.title.includes(query)).map((item) => ({ item, score: 0 })); }
        });

        for (const query of ["R", "Re", "Rec", "Reca", "Recal"]) search.search(query);
        expect(runs).toBe(0);

        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(runs).toBe(1);
        expect(search.query).toBe("Recal");
    });

    test("new items re-run the visible query", () => {
        const search = createSearch<Doc>({ items: docs, keys: ["title"], debounce: 0 });
        expect(titles(search.searchNow("gate"))).toEqual(["Quality gate"]);

        search.setItems([{ title: "Gatekeeper", body: "replaced" }]);
        // Stale results against items that are gone would be worse than none.
        expect(titles(search.results)).toEqual(["Gatekeeper"]);
    });

    test("subscribers are told about every settled search", () => {
        const seen: string[] = [];
        const search = createSearch<Doc>({ items: docs, keys: ["title"], debounce: 0 });
        const unsubscribe = search.subscribe((_, query) => seen.push(query));

        search.searchNow("recall");
        search.searchNow("gate");
        unsubscribe();
        search.searchNow("dashboard");

        expect(seen).toEqual(["recall", "gate"]);
    });
});

test.describe("search attached to a field", () => {
    test("typing searches and Escape clears", async ({ page }) => {
        // Navigate first so the document has the fixture server's origin; a bare
        // setContent leaves it on about:blank, where a module specifier cannot resolve.
        await page.goto("/test/fixture/input.html");
        await page.setContent('<input id="q" type="search">');

        const state = await page.evaluate(async () => {
            const module = await import("/dist/index.js");
            const field = document.getElementById("q") as HTMLInputElement;
            const search = module.createSearch({
                items: [{ title: "Guardrails" }, { title: "Recall" }],
                keys: ["title"],
                debounce: 0
            });
            search.attach(field);

            field.value = "rec";
            field.dispatchEvent(new Event("input"));
            const afterTyping = search.results.length;

            field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            return { afterTyping, cleared: field.value, results: search.results.length, marked: field.hasAttribute("data-enigma-search") };
        });

        expect(state).toEqual({ afterTyping: 1, cleared: "", results: 0, marked: true });
    });
});
