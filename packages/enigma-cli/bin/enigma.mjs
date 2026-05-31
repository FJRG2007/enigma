#!/usr/bin/env node
/**
 * enigma - CLI entry point. Thin wrapper: parse argv and dispatch to the CLI
 * runner. All logic lives in ../lib so it stays modular and testable.
 */

import { run } from "../lib/cli.mjs";

run(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});