/** Audit: detect high-signal hardcoded secrets / credentials in source. */

import { basename } from "node:path";
import { ALL_LANGUAGES } from "../languages";
import type { Rule, Violation } from "../types";

const ALLOWED_FILE = /(example|sample|template|fixture|\.test\.|\.spec\.)/i;

/** A credential pattern. Capture group 1, when present, is the random portion to entropy-check. */
interface SecretPattern {
    label: string;
    pattern: RegExp;
    /** Skip the placeholder/entropy filter for structural markers that are self-evident (e.g. PEM blocks). */
    structural?: boolean;
}

// High-signal only, to keep false positives low.
const SECRET_PATTERNS: SecretPattern[] = [
    { label: "AWS access key id", pattern: /\bAKIA([0-9A-Z]{16})\b/ },
    { label: "GitHub token", pattern: /\bgh[pousr]_([A-Za-z0-9]{36,})\b/ },
    { label: "OpenAI API key", pattern: /\bsk-(?:proj-)?([A-Za-z0-9_-]{20,})\b/ },
    { label: "Anthropic API key", pattern: /\bsk-ant-([A-Za-z0-9_-]{20,})\b/ },
    { label: "Slack token", pattern: /\bxox[baprs]-([A-Za-z0-9-]{10,})\b/ },
    { label: "Google API key", pattern: /\bAIza([0-9A-Za-z_-]{35})\b/ },
    { label: "Stripe secret key", pattern: /\bsk_live_([0-9A-Za-z]{24,})\b/ },
    { label: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, structural: true },
    { label: "hardcoded credential", pattern: /\b(?:secret|token|api[_-]?key|passwd|password)\s*[:=]\s*["']([A-Za-z0-9_\-./+]{16,})["']/i },
];

// Words that mark an obvious placeholder rather than a real credential value.
const PLACEHOLDER_WORDS = new Set([
    "example", "sample", "placeholder", "change", "changeme", "dummy", "fake", "mock",
    "redacted", "test", "testing", "todo", "your", "my", "foo", "bar", "baz", "demo",
    "secret", "password", "passwd", "token", "key", "apikey", "here", "value",
    "none", "null", "undefined", "na", "xxx", "xxxx",
]);

export const noHardcodedSecrets: Rule = {
    name: "no-hardcoded-secrets",
    category: "audit",
    severity: "error",
    languages: ALL_LANGUAGES,
    check(ctx) {
        if (ALLOWED_FILE.test(basename(ctx.file))) return [];
        const violations: Violation[] = [];
        ctx.lines.forEach((text, i) => {
            for (const { label, pattern, structural } of SECRET_PATTERNS) {
                const match = pattern.exec(text);
                if (!match) continue;
                // The random portion (capture group 1) must look real, not like a placeholder/test value.
                if (!structural && !isLikelySecret(match[1] ?? match[0])) continue;
                violations.push({
                    rule: "no-hardcoded-secrets", category: "audit", severity: "error",
                    file: ctx.file, line: i + 1, column: 1,
                    message: `possible hardcoded secret (${label})`,
                });
            }
        });
        return violations;
    },
};

/** Whether a candidate looks like a real credential rather than a placeholder or low-entropy filler. */
function isLikelySecret(value: string): boolean {
    if (hasPlaceholderWord(value)) return false;
    if (new Set(value).size < 6) return false; // repeated fillers like "0000..." or "aaaa..."
    return shannonEntropy(value) >= 3;
}

/** True when any alphanumeric token in the value is a known placeholder word (e.g. "your_api_key_here"). */
function hasPlaceholderWord(value: string): boolean {
    return value.toLowerCase().split(/[^a-z0-9]+/).some((word) => PLACEHOLDER_WORDS.has(word));
}

/** Shannon entropy (bits per character) of the value, used to reject low-randomness placeholders. */
function shannonEntropy(value: string): number {
    const counts = new Map<string, number>();
    for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
        const p = count / value.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}
