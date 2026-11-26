/**
 * Refuses a Bash command too long for Claude Code's Bash tool on Windows.
 *
 * There the command reaches bash through a command line capped near 8191 characters, so a
 * longer one is cut. Measured over 30 days of this machine's transcripts (17,000 heredoc
 * calls): below 7,200 "effective" characters (length plus 3 per single quote, the cost of
 * re-quoting each one as '\'') almost nothing failed; at 8,000 and above every call did, as
 * `unexpected EOF while looking for matching '` on a body that `bash -n` accepts. Worse, a cut
 * that lands outside a quote fails silently: bash warns "here-document delimited by
 * end-of-file" and writes a truncated file while the call reports success.
 *
 * Only Claude Code (CLAUDECODE=1), only Windows, only its Bash tool: the other agents that share
 * this hook entry spawn their shells differently, and nothing measured them.
 *
 * COST: none of its own. It runs inside `enigma __browser-guard`, which Claude Code spawns for
 * any command it cannot evaluate an `if` filter against - a heredoc, `$VAR`, `$(...)` - and
 * those are what these long commands are.
 */

/** Effective length above which the command is refused; the measured cliff is 7,200-8,000. */
export const LONG_COMMAND_LIMIT = 7000;

/** The command's length once the harness re-quotes it: each `'` grows into `'\''`. */
export function effectiveLength(command: string): number {
    let quotes = 0;
    for (const ch of command) if (ch === "'") quotes++;
    return command.length + 3 * quotes;
}

/** Why the command would be cut before bash runs it, or "" when it fits or the limit does not apply. */
export function longCommandReason(command: string, tool: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
    if (platform !== "win32" || tool !== "Bash" || env.CLAUDECODE !== "1") return "";
    const length = effectiveLength(command);
    if (length <= LONG_COMMAND_LIMIT) return "";
    return `enigma: this Bash command is ${length} characters (quotes counted as the harness escapes them); Claude Code on Windows cuts commands near 8,000, so bash would see it truncated - "unexpected EOF", or worse, a heredoc that silently writes a partial file. Write the content with the Write tool (a script, a patch, a message file) and run that file with a short command, or split the work into calls under ${LONG_COMMAND_LIMIT} characters.\n`;
}
