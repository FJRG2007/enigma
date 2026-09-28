import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { safeFetch, isPublicAddress, SafeFetchError } from "../dist/server/index.js";

/**
 * A local server stands in for "the internet". It lives on 127.0.0.1, which the default policy
 * refuses, so every test that must reach it widens the policy to exactly that address - and the
 * tests that prove a refusal use the default policy and assert the server was never contacted.
 */
async function server(handler) {
    const hits = [];
    const srv = createServer((req, res) => {
        hits.push({ url: req.url, method: req.method, headers: req.headers });
        handler(req, res);
    });
    await new Promise((done) => srv.listen(0, "127.0.0.1", done));
    const { port } = srv.address();
    return { port, hits, close: () => new Promise((done) => srv.close(done)) };
}

/** A resolver answering from a table, counting how often each name is resolved. */
function dns(table) {
    const calls = {};
    const resolve = async (host) => {
        calls[host] = (calls[host] ?? 0) + 1;
        const answer = typeof table[host] === "function" ? table[host](calls[host]) : table[host];
        if (!answer) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        return answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    };
    return { resolve, calls };
}

const onlyLoopback = (address) => address === "127.0.0.1";

async function refusal(promise, reason) {
    await assert.rejects(promise, (error) => {
        assert.ok(error instanceof SafeFetchError, `expected SafeFetchError, got ${error}`);
        assert.equal(error.reason, reason);
        return true;
    });
}

test("address policy: public addresses pass, every internal range is refused", () => {
    for (const ok of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:81c::200e"]) {
        assert.equal(isPublicAddress(ok), true, ok);
    }
    const internal = [
        "127.0.0.1", "127.8.9.10", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
        "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.10",
        "198.18.0.1", "::", "::1", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1", "ff02::1",
        "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe",
        "2002:7f00:1::", "2001:db8::1", "2001::1", "::127.0.0.1", "[::1]", "not-an-ip", "", "1.2.3"
    ];
    for (const bad of internal) assert.equal(isPublicAddress(bad), false, bad);
    // A mapped or 6to4 form of a PUBLIC address stays public.
    assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
    assert.equal(isPublicAddress("2002:0808:0808::1"), true);
});

test("a name resolving to loopback is refused and the server is never contacted", async () => {
    const srv = await server((req, res) => res.end("secret"));
    try {
        const { resolve } = dns({ "internal.test": ["127.0.0.1"] });
        await refusal(safeFetch(`http://internal.test:${srv.port}/`, { resolve }), "blocked-address");
        assert.equal(srv.hits.length, 0);
    } finally {
        await srv.close();
    }
});

test("DNS rebinding: the address that is checked is the address that is connected to", async () => {
    const srv = await server((req, res) => res.end("internal data"));
    try {
        // The first answer is allowed (loopback stands in for "public" here), every later answer
        // is the metadata service: the classic rebinding attack. A guard that resolves to check
        // and then lets the client resolve again would connect to the second answer.
        const { resolve, calls } = dns({ "rebind.test": (n) => (n === 1 ? ["127.0.0.1"] : ["169.254.169.254"]) });
        const response = await safeFetch(`http://rebind.test:${srv.port}/`, { resolve, allowAddress: onlyLoopback });
        // One resolution, and the socket went to the address that resolution vetted.
        assert.equal(await response.text(), "internal data");
        assert.equal(calls["rebind.test"], 1);
        assert.equal(srv.hits.length, 1);
    } finally {
        await srv.close();
    }
});

test("an answer mixing a public and a private record is refused whole", async () => {
    const { resolve } = dns({ "split.test": ["93.184.216.34", "10.0.0.5"] });
    await refusal(safeFetch("http://split.test/", { resolve }), "blocked-address");
});

test("IP literals are vetted before any request, in every spelling the URL parser accepts", async () => {
    for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://169.254.169.254/latest/meta-data/"]) {
        await refusal(safeFetch(url), "blocked-address");
    }
});

test("scheme, credentials and port rules", async () => {
    await refusal(safeFetch("file:///etc/passwd"), "blocked-scheme");
    await refusal(safeFetch("gopher://example.com/"), "blocked-scheme");
    await refusal(safeFetch("http://user:pass@example.com/"), "credentials-in-url");
    await refusal(safeFetch("https://example.com:22/", { ports: [443] }), "blocked-port");
    await refusal(safeFetch("not a url"), "invalid-url");
});

test("a public-looking fetch works end to end and returns a standard Response", async () => {
    const srv = await server((req, res) => {
        res.setHeader("content-type", "text/plain");
        res.setHeader("set-cookie", ["a=1", "b=2"]);
        res.end(`hello ${req.method}`);
    });
    try {
        const { resolve } = dns({ "ok.test": ["127.0.0.1"] });
        const response = await safeFetch(`http://ok.test:${srv.port}/path?q=1`, { resolve, allowAddress: onlyLoopback });
        assert.ok(response instanceof Response);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "hello GET");
        assert.equal(response.headers.get("content-type"), "text/plain");
        assert.equal(response.url, `http://ok.test:${srv.port}/path?q=1`);
        assert.equal(response.redirected, false);
        // The Host header is the name, not the address: virtual hosting and TLS SNI keep working.
        assert.equal(srv.hits[0].headers.host, `ok.test:${srv.port}`);
    } finally {
        await srv.close();
    }
});

test("a redirect to an internal address is refused at the hop, not followed", async () => {
    const srv = await server((req, res) => {
        res.statusCode = 302;
        res.setHeader("location", "http://metadata.test/latest/meta-data/");
        res.end();
    });
    try {
        const { resolve, calls } = dns({ "ok.test": ["127.0.0.1"], "metadata.test": ["169.254.169.254"] });
        await refusal(safeFetch(`http://ok.test:${srv.port}/`, { resolve, allowAddress: onlyLoopback }), "blocked-address");
        assert.equal(calls["metadata.test"], 1);
    } finally {
        await srv.close();
    }
});

test("redirects: followed within the limit, credentials dropped across origins, 303 becomes GET", async () => {
    const srv = await server((req, res) => {
        if (req.url === "/start") { res.statusCode = 303; res.setHeader("location", `http://other.test:${req.socket.localPort}/landed`); res.end(); return; }
        if (req.url === "/loop") { res.statusCode = 302; res.setHeader("location", "/loop"); res.end(); return; }
        res.end("landed");
    });
    try {
        const { resolve } = dns({ "ok.test": ["127.0.0.1"], "other.test": ["127.0.0.1"] });
        const options = { resolve, allowAddress: onlyLoopback };
        const response = await safeFetch(`http://ok.test:${srv.port}/start`, { ...options, method: "POST", body: "x", headers: { authorization: "Bearer s3cret", cookie: "sid=1" } });
        assert.equal(await response.text(), "landed");
        assert.equal(response.redirected, true);
        const landed = srv.hits[1];
        assert.equal(landed.method, "GET");
        assert.equal(landed.headers.authorization, undefined);
        assert.equal(landed.headers.cookie, undefined);

        await refusal(safeFetch(`http://ok.test:${srv.port}/loop`, { ...options, maxRedirects: 3 }), "too-many-redirects");
        await refusal(safeFetch(`http://ok.test:${srv.port}/start`, { ...options, redirect: "error" }), "redirect-refused");
        const manual = await safeFetch(`http://ok.test:${srv.port}/start`, { ...options, redirect: "manual" });
        assert.equal(manual.status, 303);
    } finally {
        await srv.close();
    }
});

test("the body is capped, and a slow server hits the timeout", async () => {
    const srv = await server((req, res) => {
        if (req.url === "/big") { res.end("x".repeat(5000)); return; }
        if (req.url === "/chunked") { res.write("x".repeat(3000)); res.write("x".repeat(3000)); res.end(); return; }
        // /slow never answers
    });
    try {
        const { resolve } = dns({ "ok.test": ["127.0.0.1"] });
        const options = { resolve, allowAddress: onlyLoopback };
        await refusal(safeFetch(`http://ok.test:${srv.port}/big`, { ...options, maxBytes: 1000 }), "too-large");
        await refusal(safeFetch(`http://ok.test:${srv.port}/chunked`, { ...options, maxBytes: 4000 }), "too-large");
        await refusal(safeFetch(`http://ok.test:${srv.port}/slow`, { ...options, timeout: 200 }), "timeout");
    } finally {
        srv.close();
    }
});

test("the caller's abort signal is honoured", async () => {
    const srv = await server(() => {});
    try {
        const { resolve } = dns({ "ok.test": ["127.0.0.1"] });
        const controller = new AbortController();
        const attempt = safeFetch(`http://ok.test:${srv.port}/`, { resolve, allowAddress: onlyLoopback, signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        await assert.rejects(attempt, (error) => !(error instanceof SafeFetchError && error.reason === "timeout"));
    } finally {
        srv.close();
    }
});

test("an unresolvable name is its own failure, not a pass", async () => {
    const { resolve } = dns({});
    await refusal(safeFetch("http://nowhere.test/", { resolve }), "unresolvable");
});
