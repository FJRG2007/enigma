/**
 * Precision matrix for the injection-class security rules and the overlay-portal rules: each
 * rule's true positives, and - the priority - the exact shapes that false-positived while the
 * rules were measured against the reference corpus (guardrails.md records the figures). Temp
 * HOME + isolated config set before import, like the other guardrails suites.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gr-injection-"));
process.env.USERPROFILE = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_GUARDRAILS_CONFIG = join(HOME, "guardrails.json");

const { BUILTIN_RULES, checkFile } = await import("../src/guardrails");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** Whether `ruleId` fired, checked at the rule's own stage (a diff rule is invisible at the edit stage). */
function flagged(ruleId: string, file: string, code: string): boolean {
    const stage = BUILTIN_RULES.find((r) => r.id === ruleId)?.stage ?? "edit";
    return checkFile(file, code, null, stage).some((f) => f.ruleId === ruleId);
}

function matrix(ruleId: string, expected: boolean, cases: Array<{ name: string; file: string; code: string; }>): void {
    for (const c of cases) {
        test(`${ruleId} ${expected ? "flags" : "ignores"}: ${c.name}`, () => {
            expect(flagged(ruleId, c.file, c.code)).toBe(expected);
        });
    }
}

test("every new rule blocks, names its policy skill, and sits at the stage its backlog allows", () => {
    const expected: Record<string, { stage: "edit" | "diff"; skill: string; }> = {
        "sec-sql-built-from-values": { stage: "diff", skill: "security-policy" },
        "sec-shell-built-from-values": { stage: "diff", skill: "security-policy" },
        "sec-dynamic-code-execution": { stage: "diff", skill: "security-policy" },
        "sec-tls-verification-off": { stage: "diff", skill: "security-policy" },
        "sec-cors-any-origin-credentials": { stage: "diff", skill: "security-policy" },
        // Zero findings over the corpus: a scaffolding guard, so the edit stage.
        "sec-unsafe-deserialization": { stage: "edit", skill: "security-policy" },
        "sec-markdown-html-unsanitized": { stage: "diff", skill: "security-policy" },
        "fe-overlay-portal-disabled": { stage: "diff", skill: "frontend-policy" },
        "fe-radix-overlay-no-portal": { stage: "diff", skill: "frontend-policy" },
    };
    for (const [id, want] of Object.entries(expected)) {
        const rule = BUILTIN_RULES.find((r) => r.id === id);
        expect(rule, id).toBeDefined();
        expect(rule!.severity, id).toBe("block");
        expect(rule!.stage ?? "edit", id).toBe(want.stage);
        expect(rule!.skill, id).toBe(want.skill);
        expect(rule!.message, id).toMatch(/enigma:allow-[a-z-]+/);
    }
});

test("a diff-stage injection rule never fires at the edit stage (the post-edit hook and the commit backstop)", () => {
    const code = "const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`);";
    expect(checkFile("src/users.ts", code, null, "edit").some((f) => f.ruleId === "sec-sql-built-from-values")).toBe(false);
    expect(checkFile("src/users.ts", code, null, "diff").some((f) => f.ruleId === "sec-sql-built-from-values")).toBe(true);
});

// --- sec-sql-built-from-values ---------------------------------------------------------

matrix("sec-sql-built-from-values", true, [
    { name: "pg template, value compared", file: "src/users.ts", code: "const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`);" },
    { name: "multi-line template", file: "src/users.ts", code: "const rows = await pool.query(`\n  SELECT id, name\n  FROM users\n  WHERE email = '${email}'\n`);" },
    { name: "Prisma $queryRawUnsafe with a template", file: "src/repo.ts", code: "await prisma.$queryRawUnsafe(`SELECT * FROM \"User\" WHERE name LIKE '%${q}%'`);" },
    { name: "Prisma $executeRawUnsafe, quoted value", file: "scripts/migrate.ts", code: "await db.$executeRawUnsafe(`UPDATE \"t\" SET \"id\" = '${newId}' WHERE \"id\" = '${row.id}'`);" },
    { name: "string concatenation", file: "src/users.js", code: "connection.query(\"SELECT * FROM users WHERE id = \" + req.params.id);" },
    { name: "IN list joined from values", file: "src/db.ts", code: "await sql.unsafe(`DELETE FROM docs WHERE _id IN (${ids.map((c) => `'${c}'`).join(', ')})`);" },
    { name: "better-sqlite3 prepare", file: "src/store.ts", code: "db.prepare(`DELETE FROM sessions WHERE token = '${token}'`).run();" },
    { name: "INSERT VALUES", file: "src/log.ts", code: "await client.query(`INSERT INTO logs (msg) VALUES (${msg})`);" },
    { name: "python f-string", file: "app/repo.py", code: "cursor.execute(f\"SELECT * FROM users WHERE id = {user_id}\")" },
    { name: "python triple-quoted f-string", file: "app/repo.py", code: "conn.execute(f\"\"\"\n    SELECT * FROM users\n    WHERE name = '{name}'\n\"\"\")" },
    { name: "python % operator", file: "app/repo.py", code: "cursor.execute(\"SELECT * FROM users WHERE id = %s\" % user_id)" },
    { name: "python .format()", file: "app/repo.py", code: "cursor.execute(\"DELETE FROM users WHERE id = {}\".format(user_id))" },
    { name: "sqlalchemy text() over an f-string", file: "app/repo.py", code: "session.execute(text(f\"UPDATE users SET name = '{name}' WHERE id = 1\"))" },
]);

matrix("sec-sql-built-from-values", false, [
    { name: "pg parameter", file: "src/users.ts", code: "const rows = await db.query(\"SELECT * FROM users WHERE id = $1\", [id]);" },
    { name: "Prisma tagged $queryRaw", file: "src/repo.ts", code: "await prisma.$queryRaw`SELECT * FROM \"User\" WHERE id = ${id}`;" },
    { name: "generated placeholder list", file: "src/db.ts", code: "db.prepare(`SELECT * FROM t WHERE id IN (${ids.map(() => \"?\").join(\",\")})`).all(...ids);" },
    { name: "IN over a placeholder variable (measured FP: claude-mem)", file: "src/db.ts", code: "const marks = ids.map(() => \"?\").join(\",\");\ndb.prepare(`SELECT * FROM t WHERE id IN (${marks})`).all(...ids);" },
    { name: "identifier expression, not a value (measured FP: claude-mem)", file: "src/stats.ts", code: "db.query(`SELECT MIN(${ms}) AS epoch FROM sdk_sessions WHERE ${ms} >= ?1`).get(since);" },
    { name: "placeholder builder call (measured FP: platform storage)", file: "src/storage.ts", code: "await client.execute(`UPDATE ${table} SET data = $1 WHERE \"workspaceId\" = ${params.add(ws, '::uuid')}`, params.getValues());" },
    { name: "name bound to a placeholder builder", file: "src/storage.ts", code: "const wsId = params.add(this.workspaceId, '::uuid');\nawait client.execute(`DELETE FROM docs WHERE \"workspaceId\" = ${wsId}`, params.getValues());" },
    { name: "clause after a CLOSING quote (measured FP: orca)", file: "src/routing.ts", code: "db.prepare(`SELECT id FROM messages WHERE contract = 'current'${throughClause} ORDER BY seq`).all(...params);" },
    { name: "DDL names identifiers", file: "src/schema.ts", code: "db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);" },
    { name: "PRAGMA", file: "app/db.py", code: "conn.execute(f\"PRAGMA table_info({table})\")" },
    { name: "a SCREAMING_CASE constant", file: "src/db.ts", code: "db.query(`SELECT * FROM jobs WHERE state = ${STATE_DONE}`);" },
    { name: "python parameters", file: "app/repo.py", code: "cursor.execute(\"SELECT * FROM users WHERE id = %s\", (user_id,))" },
    { name: "a non-SQL tool.execute with a template (measured FP: openclaw)", file: "src/agent.ts", code: "await tool.execute(`read-${i}`, params, undefined, undefined);" },
    { name: "a minified bundle line", file: "plugin/scripts/bundle.cjs", code: `${"x".repeat(420)}this.db.prepare(\`SELECT * FROM t WHERE id = \${t}\`).get(e)` },
    { name: "test file", file: "src/users.test.ts", code: "await db.query(`SELECT * FROM users WHERE id = ${id}`);" },
    { name: "line escape hatch", file: "src/users.ts", code: "await db.query(`SELECT * FROM users WHERE id = ${id}`); // enigma:allow-sql-interpolation id is a validated integer" },
]);

// --- sec-shell-built-from-values -------------------------------------------------------

const CP = "import { exec, execSync, spawn, execFile } from \"node:child_process\";\n";

matrix("sec-shell-built-from-values", true, [
    { name: "execSync template", file: "src/git.ts", code: `${CP}const out = execSync(\`git show HEAD:\${file}\`);` },
    { name: "exec with a quoted value (quotes do not stop $(...))", file: "src/open.ts", code: `${CP}exec(\`open "\${url}"\`);` },
    { name: "concatenation", file: "src/launch.mjs", code: `${CP}execSync("launchctl load -w " + JSON.stringify(plistPath));` },
    { name: "spawn with shell: true", file: "scripts/build.mjs", code: `${CP}const child = spawn(\`npm run build -w \${name}\`, { shell: true, stdio: "inherit" });` },
    { name: "promisified exec", file: "src/run.ts", code: "import { exec } from \"child_process\";\nimport { promisify } from \"util\";\nconst execAsync = promisify(exec);\nawait execAsync(`git tag v${version}`);" },
    { name: "namespace import", file: "src/bump.js", code: "const child_process = require(\"child_process\");\nchild_process.exec(`npm version ${versionStr}`);" },
    { name: "python shell=True over an f-string", file: "tools/hunt.py", code: "import subprocess\nproc = subprocess.Popen(\n    f'bash \"{script}\" \"{domain}\"',\n    shell=True, cwd=BASE_DIR\n)" },
    { name: "python os.system f-string", file: "tools/x.py", code: "import os\nos.system(f\"rm -rf {path}\")" },
    { name: "python getoutput concatenation", file: "tools/x.py", code: "import subprocess\nsubprocess.getoutput(\"ls \" + folder)" },
]);

matrix("sec-shell-built-from-values", false, [
    { name: "execFile with an argument array", file: "src/git.ts", code: `${CP}execFile("git", ["show", \`HEAD:\${file}\`]);` },
    { name: "spawn without a shell", file: "src/run.ts", code: `${CP}spawn(\`\${bin}\`, [\`--port=\${port}\`]);` },
    { name: "a literal command", file: "src/git.ts", code: `${CP}execSync("git rev-parse HEAD");` },
    { name: "literal + literal split for width (measured FP: OmniRoute)", file: "scripts/check.mjs", code: `${CP}const out = execSync(\n  "grep -rhoE 'process\\\\.env' " +\n    "src/ bin/ 2>/dev/null || true",\n  { cwd });` },
    { name: "the program slot (measured FP: npm vs npm.cmd)", file: "bin/runtime.mjs", code: `${CP}execSync(\`\${npm} install --no-audit\`);` },
    { name: "a quoting function", file: "src/ssh.ts", code: `${CP}exec(\`docker save \${quoteArg(image)} | gzip -1\`);` },
    { name: "a sanitized value (measured FP: MCSManager)", file: "src/user.ts", code: `${CP}execSync(\`id -u \${sanitizedUsername}\`);` },
    { name: "db.exec is not child_process", file: "src/db.ts", code: `${CP}this.db.exec(\`DROP TABLE IF EXISTS \${TABLE}\`);` },
    { name: "an ssh client's exec (no child_process import)", file: "src/deploy.ts", code: "client.exec(`docker load < ${tar}`, cb);" },
    { name: "python argument list", file: "tools/x.py", code: "import subprocess\nsubprocess.run([\"git\", \"log\", ref])" },
    { name: "python shell=True over a literal", file: "tools/x.py", code: "import subprocess\nsubprocess.run(\"npm ci\", shell=True)" },
    { name: "python shlex.quote", file: "tools/x.py", code: "import os, shlex\nos.system(f\"rm -rf {shlex.quote(path)}\")" },
    { name: "a test file", file: "src/git.test.ts", code: `${CP}execSync(\`git show \${ref}\`);` },
    { name: "line escape hatch", file: "src/git.ts", code: `${CP}execSync(\`ps -p \${pid}\`); // enigma:allow-shell-interpolation pid is a number` },
]);

// --- sec-dynamic-code-execution --------------------------------------------------------

matrix("sec-dynamic-code-execution", true, [
    { name: "eval of a concatenation", file: "src/run.ts", code: "const fn = eval(\"(\" + fnBody + \")\");" },
    { name: "eval of a variable", file: "src/cfg.js", code: "const config = eval(text);" },
    { name: "new Function over a template", file: "scripts/bench.mjs", code: "const v = Number(new Function(`return (${match[1]})`)());" },
    { name: "python eval of data", file: "data/load.py", code: "prompts = eval(prompts)" },
    { name: "python exec of a file", file: "scripts/load.py", code: "exec(open(path).read())" },
]);

matrix("sec-dynamic-code-execution", false, [
    { name: "eval of a literal", file: "src/x.js", code: "eval(\"1 + 1\");" },
    { name: "new Function over literals", file: "src/x.js", code: "const add = new Function(\"a\", \"b\", \"return a + b\");" },
    { name: "redis.eval method", file: "src/quota.ts", code: "await redis.eval(script, 1, key);" },
    { name: "a method signature (measured FP: OmniRoute)", file: "src/quota.ts", code: "interface Store {\n  eval(script: string, numkeys: number, ...args: unknown[]): Promise<unknown>;\n}" },
    { name: "prose in a string (measured FP: OmniRoute)", file: "src/tools.ts", code: "const d = \"Scan content for blocked patterns including eval(base64), \" + more;" },
    { name: "prose in a string after a colon (measured FP: hermes)", file: "cli/tips.py", code: "TIPS = [\n    \"Quick commands support two types: exec (run shell command directly) and alias.\",\n]" },
    { name: "a docstring line (measured FP: headroom)", file: "learn/analyzer.py", code: "\"\"\"\n    codex-cli  -> codex exec (wall-clock timeout)\n\"\"\"" },
    { name: "python def exec", file: "sandbox/runtime.py", code: "async def exec(self, runtime, request):\n    pass" },
    { name: "python literal_eval", file: "app/parse.py", code: "value = ast.literal_eval(raw)" },
    { name: "a test file", file: "src/scanner.test.ts", code: "const result = eval(code);" },
    { name: "line escape hatch", file: "src/cfg.js", code: "const config = eval(text); // enigma:allow-dynamic-code build-time constant" },
]);

// --- sec-tls-verification-off ----------------------------------------------------------

matrix("sec-tls-verification-off", true, [
    { name: "rejectUnauthorized: false", file: "src/db.ts", code: "const pool = new Pool({ ssl: { rejectUnauthorized: false } });" },
    { name: "NODE_TLS_REJECT_UNAUTHORIZED", file: "src/boot.ts", code: "process.env.NODE_TLS_REJECT_UNAUTHORIZED = \"0\";" },
    { name: "requests verify=False", file: "app/client.py", code: "import requests\nr = requests.get(url, verify=False)" },
    { name: "python CERT_NONE", file: "app/ssl_ctx.py", code: "import ssl\nctx = ssl.create_default_context()\nctx.check_hostname = False\nctx.verify_mode = ssl.CERT_NONE" },
    { name: "python unverified context", file: "app/ssl_ctx.py", code: "import ssl\nctx = ssl._create_unverified_context()" },
]);

matrix("sec-tls-verification-off", false, [
    { name: "a loopback peer", file: "src/mail.ts", code: "...(isLoopback(host) ? { tls: { rejectUnauthorized: false } } : {})" },
    { name: "a snippet shown to the user (measured FP: OmniRoute)", file: "src/Snippet.tsx", code: "const node = `process.env.NODE_TLS_REJECT_UNAUTHORIZED = \"0\";`;" },
    { name: "an operator toggle (measured FP: fluxer)", file: "src/es.ts", code: "tls: config.tlsRejectUnauthorized === false ? { rejectUnauthorized: false } : undefined," },
    { name: "a python parameter named verify", file: "app/plan.py", code: "import requests\ndef commit(self, plan_id, *, verify=False):\n    pass" },
    { name: "verify=False in a file with no HTTP client", file: "app/plan.py", code: "import ssl\nplan.commit(verify=False)" },
    { name: "rejectUnauthorized: true", file: "src/db.ts", code: "const pool = new Pool({ ssl: { rejectUnauthorized: true, ca } });" },
    { name: "a test file", file: "test/tls.test.js", code: "tls.connect({ rejectUnauthorized: false });" },
    { name: "line escape hatch", file: "src/probe.ts", code: "const s = tlsConnect({ host, rejectUnauthorized: false }); // enigma:allow-insecure-tls reads the cert to report it" },
]);

test("sec-tls-verification-off reports one python opt-out once, not once per line", () => {
    const code = "import ssl\nctx = ssl.create_default_context()\nctx.check_hostname = False\nctx.verify_mode = ssl.CERT_NONE";
    expect(checkFile("app/ssl_ctx.py", code, null, "diff").filter((f) => f.ruleId === "sec-tls-verification-off").length).toBe(1);
});

// --- sec-cors-any-origin-credentials ---------------------------------------------------

matrix("sec-cors-any-origin-credentials", true, [
    { name: "socket.io wildcard with credentials", file: "src/ws.ts", code: "const io = new Server(http, {\n  cors: { origin: \"*\" },\n  credentials: true,\n});" },
    { name: "cors origin: true with credentials", file: "src/app.ts", code: "app.use(cors({ origin: true, credentials: true }));" },
    { name: "echoed Origin header", file: "src/server.js", code: "res.setHeader(\"Access-Control-Allow-Origin\", req.headers.origin);\nres.setHeader(\"Access-Control-Allow-Credentials\", \"true\");" },
    { name: "Starlette wildcard with credentials", file: "app/main.py", code: "app.add_middleware(\n    CORSMiddleware,\n    allow_origins=[\"*\"],\n    allow_credentials=True,\n)" },
    { name: "Flask-CORS credentials with default origins", file: "app/main.py", code: "CORS(app, supports_credentials=True)" },
]);

matrix("sec-cors-any-origin-credentials", false, [
    { name: "public wildcard, no credentials", file: "src/app.ts", code: "app.use(cors({ origin: \"*\" }));" },
    { name: "allowlist with credentials", file: "src/app.ts", code: "app.use(cors({ origin: [\"https://app.example.test\"], credentials: true }));" },
    { name: "a middleware leaving the pairing to its caller (measured FP: fluxer)", file: "src/cors.ts", code: "if (origins === '*') {\n  c.header('Access-Control-Allow-Origin', '*');\n}\nif (credentials) {\n  c.header('Access-Control-Allow-Credentials', 'true');\n}" },
    { name: "Starlette allowlist", file: "app/main.py", code: "app.add_middleware(CORSMiddleware, allow_origins=[\"https://app.example.test\"], allow_credentials=True)" },
    { name: "Flask-CORS with origins", file: "app/main.py", code: "CORS(app, origins=[\"https://app.example.test\"], supports_credentials=True)" },
    { name: "line escape hatch", file: "src/app.ts", code: "app.use(cors({ origin: true, credentials: true })); // enigma:allow-open-cors gateway enforces the allowlist" },
]);

// --- sec-unsafe-deserialization --------------------------------------------------------

matrix("sec-unsafe-deserialization", true, [
    { name: "yaml.load with no Loader", file: "app/config.py", code: "import yaml\ncfg = yaml.load(stream)" },
    { name: "yaml.load with the full unsafe Loader", file: "app/config.py", code: "import yaml\ncfg = yaml.load(stream, Loader=yaml.Loader)" },
    { name: "yaml.unsafe_load", file: "app/config.py", code: "import yaml\ncfg = yaml.unsafe_load(stream)" },
    { name: "pickle of a request body", file: "app/api.py", code: "import pickle\nobj = pickle.loads(request.body)" },
    { name: "pickle of base64 input", file: "app/api.py", code: "import pickle, base64\nobj = pickle.loads(base64.b64decode(token))" },
]);

matrix("sec-unsafe-deserialization", false, [
    { name: "yaml.safe_load", file: "app/config.py", code: "import yaml\ncfg = yaml.safe_load(stream)" },
    { name: "yaml.load with SafeLoader", file: "app/config.py", code: "import yaml\ncfg = yaml.load(stream, Loader=yaml.SafeLoader)" },
    { name: "ruamel's round-trip loader (measured FP: frigate)", file: "app/config.py", code: "from ruamel.yaml import YAML\nyaml = YAML()\ndata = yaml.load(f)" },
    { name: "a variable Loader", file: "agent/skill_utils.py", code: "import yaml\nreturn yaml.load(value, Loader=loader)" },
    { name: "pickle of a local file (measured: GRAM-T)", file: "data/iter.py", code: "import pickle\narr = pickle.load(p)" },
    { name: "line escape hatch", file: "app/cache.py", code: "import pickle\nobj = pickle.loads(redis.get(k))  # enigma:allow-unsafe-deserialization written by this service only" },
]);

// --- sec-markdown-html-unsanitized -----------------------------------------------------

matrix("sec-markdown-html-unsanitized", true, [
    { name: "marked into dangerouslySetInnerHTML", file: "src/Doc.jsx", code: "import { marked } from \"marked\";\nexport const Doc = ({ src }) => <div dangerouslySetInnerHTML={{ __html: marked.parse(src) }} />;" },
    { name: "markdown-it with html on, into v-html", file: "src/Doc.vue", code: "import MarkdownIt from \"markdown-it\";\nconst md = new MarkdownIt({ html: true });\n<div v-html=\"md.render(src)\"></div>" },
]);

matrix("sec-markdown-html-unsanitized", false, [
    { name: "marked through DOMPurify", file: "src/Doc.jsx", code: "import { marked } from \"marked\";\nimport DOMPurify from \"dompurify\";\n<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(src)) }} />" },
    { name: "markdown-it with its default (HTML escaped)", file: "src/Doc.tsx", code: "import MarkdownIt from \"markdown-it\";\nconst md = new MarkdownIt();\n<div dangerouslySetInnerHTML={{ __html: md.render(src) }} />" },
    { name: "a highlighter's escaped output, no Markdown renderer", file: "src/Code.tsx", code: "<code className=\"hljs\" dangerouslySetInnerHTML={{ __html: hljs.highlight(code, { language }).value }} />" },
    { name: "line escape hatch", file: "src/Doc.jsx", code: "import { marked } from \"marked\";\n<div dangerouslySetInnerHTML={{ __html: marked.parse(README) }} /> {/* enigma:allow-raw-html build-time README */}" },
]);

// --- fe-overlay-portal-disabled --------------------------------------------------------

matrix("fe-overlay-portal-disabled", true, [
    { name: "bare JSX attribute on its own line (measured: frigate)", file: "src/CloneDialog.tsx", code: "<PopoverContent\n  align=\"start\"\n  disablePortal\n  className=\"p-0\"\n>" },
    { name: "bare attribute before the tag closes", file: "src/TimePicker.tsx", code: "<PopoverContent className=\"w-auto p-0\" align=\"start\" disablePortal>" },
    { name: "={true}", file: "src/Field.tsx", code: "<Autocomplete options={opts} disablePortal={true} renderInput={renderInput} />" },
    { name: "MUI MenuProps", file: "src/Pick.tsx", code: "<Select value={v} MenuProps={{ disablePortal: true }} onChange={onChange}>" },
    { name: "MUI slotProps popper", file: "src/Pick.tsx", code: "<Autocomplete slotProps={{ popper: { disablePortal: true } }} options={opts} />" },
]);

matrix("fe-overlay-portal-disabled", false, [
    { name: "a prop declaration (measured FP: frigate/VoxelDash wrappers)", file: "src/popover.tsx", code: "type Props = {\n  disablePortal?: boolean;\n};" },
    { name: "a default", file: "src/popover.tsx", code: "function PopoverContent({ disablePortal = false, ...props }: Props) {" },
    { name: "a pass-through", file: "src/popover.tsx", code: "<Inner disablePortal={disablePortal} {...props} />" },
    { name: "a branch on the prop", file: "src/popover.tsx", code: "if (disablePortal) {\n  return content;\n}" },
    { name: "set to false", file: "src/Pick.tsx", code: "<Autocomplete disablePortal={false} options={opts} />" },
    { name: "line escape hatch", file: "src/Pick.tsx", code: "<Popper disablePortal open={open}> {/* enigma:allow-inline-overlay scrolls with the table */}" },
]);

// --- fe-radix-overlay-no-portal --------------------------------------------------------

const TOOLTIP_NO_PORTAL = [
    "import * as TooltipPrimitive from \"@radix-ui/react-tooltip\";",
    "const TooltipContent = React.forwardRef((props, ref) => (",
    "  <TooltipPrimitive.Content ref={ref} sideOffset={4} {...props} />",
    "));",
].join("\n");

matrix("fe-radix-overlay-no-portal", true, [
    { name: "shadcn tooltip without Portal (measured: frigate, txAdmin, openship)", file: "src/components/ui/tooltip.tsx", code: TOOLTIP_NO_PORTAL },
    { name: "the radix-ui umbrella package", file: "src/components/ui/popover.tsx", code: "import { Popover as PopoverPrimitive } from \"radix-ui\";\nexport const Content = (p) => <PopoverPrimitive.Content {...p} />;" },
]);

matrix("fe-radix-overlay-no-portal", false, [
    { name: "Content inside its Portal", file: "src/components/ui/tooltip.tsx", code: TOOLTIP_NO_PORTAL.replace("  <TooltipPrimitive.Content ref={ref} sideOffset={4} {...props} />", "  <TooltipPrimitive.Portal>\n    <TooltipPrimitive.Content ref={ref} {...props} />\n  </TooltipPrimitive.Portal>") },
    { name: "a primitive with no floating panel", file: "src/components/ui/tabs.tsx", code: "import * as TabsPrimitive from \"@radix-ui/react-tabs\";\n<TabsPrimitive.Content value=\"a\" />" },
    { name: "a wrapper that only uses the shadcn component", file: "src/Row.tsx", code: "import { TooltipContent } from \"@/components/ui/tooltip\";\n<TooltipContent>Copy</TooltipContent>" },
    { name: "line escape hatch", file: "src/components/ui/tooltip.tsx", code: TOOLTIP_NO_PORTAL.replace("{...props} />", "{...props} /> {/* enigma:allow-inline-overlay */}") },
]);
