/**
 * Which findings stop a gate run. The threshold used to be hardcoded to "error or warning";
 * it is now the `gate-severity` setting, so a run can be told to wait only on what must not
 * merge. What the threshold buys is time, not coverage: a finding below it is still found and
 * reported on the step outcome, the run simply advances instead of spending another full
 * re-review round on it.
 *
 * Temp HOME (set BEFORE the import) isolates ~/.enigma.json; the project scope is a temp dir
 * whose own .enigma.json is written per case.
 * Must run under Bun: bun test tests/gate/severity-threshold.test.ts
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Finding } from "@/gate/types";
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gate-severity-home-"));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
const PRIOR_CONFIG_HOME = process.env.ENIGMA_CONFIG_HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;

const PROJECT = mkdtempSync(join(tmpdir(), "enigma-gate-severity-project-"));

const { hasBlockingFindings } = await import("@/gate/pipeline/steps/commonFix");
const { CONFIG_DEFAULTS, GATE_SEVERITIES } = await import("@/config");
const { ALL_SETTINGS } = await import("@/settings-registry");

/** Points the project's .enigma.json at `severity`, or clears it when null. */
function setProjectSeverity(severity: string | null): void {
    const body = severity === null ? {} : { gateSeverity: severity };
    writeFileSync(join(PROJECT, ".enigma.json"), `${JSON.stringify(body, null, 4)}\n`);
}

function finding(severity: string): Finding {
    return { severity, description: `a ${severity} finding`, action: "auto-fix" } as Finding;
}

afterAll(() => {
    if (PRIOR_CONFIG_HOME === undefined) delete process.env.ENIGMA_CONFIG_HOME;
    else process.env.ENIGMA_CONFIG_HOME = PRIOR_CONFIG_HOME;
    rmSync(HOME, { recursive: true, force: true });
    rmSync(PROJECT, { recursive: true, force: true });
});

test("the default threshold is warning, which is the behavior that was hardcoded before", () => {
    expect(CONFIG_DEFAULTS.gateSeverity).toBe("warning");
    setProjectSeverity(null);
    expect(hasBlockingFindings([finding("error")], PROJECT)).toBe(true);
    expect(hasBlockingFindings([finding("warning")], PROJECT)).toBe(true);
    expect(hasBlockingFindings([finding("info")], PROJECT)).toBe(false);
});

test("error only waits on what must not merge", () => {
    setProjectSeverity("error");
    expect(hasBlockingFindings([finding("error")], PROJECT)).toBe(true);
    // The regression this pins: a warning-only round used to halt the run, and every halt the
    // user answers with `fix` costs a full re-review of the whole diff.
    expect(hasBlockingFindings([finding("warning")], PROJECT)).toBe(false);
    expect(hasBlockingFindings([finding("info")], PROJECT)).toBe(false);
    // A single error still blocks when it arrives alongside findings that would not.
    expect(hasBlockingFindings([finding("info"), finding("error")], PROJECT)).toBe(true);
});

test("info waits on everything", () => {
    setProjectSeverity("info");
    for (const severity of GATE_SEVERITIES) {
        expect(hasBlockingFindings([finding(severity)], PROJECT)).toBe(true);
    }
});

test("no findings never blocks, and an unrecognized severity never blocks", () => {
    for (const severity of [...GATE_SEVERITIES, "nonsense"]) {
        setProjectSeverity(severity === "nonsense" ? null : severity);
        expect(hasBlockingFindings([], PROJECT)).toBe(false);
    }
    setProjectSeverity("info");
    expect(hasBlockingFindings([finding("nonsense")], PROJECT)).toBe(false);
});

test("the setting reaches the CLI, dashboard and TUI through one registry entry", () => {
    const setting = ALL_SETTINGS.find(s => s.key === "gate-severity");
    expect(setting).toBeDefined();
    // The three surfaces render choice settings off `choices` + `readChoice`/`writeChoice`;
    // an entry missing either one is invisible to the dashboard and inert in the TUI.
    expect(setting!.choices).toEqual(GATE_SEVERITIES);
    expect(setting!.readChoice).toBeDefined();
    expect(setting!.writeChoice).toBeDefined();
    setting!.writeChoice!("error", "global");
    expect(setting!.readChoice!("global")).toBe("error");
});
