/**
 * Precision matrix for the generated-UI tell rules (guardrails.md, "THE SECOND WAVE"): the shape
 * each rule names, and the near-misses that must stay quiet. Temp HOME + isolated config set
 * before import, like the other guardrails suites.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gr-tells-"));
process.env.USERPROFILE = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_GUARDRAILS_CONFIG = join(HOME, "guardrails.json");

const { BUILTIN_RULES, checkFile } = await import("../src/guardrails");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** The lines `ruleId` reports, checked at the rule's own stage (a diff rule is invisible at the edit stage). */
function lines(ruleId: string, file: string, code: string): number[] {
    const stage = BUILTIN_RULES.find((r) => r.id === ruleId)?.stage ?? "edit";
    return checkFile(file, code, null, stage).filter((f) => f.ruleId === ruleId).map((f) => f.line ?? 0);
}

function matrix(ruleId: string, expected: boolean, cases: Array<{ name: string; file: string; code: string; }>): void {
    for (const c of cases) {
        test(`${ruleId} ${expected ? "flags" : "ignores"}: ${c.name}`, () => {
            expect(lines(ruleId, c.file, c.code).length > 0).toBe(expected);
        });
    }
}

test("fe-sparkles-icon blocks at the diff stage, names frontend-design and carries a line escape hatch", () => {
    const rule = BUILTIN_RULES.find((r) => r.id === "fe-sparkles-icon");
    expect(rule).toBeDefined();
    expect(rule!.severity).toBe("block");
    expect(rule!.stage).toBe("diff");
    expect(rule!.skill).toBe("frontend-design");
    expect(rule!.message).toContain("enigma:allow-sparkles-icon");
    expect(rule!.message).toContain("(frontend-design)");
});

test("fe-sparkles-icon never runs at the edit stage (the corpus backlog is 171 files)", () => {
    const code = "import { Sparkles } from \"lucide-react\";\n";
    expect(checkFile("src/Badge.tsx", code, null, "edit").some((f) => f.ruleId === "fe-sparkles-icon")).toBe(false);
});

matrix("fe-sparkles-icon", true, [
    { name: "lucide-react named import", file: "src/components/AiButton.tsx", code: "import { Wand, Sparkles } from \"lucide-react\";\n" },
    { name: "multi-line import", file: "src/components/Stats.tsx", code: "import {\n  Gauge,\n  Sparkles,\n  Waypoints\n} from \"lucide-react\";\n" },
    { name: "aliased import", file: "src/Nav.jsx", code: "import { Sparkles as AiIcon } from \"lucide-react\";\n" },
    { name: "lucide for Vue", file: "src/Badge.vue", code: "<script setup>\nimport { Sparkles } from \"lucide-vue-next\";\n</script>\n" },
    { name: "heroicons", file: "src/Hero.tsx", code: "import { SparklesIcon } from \"@heroicons/react/24/outline\";\n" },
    { name: "tabler", file: "src/Grid.tsx", code: "import {\n  IconLock,\n  IconSparkles,\n} from '@tabler/icons-react';\n" },
    { name: "phosphor", file: "src/New.tsx", code: "import { Sparkle } from \"@phosphor-icons/react\";\n" },
]);

matrix("fe-sparkles-icon", false, [
    { name: "an icon that names the action", file: "src/AiButton.tsx", code: "import { Wand, PenLine } from \"lucide-react\";\n" },
    { name: "a project component that happens to be called Sparkles", file: "src/Hero.tsx", code: "import { Sparkles } from \"@/components/effects/sparkles\";\n" },
    { name: "a name that only starts with Sparkles", file: "src/Hero.tsx", code: "import { SparklesCore } from \"lucide-react\";\n" },
    { name: "a commented-out import", file: "src/Hero.tsx", code: "// import { Sparkles } from \"lucide-react\";\n" },
    { name: "escape hatch on the line", file: "src/EffectPicker.tsx", code: "import { Sparkles } from \"lucide-react\"; // enigma:allow-sparkles-icon the effect is sparkles\n" },
    { name: "escape hatch on the line above", file: "src/EffectPicker.tsx", code: "// enigma:allow-sparkles-icon the effect picker offers a sparkles effect\nimport { Sparkles } from \"lucide-react\";\n" },
    { name: "a test file", file: "src/AiButton.test.tsx", code: "import { Sparkles } from \"lucide-react\";\n" },
    { name: "a story", file: "src/AiButton.stories.tsx", code: "import { Sparkles } from \"lucide-react\";\n" },
    { name: "a non-UI module", file: "src/icons.ts", code: "import { Sparkles } from \"lucide-react\";\n" },
]);

test("fe-sparkles-icon reports the line of the imported name, not the import keyword", () => {
    expect(lines("fe-sparkles-icon", "src/Stats.tsx", "import {\n  Gauge,\n  Sparkles,\n} from \"lucide-react\";\n")).toEqual([3]);
});
