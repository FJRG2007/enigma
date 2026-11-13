/**
 * Machine-readable CLI output: one JSON document on stdout, and one error shape for every command
 * that takes `--json`:
 *
 *   { "error": { "code": "<stable_snake_case>", "message": "<human text>" } }
 *
 * Exit codes follow the rest of the CLI: 1 for input the caller got wrong, 2 for a run that could
 * not complete. A host parses stdout in both cases; nothing a `--json` command prints on stdout is
 * anything but that one document.
 */

export const EXIT_INPUT = 1;
export const EXIT_FAILED = 2;

/** An error with a stable code, raised by the host-facing commands and rendered by fail(). */
export class CliError extends Error {
    constructor(readonly code: string, message: string, readonly exitCode: number = EXIT_INPUT) {
        super(message);
        this.name = "CliError";
    }
}

/** Print one JSON document on stdout. */
export function printJson(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Report an error and return the exit code: the JSON shape on stdout under `--json`, plain text on
 * stderr otherwise.
 */
export function fail(code: string, message: string, json: boolean, exitCode: number = EXIT_INPUT): number {
    if (json) printJson({ error: { code, message } });
    else console.error(message);
    return exitCode;
}

/** Render any thrown value through fail(): a CliError keeps its code, anything else is `failed`. */
export function failWith(err: unknown, json: boolean): number {
    if (err instanceof CliError) return fail(err.code, err.message, json, err.exitCode);
    return fail("failed", (err as Error)?.message || String(err), json, EXIT_FAILED);
}
