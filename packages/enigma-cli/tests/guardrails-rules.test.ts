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

const { checkFile } = await import("../src/guardrails");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Whether `ruleId` fired on the given file/content. */
function flagged(ruleId: string, file: string, code: string): boolean {
    return checkFile(file, code, null).some((f) => f.ruleId === ruleId);
}

/** Run a table of {name, file, code} against `ruleId`, asserting the expected flag outcome. */
function matrix(ruleId: string, expected: boolean, cases: Array<{ name: string; file: string; code: string }>): void {
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
