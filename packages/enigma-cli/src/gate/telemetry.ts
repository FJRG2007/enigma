/**
 * Anonymous usage telemetry for the gate. enigma is privacy-first (it already
 * disables gh telemetry on install), so this is OFF by default and emits
 * nothing unless `ENIGMA_GATE_TELEMETRY=1` is set, in which case events are
 * appended locally for inspection - never sent off-machine.
 *
 * enigma: minimal local-only sink. The upstream no-mistakes telemetry posts to a
 * remote collector; the upgrade path (a real exporter) is intentionally not
 * built - it would send data off-machine, against enigma's posture. Keep the
 * `track()` signature stable so callers (executor, steps) need no change if a
 * consented exporter is ever added.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { appendFileSync, mkdirSync } from "node:fs";

/** Flat key/value attributes attached to a telemetry event. */
export type Fields = Record<string, string | number | boolean>;

function enabled(): boolean {
    return process.env.ENIGMA_GATE_TELEMETRY === "1";
}

/** Records a named telemetry event. No-op unless explicitly enabled. */
export function track(event: string, fields: Fields = {}): void {
    if (!enabled()) return;
    try {
        const dir = join(homedir(), ".enigma", "gate");
        mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({ ts: Math.floor(Date.now() / 1000), event, ...fields });
        appendFileSync(join(dir, "telemetry.jsonl"), `${line}\n`);
    } catch {
        // Telemetry must never break the pipeline.
    }
}
