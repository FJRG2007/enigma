/**
 * Command-line size budget for agent invocations.
 *
 * Every adapter used to hand the whole prompt to the agent CLI as a single argv element. The OS
 * caps that, and the cap is small enough that a normal review round reaches it: Windows limits the
 * ENTIRE command line to 32,767 characters (CreateProcess), and Linux limits any SINGLE argument to
 * 128 KiB (MAX_ARG_STRLEN), regardless of the much larger total ARG_MAX. Overflowing surfaces from
 * libuv as `ENAMETOOLONG: name too long, uv_spawn` (or E2BIG) - an error that names neither the
 * prompt nor the limit, minutes into a step.
 *
 * So an adapter asks `promptFitsArgv` first and, when the prompt does not fit, sends it over stdin
 * instead. The budget is deliberately conservative: argv also carries the binary path, the user's
 * agent_args_override and a JSON schema, and on Windows quoting can inflate what was measured.
 * Prompts under the budget keep taking the exact argv path they always took.
 */

/** Characters left for the prompt itself, per platform. See the module comment for the sources. */
export const ARGV_PROMPT_BUDGET = process.platform === "win32" ? 8_000 : 100_000;

/**
 * Reports whether `prompt` can safely ride in argv alongside `otherArgs`.
 *
 * Measured in UTF-16 code units, which is what Windows counts; a UTF-8 platform may fit slightly
 * more, and erring toward stdin is harmless (stdin has no size limit).
 */
export function promptFitsArgv(prompt: string, otherArgs: readonly string[] = []): boolean {
    let used = 0;
    for (const arg of otherArgs) used += arg.length + 3; // + quotes and a separator
    return prompt.length + used <= ARGV_PROMPT_BUDGET;
}
