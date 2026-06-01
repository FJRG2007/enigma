/** Audit: detect high-signal hardcoded secrets / credentials in source. */

import { basename } from "node:path";
import type { Rule, Violation } from "../types";

const ALLOWED_FILE = /(example|sample|template|fixture|\.test\.|\.spec\.)/i;

// [label, pattern]. High-signal only, to keep false positives low.
const SECRET_PATTERNS: Array<[string, RegExp]> = [
    ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
    ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
    ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
    ["Stripe secret key", /\bsk_live_[0-9A-Za-z]{24,}\b/],
    ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
    ["hardcoded credential", /\b(?:secret|token|api[_-]?key|passwd|password)\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/i],
];

export const noHardcodedSecrets: Rule = {
    name: "no-hardcoded-secrets",
    category: "audit",
    severity: "error",
    check(ctx) {
        if (ALLOWED_FILE.test(basename(ctx.file))) return [];
        const violations: Violation[] = [];
        ctx.lines.forEach((text, i) => {
            for (const [label, pattern] of SECRET_PATTERNS) {
                if (pattern.test(text)) {
                    violations.push({
                        rule: "no-hardcoded-secrets", category: "audit", severity: "error",
                        file: ctx.file, line: i + 1, column: 1,
                        message: `possible hardcoded secret (${label})`,
                    });
                }
            }
        });
        return violations;
    },
};
