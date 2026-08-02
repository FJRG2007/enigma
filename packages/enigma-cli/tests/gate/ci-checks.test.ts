/**
 * CI poll pacing: the interval is also the detection lag.
 *
 * The monitor queries the provider and only then sleeps, so whatever interval is in force
 * when checks turn green is dead wall-clock added to the run. Upstream starts flat at 30s;
 * the early window ramps instead, while the 5-15min and steady-state tiers stay exactly as
 * upstream sets them so long monitoring keeps its API-call profile.
 */
import { test, expect } from "bun:test";
import { pollInterval } from "@/gate/pipeline/steps/ciChecks";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

test("the early window ramps instead of waiting a flat 30s", () => {
    expect(pollInterval(0)).toBe(5 * SECOND);
    expect(pollInterval(29 * SECOND)).toBe(5 * SECOND);
    expect(pollInterval(30 * SECOND)).toBe(10 * SECOND);
    expect(pollInterval(90 * SECOND)).toBe(10 * SECOND);
});

test("the upstream tiers are unchanged", () => {
    expect(pollInterval(2 * MINUTE)).toBe(30 * SECOND);
    expect(pollInterval(4 * MINUTE)).toBe(30 * SECOND);
    expect(pollInterval(5 * MINUTE)).toBe(60 * SECOND);
    expect(pollInterval(14 * MINUTE)).toBe(60 * SECOND);
    expect(pollInterval(15 * MINUTE)).toBe(120 * SECOND);
    expect(pollInterval(6 * 60 * MINUTE)).toBe(120 * SECOND);
});

test("intervals never regress as monitoring ages", () => {
    let previous = 0;
    for (let elapsed = 0; elapsed <= 20 * MINUTE; elapsed += 5 * SECOND) {
        const interval = pollInterval(elapsed);
        expect(interval).toBeGreaterThanOrEqual(previous);
        previous = interval;
    }
});
