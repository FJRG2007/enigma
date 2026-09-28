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

// --- the rest of the second wave -----------------------------------------------------------------

test("every second-wave rule blocks, names its skill and a line escape hatch, and sits at the stage its backlog allows", () => {
    const expected: Record<string, { stage: "edit" | "diff"; skill: string; marker: string; }> = {
        "fe-purple-gradient": { stage: "diff", skill: "frontend-design", marker: "enigma:allow-brand-gradient" },
        "fe-gradient-text": { stage: "diff", skill: "frontend-design", marker: "enigma:allow-gradient-text" },
        "fe-accent-stripe": { stage: "diff", skill: "frontend-policy", marker: "enigma:allow-accent-stripe" },
        "fe-emoji-icon": { stage: "diff", skill: "frontend-policy", marker: "enigma:allow-emoji-icon" },
        // Zero findings over the corpus: scaffolding guards, so the edit stage.
        "ui-powered-by-buzzword": { stage: "edit", skill: "technical-writing-policy", marker: "enigma:allow-powered-by" },
        "ui-chat-residue": { stage: "edit", skill: "technical-writing-policy", marker: "enigma:allow-chat-residue" },
        "ui-ai-vocabulary": { stage: "diff", skill: "technical-writing-policy", marker: "enigma:allow-ai-vocabulary" },
        "db-unbounded-read": { stage: "diff", skill: "database-expert", marker: "enigma:allow-unbounded-read" },
        "db-select-star": { stage: "diff", skill: "database-expert", marker: "enigma:allow-select-star" },
        "db-query-in-loop": { stage: "diff", skill: "database-expert", marker: "enigma:allow-query-in-loop" },
        "fe-fixed-width": { stage: "diff", skill: "frontend-policy", marker: "enigma:allow-fixed-width" },
        "fe-static-viewport-height": { stage: "diff", skill: "frontend-policy", marker: "enigma:allow-viewport-height" },
    };
    for (const [id, want] of Object.entries(expected)) {
        const rule = BUILTIN_RULES.find((r) => r.id === id);
        expect(rule, id).toBeDefined();
        expect(rule!.severity, id).toBe("block");
        expect(rule!.stage ?? "edit", id).toBe(want.stage);
        expect(rule!.skill, id).toBe(want.skill);
        expect(rule!.message, id).toContain(want.marker);
        expect(rule!.message, id).toContain(`(${want.skill})`);
    }
});

matrix("fe-purple-gradient", true, [
    { name: "purple into pink", file: "src/Hero.tsx", code: "<div className=\"bg-gradient-to-r from-purple-500 to-pink-500\" />\n" },
    { name: "blue into indigo", file: "src/Hero.tsx", code: "<div className=\"bg-gradient-to-br from-blue-500 to-indigo-600\" />\n" },
    { name: "three stops", file: "src/Hero.tsx", code: "<h1 className=\"bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-500\" />\n" },
    { name: "arbitrary hex stops", file: "src/Card.tsx", code: "<a className=\"bg-gradient-to-r from-[#3b82f6]/10 to-[#8b5cf6]/10\" />\n" },
    { name: "the classic CSS pair", file: "src/app.css", code: ".hero {\n  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n}\n" },
    { name: "stops on the lines after the call", file: "src/app.css", code: ".hero {\n  background: linear-gradient(\n    90deg,\n    #3b82f6,\n    #8b5cf6\n  );\n}\n" },
]);

matrix("fe-purple-gradient", false, [
    { name: "one hue stepped lighter (a tonal ramp)", file: "src/Stat.tsx", code: "<dd className=\"bg-gradient-to-t from-violet-700 to-violet-400\" />\n" },
    { name: "an indigo ramp in hex", file: "src/app.css", code: ".cta { background: linear-gradient(135deg, #818cf8 0%, #6366f1 50%, #4f46e5 100%); }\n" },
    { name: "violet fading to black", file: "src/Grid.tsx", code: "const g = { gradient: \"linear-gradient(145deg, #4F46E5, #000)\" };\n" },
    { name: "a hue-picker spectrum", file: "src/Picker.tsx", code: "const track = { background: \"linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)\" };\n" },
    { name: "an emerald gradient", file: "src/Header.tsx", code: "<span className=\"bg-gradient-to-r from-emerald-300 to-emerald-500\" />\n" },
    { name: "the brand escape hatch", file: "src/Hero.tsx", code: "{/* enigma:allow-brand-gradient the brand is this gradient */}\n<div className=\"from-purple-500 to-pink-500\" />\n" },
]);

matrix("fe-gradient-text", true, [
    { name: "Tailwind gradient heading", file: "src/Hero.tsx", code: "<h1 className=\"bg-gradient-to-r from-blue-600 to-sky-500 bg-clip-text text-transparent\">Ship</h1>\n" },
    { name: "a CSS block clipping a gradient", file: "src/landing.css", code: ".gradient-text {\n  background: linear-gradient(90deg, #f97316, #ec4899);\n  -webkit-background-clip: text;\n  -webkit-text-fill-color: transparent;\n}\n" },
    { name: "a style block in a Svelte component", file: "src/Title.svelte", code: "<h1 class=\"t\">Hi</h1>\n<style>\n.t {\n  background-image: linear-gradient(red, blue);\n  background-clip: text;\n  color: transparent;\n}\n</style>\n" },
]);

matrix("fe-gradient-text", false, [
    { name: "clipped text over a solid colour", file: "src/Reveal.tsx", code: "<p className=\"bg-clip-text text-transparent bg-[#323238]\">x</p>\n" },
    { name: "a sliding shimmer label", file: "src/Mail.tsx", code: "<p className=\"bg-linear-to-r bg-size-[200%_100%] from-neutral-500 via-neutral-300 to-neutral-500 bg-clip-text text-transparent\">x</p>\n" },
    { name: "a typing label in CSS", file: "src/styles.css", code: ".ai-typing-label {\n  background: linear-gradient(90deg, #999, #fff);\n  background-clip: text;\n  color: transparent;\n}\n" },
    { name: "a minified stylesheet", file: "src/app.css", code: `.x{background:linear-gradient(red,blue);background-clip:text;color:transparent}${"a".repeat(500)}\n` },
]);

matrix("fe-accent-stripe", true, [
    { name: "stripe on a rounded card", file: "src/Callout.tsx", code: "<div className=\"rounded-lg border-l-4 border-blue-500 p-4\" />\n" },
    { name: "bracket width", file: "src/Result.tsx", code: "<li className=\"rounded border-l-[3px] border-accent\" />\n" },
    { name: "CSS block", file: "src/notice.css", code: ".notice {\n  border-left: 4px solid #f59e0b;\n  border-radius: 8px;\n}\n" },
]);

matrix("fe-accent-stripe", false, [
    { name: "left corners square (rounded-r)", file: "src/Result.tsx", code: "<div className=\"border-l-[3px] border-l-primary rounded-r-lg\" />\n" },
    { name: "a quote rule with no radius", file: "src/Quote.tsx", code: "<blockquote className=\"border-l-4 pl-4 italic\" />\n" },
    { name: "CSS radius only on the right", file: "src/quote.css", code: "blockquote {\n  border-left: 4px solid #ccc;\n  border-radius: 0 6px 6px 0;\n}\n" },
    { name: "a transparent placeholder border", file: "src/Nav.tsx", code: "<a className=\"rounded-md border-l-2 border-transparent\" />\n" },
]);

matrix("fe-emoji-icon", true, [
    { name: "emoji bullet in a list item", file: "src/Features.tsx", code: "<li>\u{1F680} Fast deploys</li>\n" },
    { name: "emoji in a heading", file: "src/Features.tsx", code: "<h4 className=\"font-semibold\">\u{1F512} Regular Scans</h4>\n" },
    { name: "emoji as an icon value", file: "src/data.tsx", code: "const items = [{ label: \"Search\", icon: \"\u{1F50D}\" }];\n" },
    { name: "emoji opening a label", file: "src/Menu.tsx", code: "const menu = [{ label: \"\u{26A1} Setup\" }];\n" },
]);

matrix("fe-emoji-icon", false, [
    { name: "an Ink terminal UI", file: "src/cli/Menu.tsx", code: "import { Text } from \"ink\";\nexport const M = () => <Text>\u{26A0} Note: width unknown</Text>;\n" },
    { name: "a gitmoji commit sample", file: "src/Demo.astro", code: "<span class=\"g\">\u{2728} feat(auth):</span>\n" },
    { name: "replayed terminal output", file: "src/Install.vue", code: "<p class=\"line output\"> \u{2714} Container started</p>\n" },
    { name: "an emoji that is the content (a reaction count)", file: "src/Reactions.tsx", code: "<button>\u{1F44D} 12</button>\n" },
    { name: "the text check mark U+2713", file: "src/Plan.tsx", code: "<li>\u{2713} Unlimited projects</li>\n" },
    { name: "a flag (ui-no-flag-emoji's job)", file: "src/Lang.tsx", code: "<option>\u{1F1EA}\u{1F1F8} Spanish</option>\n" },
]);

matrix("ui-powered-by-buzzword", true, [
    { name: "powered by AI", file: "src/Hero.tsx", code: "<p>Insights powered by AI</p>\n" },
    { name: "cutting-edge technology in a description prop", file: "src/Plans.tsx", code: "const f = { description: \"Storage powered by cutting-edge technology\" };\n" },
]);

matrix("ui-powered-by-buzzword", false, [
    { name: "a named provider", file: "src/Footer.tsx", code: "<span>Powered by Stripe</span>\n" },
    { name: "a required attribution", file: "src/Gifs.tsx", code: "<span>GIFs powered by Klipy</span>\n" },
    { name: "code, not copy", file: "src/ai.tsx", code: "const poweredByAi = isAiEnabled;\n" },
]);

matrix("ui-chat-residue", true, [
    { name: "an assistant disclaimer", file: "src/Help.tsx", code: "<p>As an AI language model, I cannot give legal advice.</p>\n" },
    { name: "a sign-off", file: "src/About.tsx", code: "<p>I hope this helps you get started.</p>\n" },
    { name: "an unfilled placeholder", file: "src/Footer.tsx", code: "<span>Copyright [Your Company]</span>\n" },
    { name: "a chat tracking link", file: "src/Links.tsx", code: `<a href="https://example.com/docs?utm_source=chat${"gpt"}.com">Docs</a>\n` },
]);

matrix("ui-chat-residue", false, [
    { name: "a job title", file: "src/Bio.tsx", code: "<p>I have worked as an AI engineer and a security specialist.</p>\n" },
    { name: "a sample output page", file: "examples/eval/output.html", code: "<td>As an AI language model, I cannot predict that.</td>\n" },
]);

matrix("ui-ai-vocabulary", true, [
    { name: "seamlessly in a tooltip", file: "src/Plans.tsx", code: "<Tip title=\"Integrate logging seamlessly into your app\" />\n" },
    { name: "leverage in a description", file: "src/Features.tsx", code: "const f = { description: \"Leverage machine learning to find growth\" };\n" },
    { name: "robust in JSX text", file: "src/Upgrade.vue", code: "<p>Robust import and export for every table</p>\n" },
]);

matrix("ui-ai-vocabulary", false, [
    { name: "unlock, which is literal", file: "src/Vault.tsx", code: "<p>Your master password unlocks everything in it</p>\n" },
    { name: "an ELEVATED risk tier", file: "src/Feed.tsx", code: "const t = { label: \"ELEVATED\" };\n" },
    { name: "a seamless loop", file: "src/Carousel.tsx", code: "const p = { description: \"When true, the carousel loops seamlessly from the last item\" };\n" },
    { name: "code text", file: "docs/api.html", code: "<code>Save(string path, bool seamless)</code>\n" },
    { name: "an identifier, not copy", file: "src/retry.tsx", code: "const robust = retries > 3;\n" },
]);

const ROUTE = "export async function GET() {\n";
matrix("db-unbounded-read", true, [
    { name: "Prisma findMany with no arguments", file: "app/api/users/route.ts", code: `${ROUTE}  const users = await prisma.user.findMany();\n}\n` },
    { name: "findMany with only select and orderBy", file: "app/api/users/route.ts", code: `${ROUTE}  return db.user.findMany({\n    select: { id: true },\n    orderBy: { createdAt: "desc" },\n  });\n}\n` },
    { name: "Drizzle select with no where or limit", file: "app/api/items/route.ts", code: `${ROUTE}  const rows = await db.select().from(items);\n}\n` },
]);

matrix("db-unbounded-read", false, [
    { name: "a where shorthand", file: "app/api/items/route.ts", code: `${ROUTE}  const rows = await db.invoice.findMany({\n    where,\n    orderBy: { issueDate: "desc" },\n  });\n}\n` },
    { name: "take and skip", file: "app/api/logs/route.ts", code: `${ROUTE}  await prisma.log.findMany({ take: 50, skip });\n}\n` },
    { name: "distinct values", file: "app/api/logs/route.ts", code: `${ROUTE}  await prisma.log.findMany({ select: { service: true }, distinct: ["service"] });\n}\n` },
    { name: "Drizzle grouped aggregate", file: "app/api/stats/route.ts", code: `${ROUTE}  const s = await db\n    .select({ n: count() })\n    .from(deliveries)\n    .groupBy(deliveries.webhookId);\n}\n` },
    { name: "a custom service findAll", file: "src/accounts.controller.ts", code: "@Controller(\"accounts\")\nexport class A {\n  @Get()\n  list() { return this.accountsService.findAll(); }\n}\n" },
    { name: "not request-serving code", file: "src/lib/report.ts", code: "export async function report() {\n  return prisma.user.findMany();\n}\n" },
    { name: "a seed script", file: "prisma/seed.ts", code: `${ROUTE}  await prisma.user.findMany();\n}\n` },
]);

matrix("db-select-star", true, [
    { name: "a row read", file: "src/db/tasks.ts", code: "const row = db.prepare(\"SELECT * FROM tasks WHERE id = ?\").get(id);\n" },
    { name: "a multi-line template", file: "src/db/runs.ts", code: "const rows = db.query(`\n  SELECT * FROM runs\n  ORDER BY created_at DESC\n`).all();\n" },
    { name: "Python", file: "app/memory.py", code: "cursor.execute(\"SELECT * FROM projects ORDER BY updated_at DESC\")\n" },
]);

matrix("db-select-star", false, [
    { name: "an interpolated table (a DB browser)", file: "src/clients/pg.ts", code: "const q = `SELECT * FROM ${wrap(schema)}.${wrap(table)} LIMIT 100`;\n" },
    { name: "a subquery", file: "src/db/q.ts", code: "const q = \"SELECT * FROM (SELECT id, name FROM users) u\";\n" },
    { name: "EXISTS", file: "src/db/q.ts", code: "const q = \"SELECT id FROM a WHERE EXISTS (SELECT * FROM b WHERE b.a = a.id)\";\n" },
    { name: "a CTE that chose its columns", file: "src/db/tree.ts", code: "const q = `WITH src AS (SELECT id, parent FROM nodes)\nSELECT * FROM src`;\n" },
    { name: "a migration file", file: "src/migration/20250404_add_ids.js", code: "await runner.query(\"SELECT * FROM installation_ids LIMIT 1\");\n" },
    { name: "SQL shown as text in JSX", file: "src/SastVisual.tsx", code: "<span>{'\"SELECT * FROM users WHERE id=\"'}</span>\n" },
    { name: "prose, not a query string", file: "src/db/notes.ts", code: "// SELECT * FROM users is avoided here\n" },
]);

matrix("db-query-in-loop", true, [
    { name: "findFirst per row", file: "src/import.ts", code: "for (const draft of drafts) {\n  const existing = await db.graphNode.findFirst({ where: { label: draft.label } });\n  if (!existing) created++;\n}\n" },
    { name: "count per team", file: "src/team.service.ts", code: "for (const team of teams) {\n  const n = await this.prisma.teamMember.count({ where: { teamId: team.id } });\n}\n" },
]);

matrix("db-query-in-loop", false, [
    { name: "one query with in:", file: "src/import.ts", code: "const existing = await db.graphNode.findMany({ where: { id: { in: ids } } });\nfor (const e of existing) byId.set(e.id, e);\n" },
    { name: "a loop over batches", file: "src/sync.ts", code: "for (const batch of batches) {\n  await db.user.findMany({ where: { id: { in: batch } } });\n}\n" },
    { name: "a fixed table of specs", file: "src/dump.ts", code: "for (const spec of TABLES) {\n  rows = await db.select().from(spec.table);\n}\n" },
    { name: "a two-element literal", file: "src/merge.ts", code: "for (const person of [a, b]) {\n  await db.account.findOne({ uuid: person });\n}\n" },
    { name: "a single-line loop does not reach the block below it", file: "src/refresh.ts", code: "for (const id of ids) await refresh(id);\nif (ok) {\n  const f = await prisma.folder.findFirst({ where: { id } });\n}\n" },
]);

matrix("fe-fixed-width", true, [
    { name: "a modal wider than a phone", file: "src/Modal.tsx", code: "<div className=\"w-[520px] max-h-[90vh] rounded-xl\" />\n" },
    { name: "a popover", file: "src/Filters.tsx", code: "<PopoverContent align=\"end\" className=\"w-[420px] p-0\" />\n" },
    { name: "a CSS dialog", file: "src/styles.css", code: ".modal {\n  width: 600px;\n  padding: 24px;\n}\n" },
]);

matrix("fe-fixed-width", false, [
    { name: "capped by max-w", file: "src/Modal.tsx", code: "<div className=\"w-[640px] max-w-full\" />\n" },
    { name: "set from a breakpoint", file: "src/Panel.tsx", code: "<div className=\"w-full md:w-[640px]\" />\n" },
    { name: "a guard in a sibling run", file: "src/Popover.tsx", code: "<div className={cn(\"p-0 w-[480px]\", isMobile ? \"w-full\" : \"\")} />\n" },
    { name: "a lone ternary token", file: "src/Wall.tsx", code: "const w = wide\n  ? \"w-[560px]\"\n  : \"w-[400px]\";\n" },
    { name: "a blurred glow", file: "src/Bg.tsx", code: "<div className=\"absolute w-[600px] h-[600px] bg-purple-500/10 rounded-full blur-[130px]\" />\n" },
    { name: "a CSS width inside a media query", file: "src/app.css", code: "@media (min-width: 900px) {\n  .modal { width: 800px; }\n}\n" },
    { name: "a CSS width overridden by a media query", file: "src/app.css", code: ".container { width: 960px; }\n@media (max-width: 768px) {\n  .container { width: 100%; }\n}\n" },
    { name: "an email template", file: "src/emails/welcome.html", code: "<style>\n.body { width: 600px; }\n</style>\n" },
    { name: "a narrow width", file: "src/Menu.tsx", code: "<div className=\"w-[320px]\" />\n" },
]);

matrix("fe-static-viewport-height", true, [
    { name: "min-h-screen page", file: "app/page.tsx", code: "<main className=\"min-h-screen\" />\n" },
    { name: "h-screen shell", file: "src/App.vue", code: "<div class=\"h-screen p-5 flex flex-col\" />\n" },
    { name: "calc in an arbitrary value", file: "src/Docs.tsx", code: "<aside className=\"sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto\" />\n" },
    { name: "inline style", file: "src/View.tsx", code: "<div style={{ height: \"100vh\" }} />\n" },
    { name: "CSS", file: "src/main.css", code: "body {\n  min-height: 100vh;\n}\n" },
]);

matrix("fe-static-viewport-height", false, [
    { name: "the dynamic unit", file: "app/page.tsx", code: "<main className=\"min-h-dvh\" />\n" },
    { name: "a 100vh fallback line before 100dvh", file: "src/main.css", code: ".shell {\n  height: 100vh;\n  height: 100dvh;\n}\n" },
    { name: "desktop only", file: "src/Side.tsx", code: "<aside className=\"md:h-screen\" />\n" },
    { name: "max-h is a cap, not a height", file: "src/Dialog.tsx", code: "<div className=\"max-h-screen overflow-auto\" />\n" },
    { name: "the escape hatch", file: "src/Desk.tsx", code: "<div className=\"h-screen\" /> {/* enigma:allow-viewport-height desktop app */}\n" },
]);
