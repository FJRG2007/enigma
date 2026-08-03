/**
 * Gate config: the security trust boundary (effectiveRepoConfig keeps the
 * code-executing fields off the pushed branch unless the trusted copy opts in),
 * ci_timeout parsing (Go-style durations -> ms, "unlimited" sentinel), and the
 * global+repo merge. Pure parsing; YAML loaders run under Bun (Bun.YAML).
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { canAutoResolve } from "@/gate/cli/axiDrive";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
    merge,
    loadGlobal,
    FIX_POLICIES,
    loadRepoFromBytes,
    parseCITimeout,
    effectiveRepoConfig,
    CI_TIMEOUT_UNLIMITED,
    DEFAULT_CI_TIMEOUT,
    DEFAULT_FIX_POLICY
} from "@/gate/config";

const repo = (over: Partial<ReturnType<typeof loadRepoFromBytes>> = {}) => ({
    agent: "",
    commands: { lint: "", test: "", format: "" },
    ignorePatterns: [],
    allowRepoCommands: false,
    autoFix: {},
    intent: {},
    test: { evidence: {} },
    ...over
});

test("trust boundary: pushed commands/agent are dropped without a trusted copy", () => {
    const pushed = repo({ agent: "codex", commands: { lint: "rm -rf /", test: "", format: "" }, ignorePatterns: ["x"] });
    const eff = effectiveRepoConfig(pushed, null, false);
    expect(eff.commands.lint).toBe(""); // executable field forced empty
    expect(eff.agent).toBe(""); // inherits global
    expect(eff.ignorePatterns).toEqual(["x"]); // non-executing field kept from pushed
});

test("trust boundary: commands/agent come from the trusted copy", () => {
    const pushed = repo({ agent: "codex", commands: { lint: "evil", test: "evil", format: "" } });
    const trusted = repo({ agent: "claude", commands: { lint: "npm run lint", test: "npm test", format: "" } });
    const eff = effectiveRepoConfig(pushed, trusted, false);
    expect(eff.agent).toBe("claude");
    expect(eff.commands.lint).toBe("npm run lint");
});

test("trust boundary: allowRepoCommands honors the pushed copy wholesale", () => {
    const pushed = repo({ agent: "codex", commands: { lint: "npm run lint", test: "", format: "" } });
    const eff = effectiveRepoConfig(pushed, repo({ agent: "claude" }), true);
    expect(eff.agent).toBe("codex");
    expect(eff.commands.lint).toBe("npm run lint");
});

test("parseCITimeout: keywords and non-positive resolve to unlimited; durations to ms", () => {
    expect(parseCITimeout("unlimited")).toBe(CI_TIMEOUT_UNLIMITED);
    expect(parseCITimeout("never")).toBe(CI_TIMEOUT_UNLIMITED);
    expect(parseCITimeout("0s")).toBe(CI_TIMEOUT_UNLIMITED);
    expect(parseCITimeout("168h")).toBe(168 * 60 * 60 * 1000);
    expect(parseCITimeout("30m")).toBe(30 * 60 * 1000);
    expect(parseCITimeout("1h30m")).toBe(90 * 60 * 1000);
});

test("loadGlobal returns defaults when the file is absent", () => {
    const g = loadGlobal("/no/such/gate/config.yaml");
    expect(g.agent).toBe("auto");
    expect(g.ciTimeout).toBe(DEFAULT_CI_TIMEOUT);
    expect(g.logLevel).toBe("info");
});

test("fix_policy: defaults to assisted, parses the three values, rejects anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "enigma-gate-cfg-"));
    const path = join(dir, "config.yaml");

    expect(loadGlobal("/no/such/config.yaml").fixPolicy).toBe(DEFAULT_FIX_POLICY);
    expect(DEFAULT_FIX_POLICY).toBe("assisted");

    for (const value of FIX_POLICIES) {
        writeFileSync(path, `fix_policy: ${value}\n`);
        expect(loadGlobal(path).fixPolicy).toBe(value);
        // The merged config is what the drive loop reads, and a repo cannot set this one.
        expect(merge(loadGlobal(path), loadRepoFromBytes("agent: codex\n")).fixPolicy).toBe(value);
    }

    // A typo must fail loudly: silently reading as "never ask" is the dangerous direction.
    writeFileSync(path, "fix_policy: whenever\n");
    expect(() => loadGlobal(path)).toThrow(/fix_policy/);

    rmSync(dir, { recursive: true, force: true });
});

test("canAutoResolve: only `assisted` looks at what the gate actually found", () => {
    const gate = (findings: unknown[]) => ({
        name: "review",
        status: "awaiting_approval",
        findingsJSON: JSON.stringify({ items: findings, summary: "" })
    } as Parameters<typeof canAutoResolve>[1]);

    const mechanical = gate([{ id: "a", severity: "warning", description: "d", action: "auto-fix" }]);
    const judgment = gate([
        { id: "a", severity: "warning", description: "d", action: "auto-fix" },
        { id: "b", severity: "warning", description: "e", action: "ask-user" }
    ]);

    // `ask` hands every gate back; `auto` answers every gate.
    expect(canAutoResolve("ask", mechanical)).toBe(false);
    expect(canAutoResolve("ask", judgment)).toBe(false);
    expect(canAutoResolve("auto", mechanical)).toBe(true);
    expect(canAutoResolve("auto", judgment)).toBe(true);

    // `assisted` settles the mechanical one and escalates the one carrying a decision.
    expect(canAutoResolve("assisted", mechanical)).toBe(true);
    expect(canAutoResolve("assisted", judgment)).toBe(false);
    // Unparseable findings are treated as none, so a broken payload does not park the run.
    expect(canAutoResolve("assisted", gate([]))).toBe(true);
    expect(canAutoResolve("assisted", { name: "review", status: "awaiting_approval", findingsJSON: "{{" } as Parameters<typeof canAutoResolve>[1])).toBe(true);
});

test("loadRepoFromBytes parses YAML and merge lets repo agent override global", () => {
    const r = loadRepoFromBytes("agent: codex\ncommands:\n  test: npm test\nignore_patterns:\n  - dist\n");
    expect(r.agent).toBe("codex");
    expect(r.commands.test).toBe("npm test");
    expect(r.ignorePatterns).toEqual(["dist"]);

    const g = loadGlobal("/no/such/config.yaml");
    const cfg = merge(g, r);
    expect(cfg.agent).toBe("codex"); // repo overrides global "auto"
    expect(cfg.autoFix.rebase).toBe(3); // default applied
});
