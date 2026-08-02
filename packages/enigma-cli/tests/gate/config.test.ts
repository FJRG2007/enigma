/**
 * Gate config: the security trust boundary (effectiveRepoConfig keeps the
 * code-executing fields off the pushed branch unless the trusted copy opts in),
 * ci_timeout parsing (Go-style durations -> ms, "unlimited" sentinel), and the
 * global+repo merge. Pure parsing; YAML loaders run under Bun (Bun.YAML).
 */
import { test, expect } from "bun:test";
import {
    merge,
    loadGlobal,
    loadRepoFromBytes,
    parseCITimeout,
    effectiveRepoConfig,
    CI_TIMEOUT_UNLIMITED,
    DEFAULT_CI_TIMEOUT
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
