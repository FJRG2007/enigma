/**
 * Minimal YAML access for gate config files. The gate keeps enigma's
 * zero-npm-runtime-deps posture by using Bun's native `Bun.YAML.parse` (a
 * platform feature of the Bun runtime the enigma binary is compiled with)
 * instead of pulling a YAML package.
 *
 * enigma: Bun.YAML is the YAGNI-ladder "native platform feature" rung. The gate
 * daemon and CLI run inside the Bun binary, where it is always available. The
 * only non-Bun path (the `tsx`-based dev `check`) never parses gate YAML, so the
 * guard below throws a clear error rather than silently returning garbage.
 */

interface BunYaml {
    parse(text: string): unknown;
}

/** Parses a YAML document into a plain JS value (objects, arrays, scalars). */
export function parseYaml(text: string): unknown {
    const bunYaml = (globalThis as { Bun?: { YAML?: BunYaml; }; }).Bun?.YAML;
    if (!bunYaml?.parse) {
        throw new Error("gate config YAML parsing requires the Bun runtime (Bun.YAML)");
    }
    return bunYaml.parse(text);
}

/** Returns the value as a plain record, or an empty object for null/non-objects. */
export function asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return {};
}
