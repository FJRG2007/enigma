/**
 * The self-audit stands down on a trivial turn: a few added lines in a few files, none sensitive.
 * An audit is a whole extra model turn, and on a copy fix it cost more than the fix.
 *
 * Run: bun test tests/verify/trivial-turn.test.ts
 */
import { expect, test } from "bun:test";
import { trivialTurn } from "../../src/verify";

const lines = (file: string, n: number) => Array.from({ length: n }, (_, i) => ({ file, line: i + 1, text: `x${i}` }));

test("a small turn is trivial; a large, broad, sensitive, truncated or empty one is not", () => {
    expect(trivialTurn({ lines: lines("src/Hero.tsx", 3), truncated: false }, 20)).toBe(true);
    expect(trivialTurn({ lines: lines("src/Hero.tsx", 21), truncated: false }, 20)).toBe(false);
    expect(trivialTurn({ lines: ["a", "b", "c", "d"].flatMap((f) => lines(`src/${f}.ts`, 1)), truncated: false }, 20)).toBe(false);
    expect(trivialTurn({ lines: lines("src/auth/session.ts", 2), truncated: false }, 20)).toBe(false);
    expect(trivialTurn({ lines: lines("src/a.ts", 2), truncated: true }, 20)).toBe(false);
    expect(trivialTurn({ lines: [], truncated: false }, 20)).toBe(false);
    expect(trivialTurn({ lines: lines("src/a.ts", 2), truncated: false }, 0)).toBe(false);
});
