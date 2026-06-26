/**
 * Minimal TOON (Token-Oriented Object Notation) encoder for the agent-facing axi
 * surface. enigma keeps zero runtime dependencies, so the Go port's
 * `github.com/toon-format/toon-go` is reimplemented here as the small subset axi
 * actually emits, matching its byte shape exactly.
 *
 * Emitted shapes (all observed from no-mistakes' `axi_render.go` output):
 *   - object field:  `key:` then its fields indented two spaces
 *   - scalar field:  `key: value`
 *   - table field:   `name[N]{c1,c2,c3}:` then N rows indented two more spaces,
 *                    each row a comma-joined cell list
 *   - inline list:   `key[N]: a,b,c` (a string array collapses onto one line)
 *
 * Quoting: a scalar is emitted bare unless it needs quoting. In block (`key:
 * value`) context the line runs to its end, so commas and colons are safe bare;
 * only empty/whitespace-edged values, embedded quotes/backslashes/control
 * characters, or values that would parse back as a number/bool/null are quoted.
 * In comma-delimited cell/inline context an embedded comma also forces quoting.
 * Quoting uses double quotes with `\\`, `\"`, `\n`, `\r`, `\t` escapes.
 */

/** A primitive TOON value. */
export type ToonScalar = string | number | boolean;

/** A TOON value node: a scalar, a nested object, a table, or an inline list. */
export type ToonValue =
    | { kind: "scalar"; value: ToonScalar }
    | { kind: "object"; fields: ToonField[] }
    | { kind: "table"; columns: string[]; rows: ToonScalar[][] }
    | { kind: "list"; items: string[] };

/** A keyed TOON field (the unit a document is an ordered list of). */
export interface ToonField {
    key: string;
    value: ToonValue;
}

/** Builds a field from a scalar or an already-constructed value node. */
export function field(key: string, value: ToonValue | ToonScalar): ToonField {
    if (typeof value === "object" && value !== null && "kind" in value) {
        return { key, value };
    }
    return { key, value: { kind: "scalar", value: value as ToonScalar } };
}

/** Builds an object value from its fields (the Go `toon.NewObject`). */
export function toonObject(fields: ToonField[]): ToonValue {
    return { kind: "object", fields };
}

/** Builds a tabular array field: `name[N]{columns}:` with one row per element. */
export function toonTable(name: string, columns: string[], rows: ToonScalar[][]): ToonField {
    return { key: name, value: { kind: "table", columns, rows } };
}

/** Builds a generic inline string-array field: `key[N]: a,b,c`. */
export function toonList(key: string, items: string[]): ToonField {
    return { key, value: { kind: "list", items } };
}

/** Builds the `help[N]:` inline list field used across every axi surface. */
export function toonHelp(lines: string[]): ToonField {
    return toonList("help", lines);
}

/** Reports whether a string would parse back as a number, bool, or null. */
function looksLikeLiteral(s: string): boolean {
    if (s === "true" || s === "false" || s === "null") return true;
    return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s);
}

/** Escapes and double-quotes a string for TOON output. */
function quote(s: string): string {
    const escaped = s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
    return `"${escaped}"`;
}

/**
 * Renders a scalar to its TOON text. `cell` selects comma-delimited (table/inline)
 * context, where an embedded comma additionally forces quoting.
 */
export function formatScalar(value: ToonScalar, cell: boolean): string {
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    const s = value;
    const needsQuote =
        s === "" ||
        /^\s|\s$/.test(s) ||
        /["\\\n\r\t]/.test(s) ||
        (cell && s.includes(",")) ||
        looksLikeLiteral(s);
    return needsQuote ? quote(s) : s;
}

/** Appends the rendered lines for one field at the given depth. */
function renderField(f: ToonField, depth: number, out: string[]): void {
    const pad = "  ".repeat(depth);
    const v = f.value;
    switch (v.kind) {
        case "scalar":
            out.push(`${pad}${f.key}: ${formatScalar(v.value, false)}`);
            return;
        case "object":
            out.push(`${pad}${f.key}:`);
            for (const child of v.fields) renderField(child, depth + 1, out);
            return;
        case "table": {
            out.push(`${pad}${f.key}[${v.rows.length}]{${v.columns.join(",")}}:`);
            const rowPad = "  ".repeat(depth + 1);
            for (const row of v.rows) {
                out.push(`${rowPad}${row.map(c => formatScalar(c, true)).join(",")}`);
            }
            return;
        }
        case "list":
            if (v.items.length === 0) {
                out.push(`${pad}${f.key}[0]:`);
                return;
            }
            out.push(`${pad}${f.key}[${v.items.length}]: ${v.items.map(s => formatScalar(s, true)).join(",")}`);
            return;
    }
}

/** Marshals a value node to TOON text without a trailing newline. */
export function marshalString(value: ToonValue): string {
    const out: string[] = [];
    if (value.kind === "object") {
        for (const f of value.fields) renderField(f, 0, out);
    } else {
        renderField({ key: "value", value }, 0, out);
    }
    return out.join("\n");
}

/** Marshals an ordered field list into a TOON document with a trailing newline. */
export function axiDoc(fields: ToonField[]): string {
    return `${marshalString(toonObject(fields))}\n`;
}
