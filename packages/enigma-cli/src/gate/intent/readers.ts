/**
 * Faithful port of upstream's `internal/intent/readers.go`: assembles the
 * default set of per-agent transcript readers, minus any the caller disabled by
 * name. Disabled names are compared against each reader's `name()`; the gate
 * config already lowercases its disabled-reader keys, matching the reader name
 * constants (all lowercase).
 */

import type { Reader } from "./reader";
import { newPiReader } from "./readerPi";
import { newCodexReader } from "./readerCodex";
import { newClaudeReader } from "./readerClaude";
import { newRovoDevReader } from "./readerRovodev";
import { newOpenCodeReader } from "./readerOpencode";

/**
 * Returns the default set of agent transcript readers, minus any the caller has
 * disabled by name.
 */
export function allReaders(disabled: Record<string, boolean>): Reader[] {
    const all: Reader[] = [
        newClaudeReader(),
        newCodexReader(),
        newOpenCodeReader(),
        newRovoDevReader(),
        newPiReader()
    ];
    if (Object.keys(disabled).length === 0) {
        return all;
    }
    const out: Reader[] = [];
    for (const r of all) {
        if (disabled[r.name()]) continue;
        out.push(r);
    }
    return out;
}
