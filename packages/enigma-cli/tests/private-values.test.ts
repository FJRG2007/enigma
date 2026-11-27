import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-private-values-"));
process.env.ENIGMA_CONFIG_HOME = HOME;
// The Stop-hook learner would start a detached `gh` sync; a test never reaches the network.
process.env.ENIGMA_NO_BACKGROUND_TIDY = "1";

const pv = await import("../src/private-values");
const { learnPrivateValues } = await import("../src/private-values-learn");
const { checkFile } = await import("../src/guardrails");
const { runAttributionGuardHook } = await import("../src/attribution-guard");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

/** A git repository holding `files`, for the "already public here" classification. */
function repo(name: string, files: Record<string, string>): string {
    const dir = join(HOME, name);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
    for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); }
    execFileSync("git", ["add", "-A"], { cwd: dir, windowsHide: true });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "init"], { cwd: dir, windowsHide: true });
    return dir;
}

/** A transcript whose last human prompt is `prompt`. */
function transcript(prompt: string): string {
    const path = join(HOME, `t-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "user", origin: { kind: "human" }, message: { role: "user", content: prompt } })}\n`);
    return path;
}

test("extracts deployment hosts, real IPs and emails, and leaves public and code-shaped tokens alone", () => {
    const found = pv.extractValues([
        "GET https://shop.acme-widgets.io/api/proxy/billing 500",
        "my site at www.acme-widgets.io is down, server 84.21.7.19, router 192.168.1.40",
        "write to ops@acme-widgets.io",
        "see https://github.com/x/y and https://react.dev/learn, also docs at nodejs.org",
        "clients_1.prisma.plans.findUnique() in /app/build/routes/index.js:34 and package.json",
        "loopback 127.0.0.1, docs range 192.0.2.10, resolver 1.1.1.1, version 10.0.26200.1",
        "preview at my-shop.vercel.app",
        "Found status: OUTDATED Current: 1.10.0.1 Target: 1.10.2.1, java=21.0.13.1, at VersionChecker$1.run(VersionChecker.java:117)",
    ].join("\n"));
    const values = found.map((f) => `${f.kind}:${f.value}`).sort();
    expect(values).toEqual([
        "email:ops@acme-widgets.io",
        "host:acme-widgets.io",
        "host:my-shop.vercel.app",
        "host:shop.acme-widgets.io",
        "ip:192.168.1.40",
        "ip:84.21.7.19",
    ]);
});

test("a learned value blocks other repositories and stays allowed where it is already public", () => {
    const own = repo("own", { "src/api.ts": "export const BASE = \"https://shop.acme-widgets.io\";\n" });
    const other = repo("other", { "README.md": "# other\n" });
    const added = learnPrivateValues(transcript("the deploy at shop.acme-widgets.io fails, nslookup says 84.21.7.19"), "It resolves to 84.21.7.19 and 10.0.4.12.", own);
    expect(added).toBe(3);
    expect(pv.readPrivateValues().map((v) => v.value).sort()).toEqual(["10.0.4.12", "84.21.7.19", "shop.acme-widgets.io"]);

    const line = "const url = \"https://shop.acme-widgets.io/v2\";\n";
    // Its own project already carries the domain: editing its client is not a leak.
    expect(checkFile(join(own, "src/client.ts"), line, null, "diff").filter((f) => f.ruleId === "sec-private-term")).toEqual([]);
    // Anywhere else it is blocked, and the finding never repeats the value.
    const leak = checkFile(join(other, "src/fix.ts"), line, null, "diff").filter((f) => f.ruleId === "sec-private-term");
    expect(leak.length).toBe(1);
    expect(JSON.stringify(leak)).not.toContain("acme-widgets");
    // The IPs were not in the own repository, so they are private even there.
    expect(checkFile(join(own, "docs/ops.md"), "Server: 84.21.7.19\n", null, "diff").filter((f) => f.ruleId === "sec-private-term").length).toBe(1);
    // The consent marker clears one line.
    expect(checkFile(join(other, "src/fix.ts"), "const u = \"shop.acme-widgets.io\"; // enigma:allow-private-value\n", null, "diff").filter((f) => f.ruleId === "sec-private-term")).toEqual([]);
    // An address that only shares a prefix is a different address.
    expect(checkFile(join(other, "src/fix.ts"), "const ip = \"84.21.7.190\";\n", null, "diff").filter((f) => f.ruleId === "sec-private-term")).toEqual([]);
});

test("a commit or PR message naming a learned value is refused without echoing it", () => {
    const other = join(HOME, "other");
    const payload = (command: string): string => JSON.stringify({ tool_name: "Bash", cwd: other, tool_input: { command } });
    const write = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    try {
        expect(runAttributionGuardHook(payload("gh pr create --title \"fix\" --body \"the server 84.21.7.19 was down\""))).toBe(2);
        expect(err).not.toContain("84.21.7.19");
        expect(runAttributionGuardHook(payload("git commit -m \"fix: retry the billing request\""))).toBe(0);
    } finally { process.stderr.write = write; }
});

test("the commit guard blocks a staged line carrying a learned value in another repository", async () => {
    const { runGuard } = await import("../src/guard");
    const other = join(HOME, "other");
    writeFileSync(join(other, "fix.ts"), "export const HOST = \"shop.acme-widgets.io\";\n");
    execFileSync("git", ["add", "fix.ts"], { cwd: other, windowsHide: true });
    const before = process.cwd();
    process.chdir(other);
    try {
        const result = runGuard();
        const hits = result.findings.filter((f) => f.severity === "block" && f.rule === "private-term");
        expect(hits.length).toBe(1);
        expect(JSON.stringify(hits)).not.toContain("acme-widgets");
    } finally { process.chdir(before); }
});

test("forgetting a value is the consent to publish it", () => {
    expect(pv.forgetValues("84.21.7.19")).toBe(1);
    expect(pv.readPrivateValues().some((v) => v.value === "84.21.7.19")).toBe(false);
    expect(pv.forgetValues("*")).toBe(2);
    expect(pv.readPrivateValues()).toEqual([]);
});

test("a private repository name is refused only in a repository known to be public", () => {
    const pub = repo("pub", { "README.md": "# pub\n" });
    const priv = repo("priv", { "README.md": "# priv\n" });
    pv.writePrivateRepos({ names: ["acme-saas", "nightowl", "planner", "atlas"], syncedAt: Date.now(), visibility: {
        [pv.normalizeRoot(pub)]: { public: true, at: Date.now() },
        [pv.normalizeRoot(priv)]: { public: false, at: Date.now() },
    } });
    const hits = (dir: string, text: string): number => checkFile(join(dir, "docs/notes.md"), text, null, "diff").filter((f) => f.ruleId === "sec-private-term").length;
    expect(hits(pub, "Measured over acme-saas and NightOwl.\n")).toBe(1);
    // Cross references between the user's own private repositories are legitimate.
    expect(hits(priv, "Measured over acme-saas and NightOwl.\n")).toBe(0);
    // A generic or short name would match ordinary code, so it is never refused.
    expect(hits(pub, "The planner reads the atlas.\n")).toBe(0);
    // Unknown visibility blocks nothing.
    expect(hits(join(HOME, "other"), "Measured over acme-saas.\n")).toBe(0);
});
