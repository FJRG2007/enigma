/**
 * accounts.ts cannot import PACKS (packs.ts imports accounts.ts), so pack ids are mirrored in
 * command-names.ts. This fails the moment a pack is added without its name being reserved.
 */
import { PACKS } from "../src/packs";
import { test, expect } from "bun:test";
import { PACK_COMMANDS } from "../src/command-names";

test("every pack id is reserved as a command name", () => {
    expect([...PACK_COMMANDS].sort()).toEqual(PACKS.map((p) => p.id).sort());
});
