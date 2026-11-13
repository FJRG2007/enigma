/**
 * Request-body schemas for `enigma serve`.
 *
 * A small declarative validator rather than a dependency: the package ships with no runtime
 * dependencies, and the request shapes here are flat. Every body is an object, unknown keys are
 * refused (a typo must not silently fall back to a default), strings are trimmed before their
 * length is checked, and every number and list carries a bound.
 */

export type FieldSpec =
    | { type: "string"; max: number; min?: number; required?: boolean; }
    | { type: "int"; min: number; max: number; required?: boolean; }
    | { type: "bool"; required?: boolean; }
    | { type: "enum"; values: readonly string[]; required?: boolean; }
    | { type: "strings"; maxItems: number; maxLength: number; required?: boolean; }
    | { type: "ints"; maxItems: number; min: number; max: number; required?: boolean; };

export type Schema = Record<string, FieldSpec>;

export type Parsed = { ok: true; value: Record<string, unknown>; } | { ok: false; message: string; };

/** Validate (and normalize) `body` against `schema`. */
export function parseBody(schema: Schema, body: unknown): Parsed {
    if (body === undefined || body === null) body = {};
    if (typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "the body must be a JSON object" };
    const input = body as Record<string, unknown>;
    const unknown = Object.keys(input).filter((k) => !(k in schema));
    if (unknown.length) return { ok: false, message: `unknown field(s): ${unknown.join(", ")}` };
    const value: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(schema)) {
        const raw = input[key];
        if (raw === undefined || raw === null) {
            if (spec.required) return { ok: false, message: `'${key}' is required` };
            continue;
        }
        const checked = checkField(key, spec, raw);
        if (typeof checked === "string") return { ok: false, message: checked };
        value[key] = checked.value;
    }
    return { ok: true, value };
}

/** One field: the normalized value, or the reason it was refused. */
function checkField(key: string, spec: FieldSpec, raw: unknown): { value: unknown; } | string {
    switch (spec.type) {
        case "string": {
            if (typeof raw !== "string") return `'${key}' must be a string`;
            const v = raw.trim();
            if (v.length < (spec.min ?? (spec.required ? 1 : 0))) return `'${key}' must not be empty`;
            if (v.length > spec.max) return `'${key}' is longer than ${spec.max} characters`;
            return { value: v };
        }
        case "int":
            if (typeof raw !== "number" || !Number.isInteger(raw)) return `'${key}' must be an integer`;
            if (raw < spec.min || raw > spec.max) return `'${key}' must be between ${spec.min} and ${spec.max}`;
            return { value: raw };
        case "bool":
            if (typeof raw !== "boolean") return `'${key}' must be true or false`;
            return { value: raw };
        case "enum":
            if (typeof raw !== "string" || !spec.values.includes(raw)) return `'${key}' must be one of: ${spec.values.join(", ")}`;
            return { value: raw };
        case "strings": {
            if (!Array.isArray(raw)) return `'${key}' must be an array of strings`;
            if (raw.length > spec.maxItems) return `'${key}' takes at most ${spec.maxItems} items`;
            const out: string[] = [];
            for (const item of raw) {
                if (typeof item !== "string") return `'${key}' must contain only strings`;
                const v = item.trim();
                if (v.length > spec.maxLength) return `'${key}' items are at most ${spec.maxLength} characters`;
                if (v) out.push(v);
            }
            if (spec.required && !out.length) return `'${key}' must not be empty`;
            return { value: out };
        }
        case "ints": {
            if (!Array.isArray(raw)) return `'${key}' must be an array of integers`;
            if (raw.length > spec.maxItems) return `'${key}' takes at most ${spec.maxItems} items`;
            if (!raw.every((n) => typeof n === "number" && Number.isInteger(n) && n >= spec.min && n <= spec.max)) return `'${key}' must contain integers between ${spec.min} and ${spec.max}`;
            if (spec.required && !raw.length) return `'${key}' must not be empty`;
            return { value: raw };
        }
    }
}
