/**
 * Precision matrix for the audit-class rules: the vulnerable shapes a security audit found in
 * agent-written code (the positives are those shapes, cut down), and - the priority - the shapes
 * that false-positived while the rules were measured against the corpus (guardrails.md records
 * the figures). Temp HOME + isolated config set before import, like the other guardrails suites.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gr-audit-"));
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

test("every audit rule blocks, names security-policy, carries a line escape hatch, and sits at the stage its backlog allows", () => {
    const expected: Record<string, "edit" | "diff"> = {
        "sec-ssh-host-key-unverified": "diff",
        "sec-secret-compare-timing": "diff",
        "sec-redirect-prefix-check": "diff",
        // Zero findings over the corpus: scaffolding guards, so the edit stage.
        "sec-open-redirect-from-input": "edit",
        "sec-ssrf-fetch-from-input": "edit",
        "sec-ssrf-dns-recheck": "diff",
        "sec-untrusted-file-inline": "diff",
        "sec-path-join-from-input": "diff",
    };
    for (const [id, stage] of Object.entries(expected)) {
        const rule = BUILTIN_RULES.find((r) => r.id === id);
        expect(rule, id).toBeDefined();
        expect(rule!.severity, id).toBe("block");
        expect(rule!.stage ?? "edit", id).toBe(stage);
        expect(rule!.skill, id).toBe("security-policy");
        expect(rule!.message, id).toMatch(/enigma:allow-[a-z-]+/);
    }
});

test("the rules that name a vetted utility point at the package and the add command", () => {
    for (const id of ["sec-ssrf-fetch-from-input", "sec-ssrf-dns-recheck"]) {
        expect(BUILTIN_RULES.find((r) => r.id === id)!.message).toContain("enigma add safe-fetch");
    }
    for (const id of ["sec-untrusted-file-inline", "sec-path-join-from-input"]) {
        expect(BUILTIN_RULES.find((r) => r.id === id)!.message).toContain("enigma add safe-upload");
    }
});

// --- sec-ssh-host-key-unverified -------------------------------------------------------

matrix("sec-ssh-host-key-unverified", true, [
    { name: "asyncssh known_hosts=None (VULN-0002)", file: "custom_components/unas/ssh_manager.py", code: "conn = await asyncssh.connect(\n    host,\n    password=pw,\n    known_hosts=None,\n)" },
    { name: "paramiko AutoAddPolicy", file: "lino/main.py", code: "client.set_missing_host_key_policy(paramiko.AutoAddPolicy())" },
    { name: "ssh2 hostVerifier returning true", file: "src/ssh.ts", code: "conn.connect({ host, username, password, hostVerifier: () => true });" },
    { name: "OpenSSH flag in a spawned command", file: "src/lib/compose.ts", code: "const args = [\"-o\", \"StrictHostKeyChecking=no\", host];" },
    { name: "OpenSSH flag in a CI workflow", file: ".github/workflows/deploy.yml", code: "      - run: ssh -o StrictHostKeyChecking=no deploy@$HOST ./release.sh" },
    { name: "known_hosts thrown away", file: "scripts/deploy.sh", code: "ssh -o UserKnownHostsFile=/dev/null deploy@host" },
    { name: "Go InsecureIgnoreHostKey", file: "cmd/agent/ssh.go", code: "cfg := &ssh.ClientConfig{HostKeyCallback: ssh.InsecureIgnoreHostKey()}" },
]);

matrix("sec-ssh-host-key-unverified", false, [
    { name: "asyncssh variable filled in when a key is pinned (the fixed VULN-0002)", file: "custom_components/unas/ssh_manager.py", code: "known_hosts = None\nif pinned_host_key:\n    known_hosts = ([asyncssh.import_public_key(pinned_host_key)], [], [])" },
    { name: "trust on first use", file: "scripts/deploy.sh", code: "ssh -o StrictHostKeyChecking=accept-new deploy@host" },
    { name: "a placeholder showing the flag (measured FP: openship)", file: "src/components/server-form.tsx", code: "<input value={extraArgs} placeholder=\"-o StrictHostKeyChecking=no\" />" },
    { name: "paramiko RejectPolicy", file: "app/ssh.py", code: "client.set_missing_host_key_policy(paramiko.RejectPolicy())" },
    { name: "marked with the escape hatch", file: "scripts/local.sh", code: "ssh -o StrictHostKeyChecking=no root@localhost # enigma:allow-unverified-host-key" },
]);

// --- sec-secret-compare-timing ---------------------------------------------------------

matrix("sec-secret-compare-timing", true, [
    { name: "Authorization header against a Bearer template (VULN-0034)", file: "services/bridge/src/server.ts", code: "if (req.headers.authorization !== `Bearer ${authToken}`) return res.status(401).end();" },
    { name: "presented header against the expected key, both bound first (VULN-0035)", file: "app/api/inbox/ingest/route.ts", code: "const expected = await expectedIngestKey();\nconst presented = request.headers.get(\"x-internal-key\");\nif (!expected || presented !== expected) return unauthorized();" },
    { name: "env secret against a header", file: "src/index.ts", code: "if (process.env.API_KEY !== authHeader) return new Response(null, { status: 401 });" },
    { name: "configured token against a token", file: "src/main.ts", code: "if (token !== config.AuthToken) throw new Error(\"no\");" },
    { name: "python header against settings", file: "api/auth.py", code: "if request.headers.get(\"x-proxy-secret\", \"\") != proxy_config.auth_secret:\n    raise Forbidden()" },
    { name: "computed HMAC against a signature", file: "src/webhook.ts", code: "const expected = createHmac(\"sha256\", secret).update(body).digest(\"hex\");\nif (expected !== signature) return bad();" },
]);

matrix("sec-secret-compare-timing", false, [
    { name: "timingSafeEqual", file: "src/auth.ts", code: "if (!timingSafeEqual(digest(presented), digest(expected))) return deny();" },
    { name: "a token used as a generation counter (measured FP class)", file: "src/runner.ts", code: "if (token !== this.runToken) return;" },
    { name: "an i18n key template (measured FP: OmniRoute)", file: "src/Card.tsx", code: "const missing = translated === `translator.${key}`;" },
    { name: "a cached copy (measured FP)", file: "src/client.ts", code: "if (cached.config.appSecret === appSecret) return cached.client;" },
    { name: "a configured secret against its weak default (measured FP)", file: "config/env.ts", code: "if (env.BETTER_AUTH_SECRET === DEFAULT_BETTER_AUTH_SECRET) warn();" },
    { name: "an id, not the key (measured FP)", file: "src/obsidian.ts", code: "if (memory.apiKeyId !== config.apiKeyId) continue;" },
    { name: "a content hash, not a MAC (measured FP)", file: "src/bundle.ts", code: "if (hash.digest(\"hex\") !== expected.sha256) throw new Error(\"corrupt\");" },
    { name: "Math.sign (measured FP)", file: "src/rate.ts", code: "if (Math.sign(fm) === Math.sign(fa)) break;" },
    { name: "comparison against a literal", file: "src/auth.ts", code: "if (token === undefined || apiKey === \"\") return;" },
]);

// --- sec-redirect-prefix-check ---------------------------------------------------------

matrix("sec-redirect-prefix-check", true, [
    { name: "post-login target (VULN-0024)", file: "app/oauth/login/post-login-target.ts", code: "export function postLoginTarget(target: string | null): string {\n    return target && target.startsWith(\"/\") && !target.startsWith(\"//\") ? target : \"/\";\n}" },
    { name: "a generic value inside a destination helper", file: "lib/connections/link-flow.ts", code: "function safeTarget(value: string | null): string | undefined {\n    if (!value || !value.startsWith(\"/\") || value.startsWith(\"//\")) return undefined;\n    return value;\n}" },
    { name: "next pushed to the router", file: "app/(auth)/sign-in/page.tsx", code: "router.push(next && next.startsWith(\"/\") ? next : \"/\");" },
    { name: "callbackUrl without even the // check", file: "app/login/sign-in-form.tsx", code: "router.replace(callbackUrl && callbackUrl.startsWith(\"/\") ? callbackUrl : \"/dash\");" },
]);

matrix("sec-redirect-prefix-check", false, [
    { name: "resolved against a placeholder origin (the fixed VULN-0024)", file: "lib/safe-redirect.ts", code: "export function safeRedirect(target: string | null): string {\n    if (!target || !target.startsWith(\"/\")) return \"/\";\n    const resolved = new URL(target, PLACEHOLDER_ORIGIN);\n    if (resolved.origin !== PLACEHOLDER_ORIGIN) return \"/\";\n    return resolved.pathname;\n}" },
    { name: "a filesystem path (measured FP: orca)", file: "src/main/git/worktree-listing.ts", code: "return pathValue.startsWith('/') && !pathValue.startsWith('//')" },
    { name: "a chat slash command (measured FP: element-web)", file: "src/editor/commands.tsx", code: "if (message.startsWith(\"/\") && !message.startsWith(\"//\")) runCommand(message);" },
    { name: "a request path in middleware (measured FP: MCSManager)", file: "src/app.ts", code: "if (!ctx.url.startsWith(\"/\")) {\n    ctx.redirect(\"/\");\n}" },
    { name: "a complete check: //, backslash and control characters", file: "app/login/next.ts", code: "function safeNext(value: string) {\n    if (!value.startsWith(\"/\") || value.startsWith(\"//\") || value.includes(\"\\\\\") || /[\\x00-\\x1f\\s]/.test(value)) return \"/\";\n    return value;\n}" },
]);

// --- sec-open-redirect-from-input ------------------------------------------------------

matrix("sec-open-redirect-from-input", true, [
    { name: "Express redirect from the query", file: "src/routes/auth.ts", code: "router.get(\"/done\", (req, res) => res.redirect(req.query.next));" },
    { name: "Next redirect from searchParams through a name", file: "app/api/auth/callback/route.ts", code: "const next = request.nextUrl.searchParams.get(\"next\");\nreturn NextResponse.redirect(new URL(next, request.url));" },
    { name: "Flask redirect from args", file: "app/views.py", code: "return redirect(request.args.get(\"next\"))" },
]);

matrix("sec-open-redirect-from-input", false, [
    { name: "a snippet inside a template literal (measured FP: ByteHide)", file: "src/views/Overview.tsx", code: "const snippet = `res.redirect(req.query.next);`;" },
    { name: "validated by a helper", file: "src/routes/auth.ts", code: "res.redirect(safeRedirect(req.query.next));" },
    { name: "checked on a line between the read and the redirect", file: "app/api/cb/route.ts", code: "const next = searchParams.get(\"next\");\nif (!ALLOWED.has(next)) return deny();\nreturn NextResponse.redirect(new URL(next, request.url));" },
]);

// --- sec-ssrf-fetch-from-input ---------------------------------------------------------

matrix("sec-ssrf-fetch-from-input", true, [
    { name: "fetch of a query parameter through a name", file: "app/api/proxy/route.ts", code: "const url = new URL(request.url).searchParams.get(\"url\") ?? \"\";\nconst answer = await fetch(url);" },
    { name: "axios on the body", file: "src/routes/unfurl.ts", code: "const { data } = await axios.get(req.body.url);" },
    { name: "requests on args", file: "app/fetch.py", code: "r = requests.get(request.args[\"url\"], timeout=5)" },
]);

matrix("sec-ssrf-fetch-from-input", false, [
    { name: "guarded by an allowlist check between (measured FP: polaris modrinth icon)", file: "app/api/icon/route.ts", code: "const url = new URL(request.url).searchParams.get(\"url\") ?? \"\";\nif (!isModrinthIcon(url)) return new Response(null, { status: 400 });\nconst answer = await fetch(url);" },
    { name: "through safeFetch", file: "app/api/proxy/route.ts", code: "const url = searchParams.get(\"url\");\nconst answer = await safeFetch(url);" },
    { name: "a client component", file: "app/page.tsx", code: "\"use client\";\nconst url = searchParams.get(\"url\");\nfetch(url);" },
]);

// --- sec-ssrf-dns-recheck --------------------------------------------------------------

const CHECK_THEN_FETCH = [
    "import { lookup } from \"node:dns/promises\";",
    "async function reachable(host: string) {",
    "    const addresses = await lookup(host, { all: true });",
    "    return addresses.every((a) => !isPrivateIp(a.address));",
    "}",
    "export async function follow(url: URL) {",
    "    if (!(await reachable(url.hostname))) return null;",
    "    return fetch(url, { redirect: \"manual\" });",
    "}",
].join("\n");

matrix("sec-ssrf-dns-recheck", true, [
    { name: "resolve, check, fetch by hostname (VULN-0001)", file: "lib/safe-fetch.ts", code: CHECK_THEN_FETCH },
    { name: "python getaddrinfo then requests", file: "app/files/fetch.py", code: "import socket, ipaddress, requests\ninfos = socket.getaddrinfo(host, None)\nif any(ipaddress.ip_address(i[4][0]).is_private for i in infos):\n    raise ValueError()\nresp = requests.get(url)" },
]);

matrix("sec-ssrf-dns-recheck", false, [
    { name: "the connection is pinned with a vetting lookup", file: "lib/safe-fetch.ts", code: `${CHECK_THEN_FETCH}\nconst agent = new Agent({ connect: { lookup: vetted } });` },
    { name: "a resolution with no private-address check", file: "lib/doh.ts", code: "const addrs = await dns.resolve4(host);\nawait fetch(`https://${addrs[0]}/`);" },
]);

// --- sec-untrusted-file-inline ---------------------------------------------------------

matrix("sec-untrusted-file-inline", true, [
    { name: "stored attachment served with the uploader's type (VULN-0010)", file: "app/api/tasks/attachments/[id]/route.ts", code: "return new Response(file.body, {\n    headers: {\n        \"Content-Type\": file.mime,\n        \"Content-Length\": String(file.size),\n    }\n});" },
    { name: "remote icon passed through (VULN-0008)", file: "lib/vault/api/misc.ts", code: "return new Response(icon.bytes, { headers: { \"content-type\": icon.contentType, \"cache-control\": \"public, max-age=86400\" } });" },
    { name: "Express setHeader from the blob", file: "src/handlers/blob.ts", code: "res.setHeader('Content-Type', blob.contentType ?? '')" },
    { name: "FastAPI media_type from the attachment", file: "api/attachments.py", code: "return Response(\n    content=data,\n    media_type=attachment.content_type,\n)" },
]);

matrix("sec-untrusted-file-inline", false, [
    { name: "headers from a shared helper spread in (the fixed VULN-0010)", file: "app/api/tasks/attachments/[id]/route.ts", code: "return new Response(file.body, {\n    headers: {\n        \"Content-Type\": file.mime,\n        ...untrustedFileHeaders(file.mime)\n    }\n});" },
    { name: "sandboxed by CSP in the file", file: "app/api/files/route.ts", code: "return new Response(file.body, { headers: { \"content-type\": file.mime, \"content-security-policy\": \"default-src 'none'; sandbox\" } });" },
    { name: "forced attachment", file: "app/api/files/route.ts", code: "return new Response(file.body, { headers: { \"content-type\": file.mime, \"content-disposition\": `attachment; filename=\"${name}\"` } });" },
    { name: "an outgoing request's content type (measured FP class)", file: "src/avatar.ts", code: "await fetch(endpoint, { method: \"POST\", headers: { \"Content-Type\": file.type }, body: file });" },
    { name: "an API proxy forwarding the upstream JSON type (measured FP class)", file: "app/api/geo/route.ts", code: "return new Response(res.body, { headers: { \"content-type\": res.headers.get(\"content-type\") ?? \"application/json\" } });" },
    { name: "downloadHeaders from @enigmax/utils", file: "app/api/files/route.ts", code: "return new Response(file.body, { headers: { \"content-type\": file.mime, ...rest } });\nconst h = downloadHeaders({ name, type: file.mime });" },
]);

// --- sec-path-join-from-input ----------------------------------------------------------

matrix("sec-path-join-from-input", true, [
    { name: "route params joined into a served path (measured: dymo-cdn)", file: "src/routes/provider/main.ts", code: "router.get(\"/:location/:file(*)\", (req, res) => {\n    const { location, file } = req.params;\n    return res.sendFile(path.join(baseDir, location, file));\n});" },
    { name: "a query value joined directly", file: "src/routes/files.ts", code: "const full = path.join(ROOT, req.query.name);" },
    { name: "python os.path.join on args", file: "app/files.py", code: "full = os.path.join(BASE, request.args[\"name\"])" },
]);

matrix("sec-path-join-from-input", false, [
    { name: "contained with path.relative", file: "src/routes/files.ts", code: "const full = path.resolve(ROOT, req.query.name);\nif (path.relative(ROOT, full).startsWith(\"..\")) throw new Error();" },
    { name: "names refused when they carry .. (measured FP: dymo-cdn releases)", file: "src/routes/releases.ts", code: "const { file } = req.params;\nif (file.includes(\"..\") || file.includes(\"/\")) return res.status(400).end();\nconst dest = path.join(dir, file);" },
    { name: "resolveInside from @enigmax/utils", file: "src/routes/files.ts", code: "const { name } = req.params;\nconst full = resolveInside(ROOT, name);" },
    { name: "sendFile with a root", file: "src/routes/files.ts", code: "const { name } = req.params;\nres.sendFile(path.join(\"public\", name), { root: ROOT });" },
]);

// --- sec-markdown-html-unsanitized: mammoth --------------------------------------------

matrix("sec-markdown-html-unsanitized", true, [
    { name: "mammoth output inserted raw, dynamic import (VULN-0011)", file: "app/drive/viewer/doc-view.tsx", code: "const mammoth = await import(\"mammoth\");\nconst result = await mammoth.convertToHtml({ arrayBuffer });\nreturn <div dangerouslySetInnerHTML={{ __html: result.value }} />;" },
]);

matrix("sec-markdown-html-unsanitized", false, [
    { name: "mammoth output sanitized", file: "app/drive/viewer/doc-view.tsx", code: "import mammoth from \"mammoth\";\nconst html = sanitizeDocHtml((await mammoth.convertToHtml({ arrayBuffer })).value);\nreturn <div dangerouslySetInnerHTML={{ __html: html }} />;" },
]);
