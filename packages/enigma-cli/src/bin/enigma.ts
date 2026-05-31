/**
 * enigma - CLI entry point. Thin wrapper: parse argv and dispatch to the CLI
 * runner. All logic lives in ../ so it stays modular and testable.
 */

import { run } from "../cli";

run(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
