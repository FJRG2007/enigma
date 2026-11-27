import { describe, expect, test } from "bun:test";
import { dominantLanguage, languageMessage, replyLanguageMismatch, userLanguage } from "../src/reply-language";

describe("dominantLanguage", () => {
    test("reads the language through typos and technical words", () => {
        expect(dominantLanguage("otra cosa que la peudes ve en este mismo chat, que piense el modelo en ingles")).toBe("Spanish");
        expect(dominantLanguage("The rule already exists, and the leak was missed because it spans lines.")).toBe("English");
        expect(dominantLanguage("Der Fehler ist nicht neu, und er kommt auch mit der alten Version.")).toBe("German");
    });

    test("code, commands, links and quotes are not prose", () => {
        const reply = "Hecho, ya está.\n```ts\nthe value is not what it was and this is the fix for it\n```\n`the and of to` https://example.com/the/and/of\n> the user wrote this and that in English";
        expect(dominantLanguage(reply, 2)).toBe("Spanish");
    });

    test("too little evidence or a close split is unknown", () => {
        expect(dominantLanguage("ok")).toBeNull();
        expect(dominantLanguage("sigue")).toBeNull();
        expect(dominantLanguage("the plan es para el deploy and the build")).toBeNull();
    });
});

describe("userLanguage", () => {
    test("a majority of the prompts decides, so one English paste does not flip it", () => {
        expect(userLanguage([
            "Limits What one account may consume of one product, and the counters behind it",
            "no veo para poner un plan custom por ejemplo de trial",
            "y ahora mismo cómo se mide el consumo con esto?",
        ])).toBe("Spanish");
    });

    test("a split history has no language", () => {
        expect(userLanguage(["this is the English one and it is long", "esta es la otra y es en español"])).toBeNull();
    });
});

describe("replyLanguageMismatch", () => {
    const spanish = ["revisa por qué la instalación es tan lenta y dime qué pasa con el gate"];
    const englishReply = "The installer was slow because the download showed a progress bar for every chunk, and that is fixed now.";

    test("a Spanish user answered in English is a mismatch", () => {
        expect(replyLanguageMismatch(spanish, englishReply)).toEqual({ user: "Spanish", reply: "English" });
    });

    test("only a drift INTO English is reported", () => {
        expect(replyLanguageMismatch(spanish, "El instalador iba lento por la barra de progreso, y ya está arreglado del todo.")).toBeNull();
        expect(replyLanguageMismatch(["why is the installer so slow and what is the state of it"], "El instalador iba lento por la barra de progreso, y ya está arreglado.")).toBeNull();
    });

    test("a short English status is not enough evidence", () => {
        expect(replyLanguageMismatch(spanish, "Done: `4dd32b69`.")).toBeNull();
    });

    test("the message says what may stay English", () => {
        const text = languageMessage({ user: "Spanish", reply: "English" });
        expect(text).toContain("Rewrite the reply to the user in Spanish");
        expect(text).toContain("thinking");
        expect(text).toContain("commit messages");
    });
});
