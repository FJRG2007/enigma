/**
 * Gate config: the security trust boundary (effectiveRepoConfig keeps the
 * code-executing fields off the pushed branch unless the trusted copy opts in),
 * ci_timeout parsing (Go-style durations -> ms, "unlimited" sentinel), and the
 * global+repo merge. Pure parsing; YAML loaders run under Bun (Bun.YAML).
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "bun:test";
import * as gateConfig from "@/gate/config";
import { canAutoResolve } from "@/gate/cli/axiDrive";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const repo = (over: Partial<ReturnType<typeof gateConfig.loadRepoFromBytes>> = {}) => ({
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
    const eff = gateConfig.effectiveRepoConfig(pushed, null, false);
    expect(eff.commands.lint).toBe(""); // executable field forced empty
    expect(eff.agent).toBe(""); // inherits global
    expect(eff.ignorePatterns).toEqual(["x"]); // non-executing field kept from pushed
});

test("trust boundary: commands/agent come from the trusted copy", () => {
    const pushed = repo({ agent: "codex", commands: { lint: "evil", test: "evil", format: "" } });
    const trusted = repo({ agent: "claude", commands: { lint: "npm run lint", test: "npm test", format: "" } });
    const eff = gateConfig.effectiveRepoConfig(pushed, trusted, false);
    expect(eff.agent).toBe("claude");
    expect(eff.commands.lint).toBe("npm run lint");
});

test("trust boundary: allowRepoCommands honors the pushed copy wholesale", () => {
    const pushed = repo({ agent: "codex", commands: { lint: "npm run lint", test: "", format: "" } });
    const eff = gateConfig.effectiveRepoConfig(pushed, repo({ agent: "claude" }), true);
    expect(eff.agent).toBe("codex");
    expect(eff.commands.lint).toBe("npm run lint");
});

test("parseCITimeout: keywords and non-positive resolve to unlimited; durations to ms", () => {
    expect(gateConfig.parseCITimeout("unlimited")).toBe(gateConfig.CI_TIMEOUT_UNLIMITED);
    expect(gateConfig.parseCITimeout("never")).toBe(gateConfig.CI_TIMEOUT_UNLIMITED);
    expect(gateConfig.parseCITimeout("0s")).toBe(gateConfig.CI_TIMEOUT_UNLIMITED);
    expect(gateConfig.parseCITimeout("168h")).toBe(168 * 60 * 60 * 1000);
    expect(gateConfig.parseCITimeout("30m")).toBe(30 * 60 * 1000);
    expect(gateConfig.parseCITimeout("1h30m")).toBe(90 * 60 * 1000);
});

test("loadGlobal returns defaults when the file is absent", () => {
    const g = gateConfig.loadGlobal("/no/such/gate/config.yaml");
    expect(g.agent).toBe("auto");
    expect(g.ciTimeout).toBe(gateConfig.DEFAULT_CI_TIMEOUT);
    expect(g.logLevel).toBe("info");
});

test("fix_policy: defaults to assisted, parses the three values, rejects anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "enigma-gate-cfg-"));
    const path = join(dir, "config.yaml");

    expect(gateConfig.loadGlobal("/no/such/config.yaml").fixPolicy).toBe(gateConfig.DEFAULT_FIX_POLICY);
    expect(gateConfig.DEFAULT_FIX_POLICY).toBe("assisted");

    for (const value of gateConfig.FIX_POLICIES) {
        writeFileSync(path, `fix_policy: ${value}\n`);
        expect(gateConfig.loadGlobal(path).fixPolicy).toBe(value);
        // The merged config is what the drive loop reads, and a repo cannot set this one.
        expect(gateConfig.merge(gateConfig.loadGlobal(path), gateConfig.loadRepoFromBytes("agent: codex\n")).fixPolicy).toBe(value);
    }

    // A typo must fail loudly: silently reading as "never ask" is the dangerous direction.
    writeFileSync(path, "fix_policy: whenever\n");
    expect(() => gateConfig.loadGlobal(path)).toThrow(/fix_policy/);

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
    const r = gateConfig.loadRepoFromBytes("agent: codex\ncommands:\n  test: npm test\nignore_patterns:\n  - dist\n");
    expect(r.agent).toBe("codex");
    expect(r.commands.test).toBe("npm test");
    expect(r.ignorePatterns).toEqual(["dist"]);

    const g = gateConfig.loadGlobal("/no/such/config.yaml");
    const cfg = gateConfig.merge(g, r);
    expect(cfg.agent).toBe("codex"); // repo overrides global "auto"
    expect(cfg.autoFix.rebase).toBe(3); // default applied
});

test("ENIGMA_AGENT_<NAME> points the gate at an agent installed off PATH", async () => {
    const prev = process.env.ENIGMA_AGENT_CLAUDE;
    try {
        // A binary that exists but is nowhere near PATH - the sandboxed-runner case.
        process.env.ENIGMA_AGENT_CLAUDE = process.execPath;
        expect(gateConfig.agentPathOverridesFromEnv()).toEqual({ claude: process.execPath });

        const cfg = gateConfig.merge(gateConfig.loadGlobal("/no/such/config.yaml"), repo());
        // The env override lands even with no config file at all, which is the usual state
        // inside a container.
        expect(cfg.agentPathOverride).toEqual({ claude: process.execPath });
        await gateConfig.resolveAgent(cfg, async (bin) => bin); // lookPath stub: everything resolves
        expect(cfg.agent).toBe("claude");
        expect(gateConfig.agentPath(cfg)).toBe(process.execPath);

        // An empty value is not an override; it must not shadow the PATH lookup.
        process.env.ENIGMA_AGENT_CLAUDE = "   ";
        expect(gateConfig.agentPathOverridesFromEnv()).toEqual({});
    } finally {
        if (prev === undefined) delete process.env.ENIGMA_AGENT_CLAUDE; else process.env.ENIGMA_AGENT_CLAUDE = prev;
    }
});

test("the env override beats agent_path_override in the config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "enigma-gate-agent-"));
    const path = join(dir, "config.yaml");
    const prev = process.env.ENIGMA_AGENT_CODEX;
    try {
        writeFileSync(path, "agent_path_override:\n  claude: /from/file/claude\n  codex: /from/file/codex\n");
        expect(gateConfig.loadGlobal(path).agentPathOverride).toEqual({ claude: "/from/file/claude", codex: "/from/file/codex" });

        process.env.ENIGMA_AGENT_CODEX = "/from/env/codex";
        expect(gateConfig.loadGlobal(path).agentPathOverride).toEqual({ claude: "/from/file/claude", codex: "/from/env/codex" });
    } finally {
        if (prev === undefined) delete process.env.ENIGMA_AGENT_CODEX; else process.env.ENIGMA_AGENT_CODEX = prev;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a broken override is reported, not skipped as `no agent installed`", async () => {
    const prev = process.env.ENIGMA_AGENT_CLAUDE;
    try {
        process.env.ENIGMA_AGENT_CLAUDE = "/private/harness/bin/claude";
        const cfg = gateConfig.merge(gateConfig.loadGlobal("/no/such/config.yaml"), repo());
        const missing = async (): Promise<string> => {
            const err = new Error("not found") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
        };
        // Falling through to the next agent is what made a typo read as "no agent installed"
        // on a machine that was running one. Asserted on the override-specific wording, not
        // just the path: the fall-through error lists every probed binary, so matching the
        // path alone passes even when the override is being silently skipped.
        await expect(gateConfig.resolveAgent(cfg, missing)).rejects.toThrow(
            /the claude agent path override points at "\/private\/harness\/bin\/claude", which is not an executable file/
        );
        expect(gateConfig.agentPathEnvVar("claude")).toBe("ENIGMA_AGENT_CLAUDE");
    } finally {
        if (prev === undefined) delete process.env.ENIGMA_AGENT_CLAUDE; else process.env.ENIGMA_AGENT_CLAUDE = prev;
    }
});
