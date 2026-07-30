/**
 * Resource governor: the budget maths across machine shapes.
 *
 * The maths is pure and injected with cores/RAM precisely so this never has to spawn a
 * process or read the host to be meaningful. The regression it guards: a cap that rounds to
 * zero cores, or a small machine treated like a big one.
 */
import { test, expect } from "bun:test";
import {
    resourceBudget,
    refuseLaunch,
    clampCapPercent,
    memoryUsePercent,
    totalMemoryGB,
    describeBudget,
    DEFAULT_RESOURCE_CAP,
    DEFAULT_LOW_MEMORY_CAP
} from "../src/governor";

const GB = 1024 ** 3;

test("a large machine gets the plain cap", () => {
    const budget = resourceBudget({ cap: 60 }, 32, 128 * GB);
    expect(budget.allowedCores).toBe(19);
    expect(budget.lowMemory).toBe(false);
    expect(budget.priority).toBe("below-normal");
    expect(budget.env.JOBS).toBe("19");
    expect(budget.env.MAKEFLAGS).toBe("-j19");
    expect(budget.env.NODE_OPTIONS).toBeUndefined();
    if (process.platform !== "darwin") expect(budget.affinityMask).toBe((1 << 19) - 1);
});

test("16 GB or less halves the cap and adds a per-child memory ceiling", () => {
    const budget = resourceBudget({ cap: 60 }, 8, 16 * GB);
    expect(budget.lowMemory).toBe(true);
    // 60% halved to 30% of 8 cores.
    expect(budget.allowedCores).toBe(2);
    expect(budget.env.NODE_OPTIONS).toContain("max-old-space-size");
});

test("the cap never rounds down to zero cores", () => {
    expect(resourceBudget({ cap: 1 }, 2, 64 * GB).allowedCores).toBe(1);
    expect(resourceBudget({ cap: 60 }, 1, 64 * GB).allowedCores).toBe(1);
    expect(resourceBudget({ cap: 60 }, 4, 8 * GB).allowedCores).toBe(1);
});

test("an out-of-range cap is clamped, not trusted", () => {
    expect(resourceBudget({ cap: 0 }, 32, 128 * GB).allowedCores).toBe(1);
    expect(resourceBudget({ cap: 500 }, 32, 128 * GB).allowedCores).toBe(32);
    // At 100% there is nothing to pin, so no mask is applied.
    expect(resourceBudget({ cap: 100 }, 32, 128 * GB).affinityMask).toBeNull();
});

test("bulk work drops to idle priority", () => {
    expect(resourceBudget({ cap: 60, bulk: true }, 32, 128 * GB).priority).toBe("idle");
    expect(resourceBudget({ cap: 60 }, 32, 128 * GB).ioBackground).toBe(true);
});

test("only a low-memory machine refuses a launch", () => {
    // 16 GB at 85% used, ceiling 80 -> refused, and the reason names both numbers.
    const refusal = refuseLaunch({ lowMemoryCap: 80 }, 16 * GB, 2.4 * GB);
    expect(refusal).not.toBeNull();
    expect(refusal!.memoryUsePercent).toBe(85);
    expect(refusal!.reason).toContain("80%");
    expect(refusal!.reason).toContain("16 GB");

    // Same machine with room -> allowed.
    expect(refuseLaunch({ lowMemoryCap: 80 }, 16 * GB, 8 * GB)).toBeNull();
    // A big machine under heavy memory use is throttled, never refused.
    expect(refuseLaunch({ lowMemoryCap: 80 }, 128 * GB, 2 * GB)).toBeNull();
});

test("a typed percentage falls back instead of collapsing to zero", () => {
    expect(clampCapPercent("", DEFAULT_RESOURCE_CAP)).toBe(60);
    expect(clampCapPercent("  ", DEFAULT_RESOURCE_CAP)).toBe(60);
    expect(clampCapPercent("abc", DEFAULT_LOW_MEMORY_CAP)).toBe(80);
    expect(clampCapPercent("0", DEFAULT_RESOURCE_CAP)).toBe(1);
    expect(clampCapPercent("150", DEFAULT_RESOURCE_CAP)).toBe(100);
    expect(clampCapPercent("45", DEFAULT_RESOURCE_CAP)).toBe(45);
});

test("machine readings", () => {
    expect(totalMemoryGB(16 * GB)).toBe(16);
    expect(totalMemoryGB(15.6 * GB)).toBe(15);
    expect(memoryUsePercent(100, 25)).toBe(75);
    expect(memoryUsePercent(0, 0)).toBe(0);
    expect(describeBudget(resourceBudget({ cap: 60 }, 8, 16 * GB))).toContain("low-memory machine");
});
