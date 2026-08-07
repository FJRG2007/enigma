/**
 * Rule precision matrix for the convention guardrails: realistic, multi-framework fixtures
 * for each heuristic rule, split into cases that MUST flag (true positives) and cases that
 * MUST NOT (false positives). False positives are the priority - one wrong flag trains the
 * agent to ignore the gate - so the "no flag" tables are deliberately exhaustive across the
 * common validators/frameworks, and include the exact patterns that false-positived when
 * scanning real reference repos. Temp HOME + isolated config set before import.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gr-rules-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_GUARDRAILS_CONFIG = join(HOME, "guardrails.json");

const { BUILTIN_RULES, checkFile } = await import("../src/guardrails");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/**
 * Whether `ruleId` fired on the given file/content.
 *
 * The stage comes from the rule itself. A diff-stage rule is invisible to an edit-stage
 * check by design, so hardcoding the default silently turns every one of its true-positive
 * rows into a failure the moment a rule is promoted to that stage - which is exactly what
 * happened to `fe-search-fuzzy`.
 */
function flagged(ruleId: string, file: string, code: string): boolean {
    const stage = BUILTIN_RULES.find((r) => r.id === ruleId)?.stage ?? "edit";
    return checkFile(file, code, null, stage).some((f) => f.ruleId === ruleId);
}

/** Run a table of {name, file, code} against `ruleId`, asserting the expected flag outcome. */
function matrix(ruleId: string, expected: boolean, cases: Array<{ name: string; file: string; code: string; }>): void {
    for (const c of cases) {
        test(`${ruleId} ${expected ? "flags" : "ignores"}: ${c.name}`, () => {
            expect(flagged(ruleId, c.file, c.code)).toBe(expected);
        });
    }
}

// --- be-validate-input-ts ----------------------------------------------------------

matrix("be-validate-input-ts", true, [
    { name: "express req.body destructure, no validation", file: "src/routes/user.ts", code: `app.post("/u", (req, res) => {\n  const { name } = req.body;\n  save(name);\n});` },
    { name: "next.js request.json(), no validation", file: "app/api/route.ts", code: `export async function POST(request: Request) {\n  const body = await request.json();\n  return create(body);\n}` },
    { name: "koa ctx.request.body, no validation", file: "src/user.ts", code: `router.post("/u", (ctx) => {\n  const data = ctx.request.body;\n  ctx.body = save(data);\n});` },
    { name: "hono c.req.json(), no validation", file: "src/hono.ts", code: `app.post("/u", async (c) => {\n  const body = await c.req.json();\n  return c.json(save(body));\n});` },
]);

matrix("be-validate-input-ts", false, [
    // Real-world false-positive sources found by scanning claude-mem/headroom - must NOT flag:
    { name: "req.query scalar (validated inline, not a body)", file: "src/routes/list.ts", code: `const page = Number(req.query.page) || 1;\nconst topic = (req.query.topic as string) || "all";` },
    { name: "req.params scalar", file: "src/handler.ts", code: `const value = parseInt(req.params[name], 10);\nif (isNaN(value)) return badRequest(res);` },
    { name: "req.body passed as a bare arg (e.g. to a logger)", file: "src/middleware.ts", code: `const summary = summarizeRequestBody(req.method, req.path, req.body);\nlogger.debug("HTTP", summary);` },
    { name: "test file is excluded", file: "src/routes/user.test.ts", code: `const body = req.body;\nexpect(body).toEqual({});` },
    // Validated by a library - the broad absent set skips the whole file:
    { name: "zod parse", file: "src/routes/user.ts", code: `import { z } from "zod";\nconst S = z.object({ name: z.string() });\nconst { name } = S.parse(req.body);` },
    { name: "zod safeParse", file: "src/routes/user.ts", code: `const r = Schema.safeParse(req.body);\nif (!r.success) return res.status(400);\nconst data = req.body;` },
    { name: "joi validate", file: "src/routes/user.ts", code: `const { error, value } = schema.validate(req.body);\nif (error) return res.status(400);\nconst body = req.body;` },
    { name: "yup validate", file: "src/routes/user.ts", code: `import * as yup from "yup";\nconst data = await schema.validate(req.body);` },
    { name: "valibot parse", file: "src/routes/user.ts", code: `import { parse } from "valibot";\nconst data = parse(Schema, req.body);` },
    { name: "typebox Type.Object", file: "src/routes/user.ts", code: `import { Type } from "@sinclair/typebox";\nconst S = Type.Object({ name: Type.String() });\nconst body = req.body;` },
    { name: "ajv compiled validate", file: "src/routes/user.ts", code: `const validate = ajv.compile(schema);\nconst body = req.body;\nif (!validate(body)) throw new Error("bad");` },
    { name: "express-validator checkSchema", file: "src/routes/user.ts", code: `app.post("/u", checkSchema(rules), (req, res) => {\n  const { name } = req.body;\n});` },
    { name: "nestjs @Body decorator (no req.body)", file: "src/user.controller.ts", code: `@Post()\nasync create(@Body() dto: CreateUserDto) {\n  return this.svc.create(dto);\n}` },
    { name: "fastify request.body is not req.body", file: "src/routes/user.ts", code: `fastify.post("/u", async (request) => {\n  const body = request.body;\n  return save(body);\n});` },
    { name: "req.body only inside a comment", file: "src/routes/user.ts", code: `// destructure req.body after the middleware validates it\nreturn handler();` },
]);

// --- be-validate-input-py ----------------------------------------------------------

matrix("be-validate-input-py", true, [
    { name: "flask get_json, no schema", file: "api/views.py", code: `data = request.get_json()\nname = data["name"]` },
    { name: "flask form, no schema", file: "api/views.py", code: `name = request.form["name"]\nsave(name)` },
    { name: "fastapi raw request.json()", file: "api/routes.py", code: `async def handler(request):\n    body = await request.json()\n    return create(body)` },
    { name: "django request.POST, no form", file: "api/views.py", code: `def create(request):\n    name = request.POST["name"]\n    return save(name)` },
]);

matrix("be-validate-input-py", false, [
    { name: "pydantic model_validate", file: "api/routes.py", code: `from pydantic import BaseModel\nclass In(BaseModel):\n    name: str\nbody = await request.json()\nIn.model_validate(body)` },
    { name: "fastapi typed param (no raw read)", file: "api/routes.py", code: `from pydantic import BaseModel\nclass Item(BaseModel):\n    name: str\n@app.post("/")\nasync def create(item: Item):\n    return item` },
    { name: "marshmallow load", file: "api/views.py", code: `from marshmallow import Schema\ndata = schema.load(request.get_json())` },
    { name: "django form is_valid", file: "api/views.py", code: `form = MyForm(request.POST)\nif form.is_valid():\n    save(form.cleaned_data)` },
    { name: "jsonschema validate", file: "api/views.py", code: `import jsonschema\njsonschema.validate(request.get_json(), schema)` },
    { name: "raw request.data is not flagged (webhook bytes)", file: "api/hook.py", code: `payload = request.data\nverify_hmac(payload, signature)` },
    { name: "request body passed as a bare arg (not assigned)", file: "api/log.py", code: "log_request(request.method, request.get_json())" },
    { name: "test file is excluded", file: "tests/test_views.py", code: `data = request.get_json()\nassert data == {}` },
    { name: "request.get_json only in a comment", file: "api/views.py", code: `# request.get_json() is validated by the @use_args decorator below\n@use_args(schema)\ndef create(args):\n    return save(args)` },
]);

// --- fe-password-input -------------------------------------------------------------

matrix("fe-password-input", true, [
    { name: "raw password input, double quotes", file: "src/Login.tsx", code: "<input type=\"password\" name=\"pw\" />" },
    { name: "raw password input, single quotes", file: "src/Login.jsx", code: "<input type='password' />" },
    { name: "raw password input, other attrs first", file: "src/Login.tsx", code: "<input className=\"field\" type=\"password\" required />" },
]);

matrix("fe-password-input", false, [
    { name: "reusable Input component (capitalized)", file: "src/Login.tsx", code: "<Input type=\"password\" name=\"pw\" />" },
    { name: "file implements a show/hide toggle", file: "src/PasswordField.tsx", code: `const [showPassword, setShowPassword] = useState(false);\nreturn <input type="password" />;` },
    { name: "dynamic type (toggle via expression)", file: "src/PasswordField.tsx", code: "<input type={visible ? \"text\" : \"password\"} />" },
    { name: "plain text input", file: "src/Login.tsx", code: "<input type=\"text\" name=\"user\" />" },
    { name: "type as an object key, not a JSX attr", file: "src/schema.tsx", code: "const field = { name: \"pw\", type: \"password\" };" },
    { name: "password input inside a JSX comment", file: "src/Login.tsx", code: `{/* <input type="password" /> was the old field */}\nreturn <Input type="password" />;` },
]);

// --- fe-no-native-dialog -----------------------------------------------------------

matrix("fe-no-native-dialog", true, [
    { name: "alert with a string", file: "src/Page.tsx", code: "alert(\"Saved!\")" },
    { name: "confirm with a string", file: "src/Page.tsx", code: "if (confirm(\"Delete this item?\")) remove();" },
    { name: "bare prompt with a string", file: "src/Page.tsx", code: "const name = prompt(\"Enter your name\");" },
    { name: "window.alert", file: "src/util.ts", code: "window.alert(message);" },
    { name: "window.confirm", file: "src/Page.tsx", code: "const ok = window.confirm(msg);" },
    { name: "window.prompt", file: "src/Page.tsx", code: "const v = window.prompt(\"Name?\");" },
]);

matrix("fe-no-native-dialog", false, [
    { name: "method call toast.alert", file: "src/Page.tsx", code: "toast.alert(\"could not save\");" },
    { name: "custom confirm with a config object", file: "src/Page.tsx", code: "confirm({ title: \"Delete?\", onConfirm });" },
    { name: "clack p.confirm (method + object)", file: "src/cli.ts", code: "const ok = await p.confirm({ message: \"Proceed?\" });" },
    { name: "inquirer bare confirm with object", file: "src/cli.ts", code: "const ok = await confirm({ message: \"Go ahead?\" });" },
    { name: "AI prompt variable (string, not a dialog)", file: "src/chat.tsx", code: "const prompt = buildPrompt(messages);" },
    { name: "AI prompt passed as an argument", file: "src/chat.tsx", code: "const res = await llm.complete(prompt);" },
    { name: "capitalized custom Confirm component/fn", file: "src/Page.tsx", code: "Confirm(\"really?\");" },
    { name: "identifier ending in Prompt", file: "src/chat.tsx", code: "const t = renderPrompt(\"template\", vars);" },
    { name: "test file is excluded", file: "src/Page.test.tsx", code: "alert(\"x\");" },
]);

// --- fe-date-moment ----------------------------------------------------------------

matrix("fe-date-moment", true, [
    { name: "default import, double quotes", file: "src/Row.tsx", code: `import moment from "moment";\nreturn <span>{moment(ts).fromNow()}</span>;` },
    { name: "default import, single quotes", file: "src/Row.jsx", code: "import moment from 'moment';" },
    { name: "require form", file: "src/Row.jsx", code: "const moment = require(\"moment\");" },
    { name: "moment-timezone", file: "src/Row.tsx", code: "import moment from \"moment-timezone\";" },
    { name: "multiline named import (from line matches)", file: "src/Row.tsx", code: `import {\n  duration,\n} from "moment";` },
]);

matrix("fe-date-moment", false, [
    { name: "react-moment is a different package", file: "src/Row.tsx", code: "import Moment from \"react-moment\";" },
    { name: "date-fns is fine", file: "src/Row.tsx", code: "import { formatDistanceToNow } from \"date-fns\";" },
    { name: "dayjs is fine", file: "src/Row.tsx", code: "import dayjs from \"dayjs\";" },
    { name: "relative-time (the recommended element)", file: "src/Row.tsx", code: "return <relative-time datetime={iso}>{fallback}</relative-time>;" },
    { name: "prose mentioning moment in a comment", file: "src/Row.tsx", code: `// migrated away from moment to Intl\nreturn <time>{fmt(ts)}</time>;` },
    { name: "moment only inside a string, not an import", file: "src/Row.tsx", code: "const note = \"ported from moment.js\";" },
    { name: "test file is excluded", file: "src/Row.test.tsx", code: "import moment from \"moment\";" },
]);

// --- fe-search-fuzzy ---------------------------------------------------------------

matrix("fe-search-fuzzy", true, [
    { name: "classic case-insensitive substring finder", file: "src/List.tsx", code: "const results = items.filter(i => i.name.toLowerCase().includes(query.toLowerCase()));" },
    { name: "different field/query names", file: "src/Search.jsx", code: "const shown = rows.filter(r => r.title.toLowerCase().includes(q.toLowerCase()));" },
    // One-sided: the needle is lowercased once into a binding, and its NAME carries the
    // evidence the second toLowerCase would have. Half the real corpus is written this way.
    { name: "one-sided, needle named for a search box", file: "src/List.tsx", code: "const r = items.filter(i => i.name.toLowerCase().includes(query));" },
    { name: "one-sided, needle named search", file: "src/Picker.tsx", code: "const r = options.filter(o => o.label.toLowerCase().includes(searchLower));" },
    // The clearing signal is word-bounded, so an unrelated "refuse" in the copy no longer
    // switches a blocking rule off - which it did, in a real file, for two search boxes.
    { name: "the word refuse does not clear it", file: "src/List.tsx", code: "// we refuse an empty query\nconst r = items.filter(i => i.name.toLowerCase().includes(q.toLowerCase()));" },
]);

matrix("fe-search-fuzzy", false, [
    { name: "file already uses fuse.js", file: "src/Search.tsx", code: `import Fuse from "fuse.js";\nconst r = items.filter(i => i.name.toLowerCase().includes(q.toLowerCase()));` },
    { name: "exact structured filter (no search)", file: "src/List.tsx", code: "const open = items.filter(i => i.status === \"open\");" },
    { name: "one-sided, needle not named for a search box", file: "src/List.tsx", code: "const r = items.filter(i => i.name.toLowerCase().includes(prefix));" },
    // A needle named *Filter is the picked-value case the rule's own escape hatch sanctions,
    // so `filter` is deliberately not one of the names that carry the one-sided form.
    { name: "picked-value filter, not a typed search", file: "src/Table.tsx", code: "const r = rows.filter(x => x.status.toLowerCase().includes(statusFilter));" },
    { name: "symmetric includes but not inside a filter", file: "src/util.tsx", code: "if (a.toLowerCase().includes(b.toLowerCase())) merge();" },
    { name: "test file is excluded", file: "src/List.test.tsx", code: "const r = items.filter(i => i.name.toLowerCase().includes(q.toLowerCase()));" },
]);

// --- doc-no-file-tree --------------------------------------------------------------
// Fixtures embed the literal box-drawing connectors (U+251C/U+2514 + U+2500) the rule detects.

matrix("doc-no-file-tree", true, [
    { name: "tree branch connector in README", file: "README.md", code: "## Project Structure\n├── src/\n└── package.json" },
    { name: "tree in a nested package README", file: "packages/app/README.md", code: "└── package.json" },
]);

matrix("doc-no-file-tree", false, [
    { name: "normal README prose", file: "README.md", code: "## Install\nRun `npm install` then `npm start`." },
    { name: "markdown table (no box-drawing)", file: "README.md", code: "| Key | Value |\n| --- | --- |\n| a | b |" },
    { name: "mermaid diagram (arrows, not box-drawing)", file: "README.md", code: "graph TD\n  A --> B" },
    { name: "legit tree in a non-README doc (authoring guide) is allowed", file: "assets/skills/skill-creator/SKILL.md", code: "skill-name/\n├── SKILL.md\n└── reference.md" },
]);

// --- be-no-leak-internal-error -----------------------------------------------------

matrix("be-no-leak-internal-error", true, [
    { name: "5xx returning err.message (the Prisma leak)", file: "src/routes/user.ts", code: "res.status(500).json({ error: err.message });" },
    { name: "5xx sending error.message", file: "src/api.ts", code: "return res.status(500).send(error.message);" },
    { name: "stack trace in any response", file: "src/api.ts", code: "res.send(err.stack);" },
    { name: "503 with e.message", file: "src/api.ts", code: "res.status(503).json({ detail: e.message });" },
]);

matrix("be-no-leak-internal-error", false, [
    { name: "5xx with a generic constructed message", file: "src/api.ts", code: "res.status(500).json({ error: \"Something went wrong\" });" },
    { name: "4xx validation reply may carry a safe message", file: "src/api.ts", code: "res.status(400).json({ error: err.message });" },
    { name: "logging the real error server-side is fine", file: "src/api.ts", code: "console.error(err.message);" },
    { name: "logger.error with the stack is fine (not a response)", file: "src/api.ts", code: "logger.error(err.stack);" },
    { name: "generic 500, no error internals", file: "src/api.ts", code: "res.status(500).json({ error: \"internal_error\" });" },
    { name: "test file is excluded", file: "src/api.test.ts", code: "res.status(500).json({ error: err.message });" },
]);

// --- ui-no-em-dash -----------------------------------------------------------------
// The dashes are built from their code points so this file stays ASCII. Every "ignores"
// case below is a real shape found while scanning ~1100 UI files across reference repos.

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

matrix("ui-no-em-dash", true, [
    { name: "JSX copy", file: "src/Hero.tsx", code: `<p>Saves tokens ${EM_DASH} automatically</p>` },
    { name: "string constant holding an empty state", file: "src/copy.ts", code: `export const EMPTY = "No results ${EM_DASH} try another filter";` },
    { name: "page title in an HTML document", file: "index.html", code: `<title>Enigma ${EM_DASH} local dashboard</title>` },
    { name: "metadata description in a layout", file: "app/layout.tsx", code: `default: "Headroom ${EM_DASH} Context Optimization Layer",` },
    { name: "console message a person reads", file: "src/cli.js", code: `console.log("Account rotated ${EM_DASH} switching on the next request");` },
    { name: "numeric range with an en dash", file: "src/Stats.tsx", code: `<span>60${EN_DASH}95% fewer tokens</span>` },
    { name: "no spaces around the dash", file: "src/Hero.tsx", code: `<h2>fast${EM_DASH}quiet</h2>` },
]);

matrix("ui-no-em-dash", false, [
    { name: "plain hyphen is the correct form", file: "src/Hero.tsx", code: "<p>Saves tokens - automatically</p>" },
    { name: "standalone glyph as an empty-cell placeholder", file: "src/table.tsx", code: `const cell = (v) => v ?? "${EM_DASH}";` },
    { name: "standalone glyph in markup", file: "src/Row.tsx", code: `<span class="muted">${EM_DASH}</span>` },
    { name: "standalone glyph as a CLI bullet", file: "src/log.ts", code: `out(\`  \${yellow("${EN_DASH}")} \${label}\`);` },
    { name: "dash-stripping sanitizer", file: "src/clean.ts", code: `const s = raw.replace(/${EM_DASH}/g, "-");` },
    { name: "normalizer helper", file: "src/text.ts", code: `export const normalizeDashes = (s) => s.split("${EM_DASH}").join("-");` },
    { name: "entity/character table", file: "src/entities.ts", code: `const mdash = "${EM_DASH}";` },
    { name: "code point comparison", file: "src/ascii.ts", code: `if (ch === String.fromCharCode(0x2014)) out += "${EM_DASH}";` },
    { name: "trailing developer comment, not UI copy", file: "src/pool.ts", code: `const web = toWeb(res); // one stream ${EM_DASH} one consumer` },
    { name: "line marked with an enigma note", file: "src/Quote.tsx", code: `<blockquote>{"To be ${EM_DASH} or not"}</blockquote> // enigma: verbatim quote` },
    { name: "file-wide opt-out for quoted source text", file: "src/Quote.tsx", code: `// enigma:allow-dash\nexport const q = "To be ${EM_DASH} or not";` },
    { name: "markdown prose is out of scope", file: "docs/guide.md", code: `Saves tokens ${EM_DASH} automatically` },
    { name: "test fixture is excluded", file: "src/__tests__/Hero.test.tsx", code: `<p>x ${EM_DASH} y</p>` },
    { name: "build output is excluded", file: "apps/dist/main.js", code: `t("x ${EM_DASH} y")` },
    { name: "vendored tree is excluded", file: "vendor/pkg/ui.js", code: `el.textContent = "a ${EM_DASH} b";` },
]);

// --- fe-icon-action-button ---------------------------------------------------------
// The "ignores" table is the load-bearing half: a button that already has an icon, a
// label that is a whole phrase, and a primary form action must all stay untouched, or
// the rule would flag correct markup on every screen that has a form.

matrix("fe-icon-action-button", true, [
    { name: "bare Copy button in JSX", file: "src/Row.tsx", code: "<button onClick={copy}>Copy</button>" },
    { name: "bare Remove button", file: "src/Member.tsx", code: "<button className=\"danger\" onClick={onRemove}>Remove</button>" },
    { name: "capitalized Button component", file: "src/Row.tsx", code: "<Button variant=\"ghost\" onClick={onEdit}>Edit</Button>" },
    { name: "table row Delete in plain HTML", file: "assets/review.html", code: "<td><button class=\"btn-delete\" onclick=\"deleteRow(1)\">Delete</button></td>" },
    { name: "string-concatenated row action", file: "assets/index.html", code: "const html = '<button type=\"button\" data-name=\"' + esc(s.name) + '\" data-action=\"remove\">Remove</button>';" },
    { name: "Rename in a profile row", file: "assets/index.html", code: "'<button type=\"button\" class=\"toggle\" data-prof-act=\"rename\">Rename</button>'" },
    { name: "Refresh with surrounding whitespace", file: "src/Panel.vue", code: "<button class=\"ghost\"> Refresh </button>" },
    { name: "Download action", file: "src/Export.svelte", code: "<button on:click={save}>Download</button>" },
]);

matrix("fe-icon-action-button", false, [
    { name: "already an icon button with an accessible name", file: "src/Row.tsx", code: "<button title=\"Copy\" aria-label=\"Copy token\"><CopyIcon aria-hidden=\"true\" /></button>" },
    { name: "inline svg inside the button", file: "assets/index.html", code: "<button type=\"button\" class=\"iconbtn\" title=\"Refresh\" aria-label=\"Refresh\"><svg viewBox=\"0 0 24 24\"><path d=\"M23 4v6h-6\"/></svg></button>" },
    { name: "icon beside the label is not the defect", file: "src/Row.tsx", code: "<button onClick={copy}><CopyIcon aria-hidden=\"true\" />Copy</button>" },
    { name: "multi-word label names what it acts on", file: "src/Danger.tsx", code: "<button onClick={destroy}>Delete project</button>" },
    { name: "primary form action keeps its text", file: "src/Form.tsx", code: "<button type=\"submit\">Save</button>" },
    { name: "cancel is not an iconified action", file: "src/Form.tsx", code: "<button onClick={close}>Cancel</button>" },
    { name: "the verb as a heading, not a button", file: "src/Row.tsx", code: "<span className=\"label\">Copy</span>" },
    { name: "the verb in an option, not a button", file: "src/Menu.tsx", code: "<option value=\"copy\">Copy</option>" },
    { name: "deliberate text label marked on the line", file: "src/Dialog.tsx", code: "<button className=\"destructive\" onClick={destroy}>Delete</button> // enigma: confirmation dialog reads as text" },
    { name: "file-wide opt-out", file: "src/Dialog.tsx", code: "// enigma:allow-text-actions\n<button onClick={destroy}>Delete</button>" },
    { name: "test fixture is excluded", file: "src/__tests__/Row.test.tsx", code: "<button>Copy</button>" },
    { name: "build output is excluded", file: "apps/dist/main.js", code: "h('<button class=\"x\">Remove</button>')" },
]);

// --- auth-password-reset-entry ------------------------------------------------------

matrix("auth-password-reset-entry", true, [
    { name: "sign-in form with no way to recover the password", file: "src/app/oauth/login/page.tsx", code: "<form onSubmit={onSubmit}>\n  <Input autoComplete=\"username\" />\n  <Input type=\"password\" autoComplete=\"current-password\" />\n  <Button type=\"submit\">Sign in</Button>\n</form>" },
    { name: "named login form component", file: "src/components/login-form.tsx", code: "<input type=\"password\" name=\"password\" />" },
    { name: "App Router sign-in segment", file: "app/(auth)/sign-in/page.tsx", code: "<input type=\"password\" />" },
    { name: "root-level login segment", file: "login/page.jsx", code: "<input type=\"password\" />" },
    { name: "Vue sign-in view", file: "src/views/login/Index.vue", code: "<input type=\"password\" v-model=\"credentials.password\" />" },
    { name: "JSX expression form of the type prop", file: "src/SignIn.tsx", code: "<Input type={\"password\"} value={pw} />" },
]);

matrix("auth-password-reset-entry", false, [
    { name: "the forgot-password link is right there", file: "src/app/login/page.tsx", code: "<input type=\"password\" />\n<a href=\"/forgot-password\">Forgot your password?</a>" },
    { name: "reset route spelled the other way", file: "src/views/login/Index.vue", code: "<input type=\"password\" />\n<router-link to=\"auth/reset/password\">{{ $t('LOGIN.FORGOT_PASSWORD') }}</router-link>" },
    { name: "Spanish copy", file: "src/pages/login.tsx", code: "<input type=\"password\" />\n<a href=\"/recuperar\">Olvide mi contrasena</a>" },
    { name: "passwordless magic-link form", file: "src/app/login/page.tsx", code: "<input type=\"password\" />\n// magic-link fallback offered below" },
    { name: "the page only composes the form", file: "src/app/login/page.tsx", code: "export default function Page() {\n  return <LoginForm />;\n}" },
    { name: "deliberate opt-out", file: "src/app/login/page.tsx", code: "// enigma:allow-no-reset internal tool, SSO only\n<input type=\"password\" />" },
    { name: "a password field outside any sign-in surface", file: "src/settings/profile.tsx", code: "<input type=\"password\" name=\"newPassword\" />" },
    { name: "storybook fixture is excluded", file: "src/app/login/page.stories.tsx", code: "<input type=\"password\" />" },
]);

// --- auth-signup-auto-login ---------------------------------------------------------

matrix("auth-signup-auto-login", true, [
    { name: "registration pushes the user to the login screen", file: "src/app/register/page.tsx", code: "await createAccount(values);\nrouter.push(\"/login\");" },
    { name: "signup redirect helper", file: "app/(auth)/signup/actions.ts", code: "await db.user.create({ data });\nredirect(\"/sign-in\");" },
    { name: "location assignment", file: "src/pages/sign-up.jsx", code: "await api.register(form);\nwindow.location.href = \"/signin?registered=1\";" },
    { name: "named route push", file: "src/views/signup/Index.vue", code: "await register(credentials);\nrouter.push({ name: \"login\" });" },
]);

matrix("auth-signup-auto-login", false, [
    { name: "signs the user in after registering", file: "src/app/register/page.tsx", code: "await createAccount(values);\nawait signIn(\"credentials\", { email, password });\nrouter.push(\"/app\");" },
    { name: "session established server-side", file: "app/signup/actions.ts", code: "const user = await db.user.create({ data });\nawait createSession(user.id);\nredirect(\"/dashboard\");" },
    { name: "the 'already have an account' link is not a redirect", file: "src/app/register/page.tsx", code: "<p>Already have an account? <a href=\"/login\">Sign in</a></p>" },
    { name: "verification step instead of the login form", file: "src/views/signup/Index.vue", code: "await register(credentials);\nrouter.push({ name: \"auth_verify_email\" });" },
    { name: "deliberate redirect", file: "src/app/register/page.tsx", code: "// enigma:allow-login-redirect admin creates the account, the user signs in themselves\nrouter.push(\"/login\");" },
    { name: "test file is excluded", file: "src/app/register/page.test.tsx", code: "router.push(\"/login\");" },
]);

// --- auth-rate-limit ----------------------------------------------------------------

matrix("auth-rate-limit", true, [
    { name: "App Router login handler with no limiter", file: "app/api/auth/login/route.ts", code: "export async function POST(request: Request) {\n  const { email, password } = await request.json();\n  return NextResponse.json(await verify(email, password));\n}" },
    { name: "express register route", file: "src/routes/register.ts", code: "router.post(\"/register\", async (req, res) => {\n  const user = await createUser(req.body);\n  res.json(user);\n});" },
    { name: "2FA verification endpoint", file: "app/api/auth/2fa/route.ts", code: "export const POST = async (req: Request) => verifyTotp(await req.json());" },
    { name: "OTP check in FastAPI", file: "api/otp.py", code: "@app.post(\"/otp/verify\")\nasync def verify(payload: OtpIn):\n    return check(payload.code)" },
    { name: "server action reachable from the sign-in page", file: "src/app/oauth/login/actions.ts", code: "\"use server\";\n\nexport async function resolveIdentifier(identifier: string) {\n  return prisma.user.findUnique({ where: { username: identifier } });\n}" },
]);

matrix("auth-rate-limit", false, [
    { name: "upstash ratelimit in the handler", file: "app/api/auth/login/route.ts", code: "const ratelimit = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, \"60 s\") });\nexport async function POST(request: Request) {\n  const { success } = await ratelimit.limit(ip);\n  if (!success) return new Response(null, { status: 429 });\n}" },
    { name: "express-rate-limit middleware on the route", file: "src/routes/login.ts", code: "import rateLimit from \"express-rate-limit\";\nrouter.post(\"/login\", rateLimit({ windowMs: 60000, max: 5 }), handler);" },
    { name: "server action that throttles the probe", file: "src/app/oauth/login/actions.ts", code: "\"use server\";\nimport { rateLimit } from \"@/lib/rate-limit-service\";\nexport async function resolveIdentifier(value: string) {\n  const throttle = await rateLimit(`hint:${value}`, 10, 600000);\n  if (!throttle.ok) return null;\n}" },
    { name: "failed-attempt accounting per account", file: "api/login.py", code: "@app.post(\"/login\")\nasync def login(body: LoginIn):\n    if attempts_remaining(body.email) <= 0:\n        raise HTTPException(429)" },
    { name: "a CLI that signs in against a remote API", file: "src/commands/login.ts", code: "const res = await fetch(`${apiUrl}/api/tokens`, { method: \"POST\", body });" },
    { name: "a local admin reset script", file: "apps/dokploy/reset-password.ts", code: "(async () => {\n  const owner = await findOwner();\n  await db.update(account).set({ password });\n})();" },
    { name: "the client component that posts to the endpoint", file: "src/app/login/page.tsx", code: "await fetch(\"/api/auth/login\", { method: \"POST\", body: JSON.stringify(values) });" },
    { name: "limit enforced upstream, noted in the file", file: "app/api/auth/login/route.ts", code: "// enigma:allow-unlimited-auth the gateway limits this route\nexport async function POST(request: Request) { return handle(request); }" },
    { name: "test file is excluded", file: "app/api/auth/login/route.test.ts", code: "export async function POST(request: Request) { return handle(request); }" },
]);

// --- file-name casing (ignoreFileCase) ----------------------------------------------

matrix("auth-password-reset-entry", true, [
    { name: "PascalCase component name", file: "src/components/LoginForm.tsx", code: "<input type=\"password\" />" },
    { name: "PascalCase sign-in file", file: "src/pages/SignIn.tsx", code: "<input type=\"password\" />" },
    { name: "capitalized directory segment", file: "src/views/Login/Index.vue", code: "<input type=\"password\" />" },
]);

test("case-insensitive matching is opt-in per rule, so an exact-name glob stays exact", () => {
    // ctx-memory-budget owns CLAUDE.md/AGENTS.md by their exact names: a lowercase claude.md is
    // somebody's ordinary doc, not the always-on memory file, and must not inherit its budget.
    const big = "x".repeat(41_000);
    expect(flagged("ctx-memory-budget", "CLAUDE.md", big)).toBe(true);
    expect(flagged("ctx-memory-budget", "docs/claude.md", big)).toBe(false);
});

// --- fe-mobile-drawer-full-width ----------------------------------------------------

matrix("fe-mobile-drawer-full-width", true, [
    // The two real defects the reference corpus produced, verbatim.
    { name: "520px drawer pinned to the edge", file: "dashboard/templates/dashboard.html", code: "<div class=\"fixed top-0 right-0 h-full w-[520px] bg-surface border-l border-border z-50 flex flex-col\">" },
    { name: "200px mobile sidebar", file: "src/components/sidebar/Sidebar.vue", code: "<aside class=\"flex flex-col fixed top-0 ltr:left-0 h-full z-40 w-[200px] md:w-auto\">" },
    { name: "Tailwind step width on an inset panel", file: "src/components/Drawer.tsx", code: "<div className=\"fixed inset-y-0 right-0 w-96 bg-white shadow-xl\">" },
    { name: "three-quarter sheet, the shadcn default", file: "src/components/ui/sheet.tsx", code: "<SheetPrimitive.Content className=\"fixed inset-y-0 right-0 h-full w-3/4 border-l\" />" },
    { name: "rem width", file: "src/Panel.svelte", code: "<div class=\"fixed inset-y-0 start-0 w-[20rem] bg-surface\">" },
    { name: "width declared before the panel classes", file: "src/Nav.tsx", code: "<nav className=\"w-80 fixed inset-y-0 left-0 bg-card\">" },
]);

matrix("fe-mobile-drawer-full-width", false, [
    { name: "full width with the desktop size at a breakpoint", file: "src/components/Drawer.tsx", code: "<div className=\"fixed inset-y-0 right-0 w-full md:w-96 bg-white\">" },
    { name: "capped by max-w-full", file: "src/EditContact.vue", code: "<div class=\"fixed inset-y-0 ltr:right-0 z-50 flex flex-col w-[30rem] max-w-full h-full bg-n-surface-2\">" },
    { name: "full width capped at a max on larger screens", file: "src/Drilldown.vue", code: "<aside class=\"fixed inset-y-0 end-0 flex w-full max-w-xl flex-col bg-n-solid-1\">" },
    { name: "hidden on phones, a drawer serves that size", file: "packages/ui/src/shell/app-shell.tsx", code: "<aside className=\"sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 self-start overflow-y-auto md:block\">" },
    { name: "hairline chart cursor", file: "packages/ui/src/components/charts.tsx", code: "<div className=\"absolute inset-y-0 w-px bg-foreground/25\" />" },
    { name: "resize handle", file: "src/components/sidebar/Sidebar.vue", code: "<div class=\"absolute top-0 h-full w-px ltr:right-0 bg-transparent group-hover:bg-n-brand\" />" },
    { name: "pseudo-element guide line", file: "src/components/sidebar/SidebarSubGroup.vue", code: "<div class=\"before:absolute before:top-0 before:bottom-0 before:w-0.5 before:bg-n-slate-4\" />" },
    { name: "a wide element that is not an off-canvas panel", file: "src/Card.tsx", code: "<section className=\"w-96 rounded-lg border p-4\">Settings</section>" },
    { name: "deliberate partial panel marked on the line", file: "src/Peek.tsx", code: "<div className=\"fixed inset-y-0 right-0 w-80\"> {/* enigma: the design keeps the page visible behind the peek */}" },
    { name: "file-wide opt-out", file: "src/Peek.tsx", code: "// enigma:allow-partial-drawer\n<div className=\"fixed inset-y-0 right-0 w-80\">" },
    { name: "build output is excluded", file: "apps/web/dist/index.html", code: "<div class=\"fixed inset-y-0 right-0 w-[520px]\">" },
]);

// --- fe-name-input-capitalize -------------------------------------------------------

matrix("fe-name-input-capitalize", true, [
    // The autofill tokens the HTML spec defines as a PERSON's name, in the shapes the corpus uses.
    { name: "full-name field via the autocomplete token", file: "src/components/account/identity-form.tsx", code: "<TextField label=\"Full name\" autoComplete=\"name\" value={draft.fullName} />" },
    { name: "given/family name pair", file: "src/app/account/profile/index.tsx", code: "<Input id=\"first\" autoComplete=\"given-name\" />\n<Input id=\"last\" autoComplete=\"family-name\" />" },
    { name: "sign-up name field", file: "app/(auth)/register/page.tsx", code: "<input autoComplete=\"name\" placeholder=\"Your name\" />" },
    { name: "field named for the person's first name", file: "src/views/profile/AccountView.tsx", code: "<Controller name='firstname' control={control} />" },
    { name: "snake_case last name", file: "src/forms/member.vue", code: "<input name=\"last_name\" type=\"text\" />" },
    { name: "surname in a plain form", file: "public/contact.html", code: "<input id=\"surname\" type=\"text\">" },
    { name: "Spanish apellidos", file: "src/pages/alta.tsx", code: "<input name=\"apellidos\" type=\"text\" />" },
]);

matrix("fe-name-input-capitalize", false, [
    // Already handled: the attribute anywhere in the file clears it (a shared Input sets it once).
    { name: "the attribute is present", file: "src/app/account/profile/index.tsx", code: "<Input autoComplete=\"given-name\" autoCapitalize=\"words\" />" },
    { name: "set once in the shared field component", file: "src/components/ui/text-field.tsx", code: "const capitalize = kind === \"name\" ? \"words\" : \"none\";\n<input autoComplete=\"name\" autocapitalize={capitalize} />" },
    // Entity names are NOT person names: title-casing a project, team, token or webhook is wrong.
    // Every corpus hit for these tokens was one of those, which is why they are excluded.
    { name: "a project's name field", file: "src/views/project/DialogEditView.tsx", code: "<Controller name='fullname' control={control} /> {/* label: Name */}" },
    { name: "a team name", file: "src/views/teams/DialogCreateView.tsx", code: "<TextField id={'fullname'} label={'Team Name'} />" },
    { name: "a generic entity name input", file: "src/views/developer/DialogCreateToken.tsx", code: "<TextField id='name' label='Token name' />" },
    { name: "a name prop forwarded to a non-input component", file: "src/components/MemberAvatar.tsx", code: "<MemberAvatar avatar={avatarUrl} name={name} />" },
    { name: "a username, which must keep its case", file: "src/components/LoginForm.tsx", code: "<input name=\"username\" autoComplete=\"username\" />" },
    { name: "deliberate opt-out", file: "src/forms/legal.tsx", code: "// enigma:allow-no-capitalize legal names are entered exactly as they appear on the document\n<input name=\"first_name\" />" },
    { name: "build output is excluded", file: "apps/web/dist/register.html", code: "<input autocomplete=\"name\">" },
]);

// --- fe-name-value-normalize --------------------------------------------------------

matrix("fe-name-value-normalize", true, [
    // The exact shape the user hit: the attribute is there, so fe-name-input-capitalize is
    // clear, and the value is still stored as it was typed on a physical keyboard.
    { name: "attribute present but nothing normalizes the value", file: "app/(auth)/register/page.tsx", code: "<input autoComplete=\"name\" autoCapitalize=\"words\" placeholder=\"Your name\" />" },
    { name: "given/family pair with no normalizer", file: "src/app/account/profile/index.tsx", code: "<Input autoComplete=\"given-name\" />\n<Input autoComplete=\"family-name\" />" },
    { name: "plain form field", file: "public/contact.html", code: "<input id=\"surname\" type=\"text\">" },
]);

matrix("fe-name-value-normalize", false, [
    { name: "shared normalizer called on blur", file: "src/components/account/identity-form.tsx", code: "<input autoComplete=\"name\" onBlur={(e) => setName(capitalizeWords(e.target.value))} />" },
    { name: "normalizer imported from the schema module", file: "src/forms/member.vue", code: "import { normalizeName } from \"@/lib/normalize\";\n<input name=\"last_name\" type=\"text\" />" },
    { name: "lodash startCase", file: "src/pages/alta.tsx", code: "<input name=\"apellidos\" onBlur={(e) => set(startCase(e.target.value))} />" },
    { name: "inline first-letter uppercase", file: "src/views/profile/AccountView.tsx", code: "const fix = (s) => s.charAt(0).toUpperCase() + s.slice(1);\n<Controller name='firstname' control={control} />" },
    { name: "deliberate opt-out", file: "src/forms/legal.tsx", code: "// enigma:allow-no-capitalize legal names are entered exactly as they appear on the document\n<input name=\"first_name\" />" },
    { name: "an entity name is not a person name", file: "src/views/developer/DialogCreateToken.tsx", code: "<TextField id='name' label='Token name' />" },
    { name: "build output is excluded", file: "apps/web/dist/register.html", code: "<input autocomplete=\"name\">" },
]);

// --- sec-password-breach-check ------------------------------------------------------

matrix("sec-password-breach-check", true, [
    { name: "sign-up password field", file: "app/(auth)/register/page.tsx", code: "<input type=\"password\" autoComplete=\"new-password\" value={pw} onChange={onChange} />" },
    { name: "reset confirmation screen", file: "src/pages/reset-password.tsx", code: "<Input type=\"password\" autoComplete=\"new-password\" />\n<Input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "plain change-password form", file: "public/account/password.html", code: "<input type=\"password\" autocomplete=\"new-password\">" },
]);

matrix("sec-password-breach-check", false, [
    // The sign-in form is the other autofill token, and a breach check there would be wrong:
    // the password already exists, and telling the user at login is not the moment to change it.
    { name: "sign-in form", file: "app/(auth)/login/page.tsx", code: "<input type=\"password\" autoComplete=\"current-password\" />" },
    { name: "the range API is called in the same file", file: "src/pages/signup.tsx", code: "const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);\n<input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "delegated to a shared hook", file: "src/pages/signup.tsx", code: "const { breached } = usePwnedPassword(pw);\n<input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "deliberate opt-out", file: "src/pages/kiosk-enroll.tsx", code: "// enigma:allow-no-breach-check offline kiosk, no outbound network\n<input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "build output is excluded", file: "apps/web/dist/signup.html", code: "<input type=\"password\" autocomplete=\"new-password\">" },
]);

// --- sec-password-identity-match ----------------------------------------------------

matrix("sec-password-identity-match", true, [
    { name: "sign-up form with only a length rule", file: "app/(auth)/register/page.tsx", code: "const schema = z.object({ email: z.email(), password: z.string().min(12) });\n<input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "reset confirmation screen", file: "src/pages/reset-password.tsx", code: "<Input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "plain change-password form", file: "public/account/password.html", code: "<input type=\"password\" autocomplete=\"new-password\">" },
    // The email being PRESENT in the file is the normal case, not evidence of a comparison -
    // this is why `absent` cannot key on the identifier names themselves.
    { name: "email field beside it but never compared", file: "src/pages/signup.tsx", code: "<input name=\"email\" type=\"email\" />\n<input type=\"password\" autoComplete=\"new-password\" />" },
]);

matrix("sec-password-identity-match", false, [
    { name: "sign-in form is the other autofill token", file: "app/(auth)/login/page.tsx", code: "<input type=\"password\" autoComplete=\"current-password\" />" },
    { name: "direct comparison against the email", file: "src/pages/signup.tsx", code: "if (pwd.toLowerCase() === email.toLowerCase()) return \"Password cannot be your email\";\n<input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "containment check the other way round", file: "src/pages/signup.tsx", code: "const bad = username && password.includes(username);\n<input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "zxcvbn fed the user's own inputs", file: "src/pages/signup.tsx", code: "const res = zxcvbn(pw, { userInputs: [email, name] });\n<input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "django-style similarity validator", file: "src/auth/password.ts", code: "validators: [UserAttributeSimilarityValidator]\n<input type=\"password\" autocomplete=\"new-password\">" },
    { name: "delegated to a named helper", file: "src/pages/signup.tsx", code: "const err = sameAsEmail(pw, form.email);\n<Input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "deliberate opt-out", file: "src/pages/device-enroll.tsx", code: "// enigma:allow-identity-password no account identity exists at enrolment\n<input type=\"password\" autoComplete=\"new-password\" />" },
    { name: "build output is excluded", file: "apps/web/dist/signup.html", code: "<input type=\"password\" autocomplete=\"new-password\">" },
]);

// --- fe-tracking-before-consent -----------------------------------------------------

matrix("fe-tracking-before-consent", true, [
    { name: "GA snippet pasted into the layout", file: "app/layout.tsx", code: "<Script src=\"https://www.googletagmanager.com/gtag/js?id=G-XYZ\" />" },
    { name: "dataLayer push on load", file: "src/analytics.ts", code: "window.dataLayer = window.dataLayer || [];\ndataLayer.push({ event: \"page_view\" });" },
    { name: "meta pixel", file: "public/index.html", code: "<script>fbq('init', '123');</script>" },
    { name: "posthog init at module scope", file: "src/lib/posthog.ts", code: "posthog.init(KEY, { api_host: HOST });" },
    { name: "hotjar loader", file: "src/app/head.astro", code: "<script src=\"https://static.hotjar.com/c/hotjar-1.js\"></script>" },
]);

matrix("fe-tracking-before-consent", false, [
    { name: "loaded behind the stored decision", file: "src/lib/analytics.ts", code: "if (consent.analytics) posthog.init(KEY);" },
    { name: "consent mode denied by default", file: "app/layout.tsx", code: "gtag('consent', 'default', { analytics_storage: 'denied' });\n<Script src=\"https://www.googletagmanager.com/gtag/js?id=G-XYZ\" />" },
    { name: "the banner component itself", file: "src/components/CookieBanner.tsx", code: "export function CookieBanner() { return <button onClick={acceptAll}>Accept</button>; }" },
    { name: "deliberate opt-out", file: "src/lib/replay.ts", code: "// enigma:allow-no-consent this module is mounted by the gate itself\nload(\"https://www.clarity.ms/tag/abc\");" },
    { name: "build output is excluded", file: "apps/web/dist/index.html", code: "<script src=\"https://www.googletagmanager.com/gtag/js\"></script>" },
]);

// --- val-email-normalize ------------------------------------------------------------

matrix("val-email-normalize", true, [
    { name: "zod 4 email schema", file: "src/lib/schemas.ts", code: "const EmailSchema = z.email();" },
    { name: "zod 3 chained email", file: "src/contracts/api/common.ts", code: "export const EmailSchema = z.string().email();" },
    { name: "yup form schema", file: "src/views/teams/DialogInvitationView.tsx", code: "const schema = yup.object().shape({\n  email: yup.string().email().required()\n});" },
    { name: "request body schema on the server", file: "src/routes/reviews.schemas.ts", code: "export const reviewIn = z.object({\n  email: z.string().email(),\n  score: z.number()\n});" },
    { name: "valibot pipeline", file: "src/lib/validators.ts", code: "const Email = v.pipe(v.string(), v.email());" },
]);

matrix("val-email-normalize", false, [
    { name: "normalized inside the schema", file: "src/lib/schemas.ts", code: "export const email = z.string().trim().toLowerCase().pipe(z.email());" },
    { name: "yup lowercase transform", file: "src/forms/invite.tsx", code: "const schema = yup.object({ email: yup.string().trim().lowercase().email().required() });" },
    { name: "normalized by a helper before parsing", file: "src/server/auth.ts", code: "const address = normalizeEmail(raw);\nconst parsed = z.string().email().parse(address);" },
    { name: "deliberate opt-out", file: "src/legacy/import.ts", code: "// enigma:allow-raw-email the upstream export is case-sensitive\nconst schema = z.string().email();" },
    { name: "no email schema at all", file: "src/lib/schemas.ts", code: "export const name = z.string().min(1).max(120);" },
    { name: "a method call that is not a schema", file: "src/mailer.ts", code: "await user.email().catch(() => null);" },
    { name: "tests are excluded", file: "tests/schemas.test.ts", code: "expect(z.string().email().safeParse(\"a@b.com\").success).toBe(true);" },
    { name: "build output is excluded", file: "dist/schemas.js", code: "const EmailSchema = z.email();" },
]);

// --- db-sqlite-app-datastore --------------------------------------------------------

matrix("db-sqlite-app-datastore", true, [
    { name: "prisma datasource on sqlite", file: "prisma/schema.prisma", code: "datasource db {\n  provider = \"sqlite\"\n  url      = env(\"DATABASE_URL\")\n}" },
    { name: "root-level schema (basename glob)", file: "schema.prisma", code: "datasource db {\n  provider = \"sqlite\"\n  url      = \"file:./dev.db\"\n}" },
    { name: "single quotes and loose spacing", file: "packages/core/prisma/core.prisma", code: "datasource db {\n  provider='sqlite'\n}" },
]);

matrix("db-sqlite-app-datastore", false, [
    { name: "postgres datasource", file: "prisma/schema.prisma", code: "datasource db {\n  provider = \"postgresql\"\n  url      = env(\"DATABASE_URL\")\n}" },
    { name: "the generator's provider is not a datastore", file: "prisma/schema.prisma", code: "generator client {\n  provider = \"prisma-client-js\"\n}" },
    { name: "deliberate local-first store", file: "prisma/schema.prisma", code: "// enigma:allow-sqlite the desktop app ships its library as one file\ndatasource db {\n  provider = \"sqlite\"\n}" },
    { name: "a sqlite mention in a comment", file: "prisma/schema.prisma", code: "// migrated off provider = \"sqlite\" in v2\ndatasource db {\n  provider = \"postgresql\"\n}" },
    { name: "not a prisma schema", file: "src/db/config.ts", code: "export const config = { provider: \"sqlite\" };" },
]);
