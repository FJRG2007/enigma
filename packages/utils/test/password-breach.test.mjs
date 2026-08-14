import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCache } from "../dist/index.js";
import { checkPasswordBreach, PasswordBreachError } from "../dist/index.js";

const sha1 = (text) => createHash("sha1").update(text).digest("hex").toUpperCase();

/** A stub range endpoint that records what it was asked, and answers from a list. */
function corpus(entries, { status = 200, fail = null } = {}) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, headers: init?.headers ?? {}, signal: init?.signal });
        if (fail) throw fail;
        const prefix = String(url).split("/").pop();
        const body = entries
            .filter((entry) => entry.hash.startsWith(prefix))
            .map((entry) => `${entry.hash.slice(5)}:${entry.count}`)
            .join("\r\n");
        return { ok: status === 200, status, text: async () => body };
    };
    return { fetch, calls };
}

test("an empty password is answered without asking anyone", async () => {
    const { fetch, calls } = corpus([]);
    assert.deepEqual(await checkPasswordBreach("", { fetch }), { breached: false, count: 0 });
    assert.equal(calls.length, 0);
});

test("only five characters of the hash leave the machine", async () => {
    const { fetch, calls } = corpus([]);
    await checkPasswordBreach("correct horse battery staple", { fetch, cache: null });

    const hash = sha1("correct horse battery staple");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith(`/${hash.slice(0, 5)}`), `asked for ${calls[0].url}`);
    // The whole point of the k-anonymity model: neither the password nor its full hash is
    // ever sent, so the service cannot know which password was being looked up.
    assert.doesNotMatch(calls[0].url, /correct/);
    assert.doesNotMatch(calls[0].url, new RegExp(hash.slice(5)));
});

test("padding is requested by default, so the response size gives nothing away", async () => {
    const { fetch, calls } = corpus([]);
    await checkPasswordBreach("hunter2", { fetch, cache: null });
    assert.equal(calls[0].headers["Add-Padding"], "true");

    const plain = corpus([]);
    await checkPasswordBreach("hunter2", { fetch: plain.fetch, padding: false, cache: null });
    assert.equal(plain.calls[0].headers["Add-Padding"], undefined);
});

test("a known password comes back with its count", async () => {
    const { fetch } = corpus([{ hash: sha1("password"), count: 3730471 }]);
    assert.deepEqual(await checkPasswordBreach("password", { fetch, cache: null }), { breached: true, count: 3730471 });
});

test("a password the corpus does not have is not breached", async () => {
    const { fetch } = corpus([{ hash: sha1("password"), count: 10 }]);
    assert.deepEqual(await checkPasswordBreach("2u9Zq!vTk3nWpLx7", { fetch, cache: null }), { breached: false, count: 0 });
});

test("a padded decoy is not a match", async () => {
    // Padded responses carry entries with a count of 0. They are indistinguishable from a
    // real line except by that zero, so matching on the suffix alone reports every padded
    // response as a breach.
    const { fetch } = corpus([{ hash: sha1("decoyed"), count: 0 }]);
    assert.deepEqual(await checkPasswordBreach("decoyed", { fetch, cache: null }), { breached: false, count: 0 });
});

test("one prefix is fetched once, however many passwords share it", async () => {
    const cache = createCache({ ttl: 60_000 });
    const { fetch, calls } = corpus([{ hash: sha1("password"), count: 5 }]);
    const answers = await Promise.all([
        checkPasswordBreach("password", { fetch, cache }),
        checkPasswordBreach("password", { fetch, cache })
    ]);
    assert.equal(calls.length, 1, "typing must not cost one request per keystroke");
    assert.deepEqual(answers[0], answers[1]);
});

test("a service failure is thrown, never rounded down to 'safe'", async () => {
    const { fetch } = corpus([], { status: 503 });
    await assert.rejects(
        () => checkPasswordBreach("password", { fetch, cache: null }),
        (error) => {
            assert.ok(error instanceof PasswordBreachError);
            assert.equal(error.reason, "service");
            return true;
        }
    );
});

test("an unreachable service is a network failure, with the cause kept", async () => {
    const cause = new TypeError("Failed to fetch");
    const { fetch } = corpus([], { fail: cause });
    await assert.rejects(
        () => checkPasswordBreach("password", { fetch, cache: null }),
        (error) => {
            assert.equal(error.reason, "network");
            assert.equal(error.cause, cause);
            return true;
        }
    );
});

test("an abort stays an abort", async () => {
    const aborted = new DOMException("aborted", "AbortError");
    const { fetch } = corpus([], { fail: aborted });
    await assert.rejects(
        () => checkPasswordBreach("password", { fetch, cache: null }),
        // A component that cancels on the next keystroke must not surface that as a
        // network error to the visitor.
        (error) => error === aborted
    );
});

test("the signal reaches the request", async () => {
    const controller = new AbortController();
    const { fetch, calls } = corpus([]);
    await checkPasswordBreach("password", { fetch, cache: null, signal: controller.signal });
    assert.equal(calls[0].signal, controller.signal);
});
