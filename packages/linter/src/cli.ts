/**
 * enigmax-lint CLI. Lints the given paths (default: the current directory)
 * against the Ciphera style rules and security audits, prints a report, and
 * exits non-zero when any error-severity violation is found.
 */

import type { Category } from "./types";
import { formatReport } from "./report";
import { fixFiles, lintFiles } from "./index";

function main(argv: string[]): number {
    const paths: string[] = [];
    let json = false;
    let fix = false;
    let strict = false;
    let categories: Category[] | undefined;

    for (const arg of argv) {
        switch (arg) {
            case "-h": case "--help": printHelp(); return 0;
            case "--json": json = true; break;
            case "--fix": fix = true; break;
            case "--strict": strict = true; break;
            case "--style-only": categories = ["style"]; break;
            case "--audit-only": categories = ["audit"]; break;
            default:
                if (arg.startsWith("-")) { console.error(`Unknown option: ${arg}`); return 2; }
                paths.push(arg);
        }
    }
    if (!paths.length) paths.push(".");

    // Apply the safe auto-fixes first, then report whatever remains unfixable.
    const fixed = fix ? fixFiles(paths) : [];
    const violations = lintFiles(paths, { categories });
    if (json) console.log(JSON.stringify(violations, null, 2));
    else {
        if (fixed.length) console.log(`enigmax-lint: auto-fixed ${fixed.length} file(s).`);
        console.log(formatReport(violations));
    }

    // Default: fail only on error-severity (URL imports, secrets). --strict also fails on
    // warnings (the Ciphera style rules), so a changed-files gate can block style drift.
    return violations.some((v) => v.severity === "error" || (strict && v.severity === "warning")) ? 1 : 0;
}

function printHelp(): void {
    console.log(`
enigmax-lint - Ciphera-style linter and security auditor

Usage:
  enigmax-lint [paths...] [options]

Options:
  --fix            Apply safe formatting fixes in place before reporting
  --strict         Exit non-zero on warnings too, not just errors
  --style-only     Only run Ciphera style rules
  --audit-only     Only run security audits (e.g. hardcoded secrets)
  --json           Output violations as JSON
  -h, --help       Show this help

Default path is the current directory. Exits non-zero on any error-severity
violation (URL/CDN imports, hardcoded secrets); add --strict to also fail on
warning-severity Ciphera style findings. --fix only touches the mechanical
formatting rules (whitespace, blank lines, final newline); style and audit rules
are reported, never rewritten.
`);
}

process.exit(main(process.argv.slice(2)));
