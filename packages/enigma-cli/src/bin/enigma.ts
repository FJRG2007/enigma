/**
 * enigma - CLI entry point. Thin wrapper: parse argv and dispatch to the CLI
 * runner. All logic lives in ../ so it stays modular and testable.
 */

import { run } from "../cli";

run(process.argv.slice(2))
    // Exit explicitly once the command resolves. OpenTUI's native (Bun FFI) render
    // thread can keep the event loop alive after the TUI tears down, which would leave
    // the process - and the user's terminal - hanging. setImmediate gives OpenTUI one
    // tick to flush any deferred terminal-restore (finalizeDestroy) before we exit, so
    // the terminal is never left in the alternate screen. Non-zero exits are still
    // raised inside run().
    .then(() => setImmediate(() => process.exit(process.exitCode ?? 0)))
    .catch((err: unknown) => {
        console.error(err);
        process.exit(1);
    });
