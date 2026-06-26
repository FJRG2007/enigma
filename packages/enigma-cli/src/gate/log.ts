/**
 * Minimal leveled logger for the gate subsystem, the port's equivalent of Go's
 * `slog`. Writes `level message key=value ...` lines to stderr (stdout stays the
 * protocol/TOON channel). The threshold is read from `ENIGMA_GATE_LOG_LEVEL`
 * (debug|info|warn|error), defaulting to info.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function threshold(): number {
    const env = (process.env.ENIGMA_GATE_LOG_LEVEL ?? "info").toLowerCase();
    return LEVEL_ORDER[env as Level] ?? LEVEL_ORDER.info;
}

function emit(level: Level, msg: string, attrs: unknown[]): void {
    if (LEVEL_ORDER[level] < threshold()) return;
    let line = `${level} ${msg}`;
    for (let i = 0; i + 1 < attrs.length; i += 2) {
        line += ` ${String(attrs[i])}=${JSON.stringify(attrs[i + 1])}`;
    }
    process.stderr.write(`${line}\n`);
}

/** Structured leveled logger; extra args are flattened key/value pairs. */
export const log = {
    debug: (msg: string, ...attrs: unknown[]) => emit("debug", msg, attrs),
    info: (msg: string, ...attrs: unknown[]) => emit("info", msg, attrs),
    warn: (msg: string, ...attrs: unknown[]) => emit("warn", msg, attrs),
    error: (msg: string, ...attrs: unknown[]) => emit("error", msg, attrs)
};
