/**
 * Account rotation for the local API: the four strategies, cooldowns after a usage limit or a
 * broken login, failover exclusion, the pool filter, sticky session bindings and the in-process
 * token ledger that keeps least-used honest between usage-report refreshes. Pure: no account,
 * transcript or agent is touched.
 */
import { test, expect } from "bun:test";
import { apiRotationOf } from "../src/config";
import { parseClaudeLine } from "../src/api-agents";
import { AccountRotator, classifyAccountError, parseResetAt, pickCandidate, poolOrder, type Candidate } from "../src/api-rotation";

const ACCOUNTS = ["default", "work", "personal"];
const c = (name: string, windowTokens = 0, inFlight = 0): Candidate => ({ name, windowTokens, inFlight });

test("round-robin cycles the candidates in order and wraps", () => {
    const r = new AccountRotator("round-robin", []);
    expect([1, 2, 3, 4].map(() => r.pick("claude", ACCOUNTS))).toEqual(["default", "work", "personal", "default"]);
});

test("round-robin keeps a separate cursor per tool", () => {
    const r = new AccountRotator("round-robin", []);
    expect(r.pick("claude", ACCOUNTS)).toBe("default");
    expect(r.pick("codex", ["default", "ci"])).toBe("default");
    expect(r.pick("claude", ACCOUNTS)).toBe("work");
});

test("fill-first stays on the first account until it cools down, then moves on", () => {
    const r = new AccountRotator("fill-first", []);
    expect(r.pick("claude", ACCOUNTS)).toBe("default");
    expect(r.pick("claude", ACCOUNTS)).toBe("default");
    r.markFault("claude", "default", "limit");
    expect(r.pick("claude", ACCOUNTS)).toBe("work");
});

test("least-used picks the fewest window tokens, then the fewest in flight, then pool order", () => {
    expect(pickCandidate("least-used", [c("a", 500), c("b", 100), c("c", 300)], 0)!.name).toBe("b");
    expect(pickCandidate("least-used", [c("a", 100, 2), c("b", 100, 1)], 0)!.name).toBe("b");
    expect(pickCandidate("least-used", [c("a", 100), c("b", 100)], 0)!.name).toBe("a");
});

test("least-used counts what this server sent since the usage report was built", () => {
    const r = new AccountRotator("least-used", [], () => ({ tokens: 0, asOf: 0 }));
    const end = r.begin("claude", "default");
    end(5000);
    expect(r.pick("claude", ["default", "work"])).toBe("work");
});

test("least-used spreads concurrent requests before any usage is recorded", () => {
    const r = new AccountRotator("least-used", []);
    r.begin("claude", "default");
    expect(r.pick("claude", ["default", "work"])).toBe("work");
});

test("random uses the injected source and stays in range", () => {
    expect(pickCandidate("random", [c("a"), c("b"), c("c")], 0, () => 0.99)!.name).toBe("c");
    expect(pickCandidate("random", [c("a"), c("b"), c("c")], 0, () => 0)!.name).toBe("a");
    expect(pickCandidate("random", [c("a")], 0, () => 1)!.name).toBe("a");
});

test("pick returns null when nothing is left, and with strategy off", () => {
    expect(new AccountRotator("off", []).pick("claude", ACCOUNTS)).toBeNull();
    const r = new AccountRotator("round-robin", []);
    expect(r.pick("claude", ACCOUNTS, new Set(ACCOUNTS))).toBeNull();
    expect(r.pick("claude", [])).toBeNull();
});

test("excluded accounts are skipped (failover never retries the same account)", () => {
    const r = new AccountRotator("fill-first", []);
    expect(r.pick("claude", ACCOUNTS, new Set(["default"]))).toBe("work");
});

test("poolOrder keeps the pool's order, drops unknown names and duplicates, empty = all", () => {
    expect(poolOrder(ACCOUNTS, [])).toEqual(ACCOUNTS);
    expect(poolOrder(ACCOUNTS, ["personal", "ghost", "default", "personal"])).toEqual(["personal", "default"]);
    const r = new AccountRotator("fill-first", ["personal", "default"]);
    expect(r.pick("claude", ACCOUNTS)).toBe("personal");
});

test("a limit cooldown uses the reported reset time, else backs off 2 min doubling to 30 min", () => {
    const now = 1_000_000_000_000;
    const r = new AccountRotator("round-robin", []);
    const reset = Math.floor(now / 1000) + 3600;
    r.markFault("claude", "work", "limit", `Claude AI usage limit reached|${reset}`, now);
    expect(r.snapshot(now).cooldowns[0]!.until).toBe(reset * 1000);

    const b = new AccountRotator("round-robin", []);
    b.markFault("claude", "work", "limit", "rate_limit_error", now);
    expect(b.snapshot(now).cooldowns[0]!.until).toBe(now + 2 * 60_000);
    b.markFault("claude", "work", "limit", "rate_limit_error", now);
    expect(b.snapshot(now).cooldowns[0]!.until).toBe(now + 4 * 60_000);
    for (let i = 0; i < 10; i++) b.markFault("claude", "work", "limit", "", now);
    expect(b.snapshot(now).cooldowns[0]!.until).toBe(now + 30 * 60_000);
    expect(b.coolingDown("claude", "work", now + 30 * 60_000)).toBe(false);
});

test("an auth failure cools the account down for 30 min", () => {
    const now = 1_000_000_000_000;
    const r = new AccountRotator("round-robin", []);
    r.markFault("claude", "work", "auth", "Invalid API key - Please run /login", now);
    expect(r.snapshot(now).cooldowns).toEqual([{ tool: "claude", account: "work", reason: "auth", until: now + 30 * 60_000 }]);
});

test("classifyAccountError separates account faults from other errors", () => {
    expect(classifyAccountError("Claude AI usage limit reached|1717000000")).toBe("limit");
    expect(classifyAccountError("You've hit your limit - resets 3pm")).toBe("limit");
    expect(classifyAccountError("5-hour limit reached")).toBe("limit");
    expect(classifyAccountError("API Error: 429 {\"type\":\"rate_limit_error\"}")).toBe("limit");
    expect(classifyAccountError("Invalid API key - Please run /login")).toBe("auth");
    expect(classifyAccountError("OAuth token has expired")).toBe("auth");
    expect(classifyAccountError("API Error: 529 overloaded_error")).toBeNull();
    expect(classifyAccountError("claude exited with code 1")).toBeNull();
    expect(classifyAccountError(undefined)).toBeNull();
});

test("parseResetAt reads the epoch suffix only", () => {
    expect(parseResetAt("Claude AI usage limit reached|1717000000")).toBe(1_717_000_000_000);
    expect(parseResetAt("limit reached")).toBe(0);
    expect(parseResetAt("id|17170000001234")).toBe(0);
});

test("session bindings stick and stay bounded", () => {
    const r = new AccountRotator("round-robin", []);
    r.bindSession("s1", "work");
    expect(r.sessionAccount("s1")).toBe("work");
    for (let i = 0; i < 1100; i++) r.bindSession(`x${i}`, "default");
    expect(r.sessionAccount("s1")).toBeUndefined();
    expect(r.sessionAccount("x1099")).toBe("default");
});

test("begin/end tracks in-flight work and the last served account", () => {
    const r = new AccountRotator("round-robin", []);
    const end = r.begin("claude", "work");
    expect(r.snapshot().inFlight).toEqual({ "claude:work": 1 });
    expect(r.snapshot().lastServed).toEqual({ claude: "work" });
    end(10);
    end(10);
    expect(r.snapshot().inFlight).toEqual({});
});

test("only the CLI's own error notice is classified, never the model's answer", () => {
    const notice = parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1717000000" }));
    expect(notice && notice.kind === "result" ? notice.faultMessage : undefined).toBe("Claude AI usage limit reached|1717000000");
    const answer = parseClaudeLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "Back off on HTTP 429 rate limit" }));
    expect(answer && answer.kind === "result" ? answer.faultMessage : undefined).toBeNull();
    const explicit = parseClaudeLine(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, error_message: "Invalid API key - Please run /login", result: "partial" }));
    expect(explicit && explicit.kind === "result" ? explicit.faultMessage : undefined).toBe("Invalid API key - Please run /login");
});

test("apiRotationOf reads an unknown saved strategy as off", () => {
    expect(apiRotationOf("least-used")).toBe("least-used");
    expect(apiRotationOf("roundrobin")).toBe("off");
    expect(apiRotationOf(undefined)).toBe("off");
});
