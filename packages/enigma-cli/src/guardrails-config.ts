/**
 * Writer/schema for the user-wide guardrails config in ~/.enigma-guardrails.json:
 * which built-in rules are disabled and any custom rules the user added. The engine
 * (guardrails.ts) reads this file INDEPENDENTLY so it stays import-free and runs
 * standalone; this module is the mutating counterpart the CLI/registry use.
 *
 * Kept dependency-free and light (Node builtins + a type-only import) - mirrors the
 * guard.ts / guard-config.ts split.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { GuardrailRule } from "./guardrails";
import { readFileSync, writeFileSync } from "node:fs";

export interface GuardrailsConfig {
    /** Built-in rule ids the user turned off. */
    disabled: string[];
    /** User-added custom rules (merged after the built-ins by the engine). */
    rules: GuardrailRule[];
}

/** The user-wide guardrails config file (same path the engine reads; ENIGMA_GUARDRAILS_CONFIG relocates it). */
export function guardrailsConfigPath(): string {
    return process.env.ENIGMA_GUARDRAILS_CONFIG || join(homedir(), ".enigma-guardrails.json");
}

/** Read the config, defaulting empty and coercing the list fields to arrays. */
export function readGuardrailsConfig(): GuardrailsConfig {
    try {
        const raw = JSON.parse(readFileSync(guardrailsConfigPath(), "utf8"));
        return {
            disabled: Array.isArray(raw.disabled) ? raw.disabled.filter((s: unknown) => typeof s === "string") : [],
            rules: Array.isArray(raw.rules) ? raw.rules : [],
        };
    } catch { return { disabled: [], rules: [] }; }
}

function writeGuardrailsConfig(cfg: GuardrailsConfig): void {
    writeFileSync(guardrailsConfigPath(), `${JSON.stringify({ disabled: cfg.disabled, rules: cfg.rules }, null, 2)}\n`);
}

/** Turn a built-in rule off (deduped). */
export function disableRule(id: string): void {
    const cfg = readGuardrailsConfig();
    if (!cfg.disabled.includes(id)) { cfg.disabled.push(id); writeGuardrailsConfig(cfg); }
}

/** Re-enable a previously disabled built-in rule. */
export function enableRule(id: string): void {
    const cfg = readGuardrailsConfig();
    const next = cfg.disabled.filter((d) => d !== id);
    if (next.length !== cfg.disabled.length) { cfg.disabled = next; writeGuardrailsConfig(cfg); }
}

/** Add or replace a custom rule (matched by id). */
export function addRule(rule: GuardrailRule): void {
    const cfg = readGuardrailsConfig();
    cfg.rules = [...cfg.rules.filter((r) => r.id !== rule.id), rule];
    writeGuardrailsConfig(cfg);
}

/** Remove a custom rule by id (built-ins are removed via disableRule instead). */
export function removeRule(id: string): void {
    const cfg = readGuardrailsConfig();
    const next = cfg.rules.filter((r) => r.id !== id);
    if (next.length !== cfg.rules.length) { cfg.rules = next; writeGuardrailsConfig(cfg); }
}
