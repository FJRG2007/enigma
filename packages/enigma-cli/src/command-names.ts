/**
 * The fixed top-level command names, in one place.
 *
 * Two consumers need the same list: the CLI dispatcher and the account/profile name
 * validation, which refuses a name a command already owns. An account or profile name is
 * meant to be typed as a launch target (`enigma <name>`), and a command always wins the
 * command slot, so an account called "update" would be created and then be unreachable that
 * way. Kept in a module of its own so accounts.ts can import it without importing the CLI.
 *
 * Pack ids are listed here too (`helio`): packs.ts imports accounts.ts, so accounts.ts cannot
 * read PACKS without a cycle. tests/command-names.test.ts fails when a pack is added to PACKS
 * and not here.
 */
export const FIXED_COMMANDS: readonly string[] = [
    "install", "update", "security", "guard", "seal", "check", "config", "account", "accounts",
    "profile", "profiles", "skill", "skills", "issue", "improve", "qa", "compress", "guardrails", "trim", "verify", "mcp", "api", "gate", "dashboard", "dash", "fix-path", "resources", "kill", "recall", "codegraph", "autoskills", "design", "handoff", "relay", "statusline", "help", "version",
    "add", "components",
    "pack", "packs", "ssh", "completion", "branches", "doctor", "shim",
];

/** Pack ids, which launch a pack (`enigma helio`) and are therefore commands too. */
export const PACK_COMMANDS: readonly string[] = ["helio", "orion"];
