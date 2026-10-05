/**
 * Read a JS/TS config file's exported object WITHOUT executing it.
 *
 * Tailwind configs and design-token modules are code, and the obvious way to read them
 * is to run them. That is exactly what this must never do: `enigma design --repo` points
 * at a repository the user does not own, and evaluating its `tailwind.config.js` would
 * run arbitrary code from it on their machine. So the exported object literal is parsed
 * statically instead. Literals (strings, numbers, booleans, arrays, objects) come back
 * as values, a bare identifier resolves to a top-level `const` holding a literal, and
 * everything that would need evaluation (calls, spreads, functions, template
 * interpolations, member expressions) is dropped rather than guessed.
 */

export type LiteralValue = string | number | boolean | null | LiteralValue[] | { [key: string]: LiteralValue; };

/** Marks an expression that cannot be read without running code. */
const UNRESOLVED = Symbol("unresolved");
type Parsed = LiteralValue | typeof UNRESOLVED;

const OPEN: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

class Reader {
    pos = 0;
    private resolving = new Set<string>();

    constructor(private readonly src: string, private readonly consts: Map<string, number>) {}

    /** Skip whitespace and comments. */
    skip(): void {
        for (;;) {
            const ch = this.src[this.pos];
            if (ch === undefined) return;
            if (/\s/.test(ch)) { this.pos++; continue; }
            if (ch === "/" && this.src[this.pos + 1] === "/") {
                const end = this.src.indexOf("\n", this.pos);
                this.pos = end === -1 ? this.src.length : end;
                continue;
            }
            if (ch === "/" && this.src[this.pos + 1] === "*") {
                const end = this.src.indexOf("*/", this.pos + 2);
                this.pos = end === -1 ? this.src.length : end + 2;
                continue;
            }
            return;
        }
    }

    peek(): string | undefined {
        this.skip();
        return this.src[this.pos];
    }

    private readString(quote: string): string | typeof UNRESOLVED {
        let out = "";
        let interpolated = false;
        this.pos++;
        while (this.pos < this.src.length) {
            const ch = this.src[this.pos]!;
            if (ch === "\\") { out += this.src[this.pos + 1] ?? ""; this.pos += 2; continue; }
            if (ch === quote) { this.pos++; return interpolated ? UNRESOLVED : out; }
            if (quote === "`" && ch === "$" && this.src[this.pos + 1] === "{") {
                interpolated = true;
                this.pos++;
                this.skipBalanced();
                continue;
            }
            out += ch;
            this.pos++;
        }
        return UNRESOLVED;
    }

    /** Skip one bracketed group starting at the current opener, honoring strings and comments. */
    private skipBalanced(): void {
        const stack: string[] = [];
        while (this.pos < this.src.length) {
            this.skip();
            const ch = this.src[this.pos];
            if (ch === undefined) return;
            if (ch === "\"" || ch === "'" || ch === "`") { this.readString(ch); continue; }
            if (OPEN[ch]) { stack.push(OPEN[ch]!); this.pos++; continue; }
            if (ch === stack[stack.length - 1]) { stack.pop(); this.pos++; if (!stack.length) return; continue; }
            this.pos++;
            if (!stack.length) return;
        }
    }

    /** Skip the rest of an expression up to (not including) a `,` `}` `]` `)` at this depth. */
    skipExpression(): void {
        while (this.pos < this.src.length) {
            this.skip();
            const ch = this.src[this.pos];
            if (ch === undefined || ch === "," || ch === "}" || ch === "]" || ch === ")" || ch === ";") return;
            if (ch === "\"" || ch === "'" || ch === "`") { this.readString(ch); continue; }
            if (OPEN[ch]) { this.skipBalanced(); continue; }
            this.pos++;
        }
    }

    private readIdentifier(): string {
        const m = this.src.slice(this.pos).match(/^[A-Za-z_$][\w$]*/);
        if (!m) return "";
        this.pos += m[0].length;
        return m[0];
    }

    value(): Parsed {
        const ch = this.peek();
        if (ch === undefined) return UNRESOLVED;
        let parsed: Parsed = UNRESOLVED;
        if (ch === "{") parsed = this.object();
        else if (ch === "[") parsed = this.array();
        else if (ch === "\"" || ch === "'" || ch === "`") parsed = this.readString(ch);
        else if (/[-\d.]/.test(ch)) {
            const m = this.src.slice(this.pos).match(/^-?(?:\d[\d_]*\.?\d*(?:e[-+]?\d+)?|\.\d+)/i);
            if (m) { this.pos += m[0].length; parsed = Number(m[0].replace(/_/g, "")); }
        } else if (/[A-Za-z_$]/.test(ch)) {
            const start = this.pos;
            const id = this.readIdentifier();
            this.skip();
            const next = this.src[this.pos];
            if (id === "true" || id === "false") parsed = id === "true";
            else if (id === "null") parsed = null;
            // A bare identifier (not a call, member access or arrow) may name a top-level literal.
            else if (next !== "(" && next !== "." && next !== "=" && next !== "[") parsed = this.resolveConst(id);
            else this.pos = start;
        }
        this.skipExpression();
        return parsed;
    }

    private resolveConst(name: string): Parsed {
        const at = this.consts.get(name);
        if (at === undefined || this.resolving.has(name)) return UNRESOLVED;
        this.resolving.add(name);
        const saved = this.pos;
        this.pos = at;
        const parsed = this.value();
        this.pos = saved;
        this.resolving.delete(name);
        return parsed;
    }

    private array(): Parsed {
        const out: LiteralValue[] = [];
        this.pos++;
        for (;;) {
            const ch = this.peek();
            if (ch === undefined) return out;
            if (ch === "]") { this.pos++; return out; }
            if (ch === ",") { this.pos++; continue; }
            if (this.src.startsWith("...", this.pos)) { this.pos += 3; this.value(); continue; }
            const item = this.value();
            if (item !== UNRESOLVED) out.push(item);
            if (this.peek() === ",") this.pos++;
            else if (this.peek() !== "]") this.pos++;
        }
    }

    private object(): Parsed {
        const out: Record<string, LiteralValue> = {};
        this.pos++;
        for (;;) {
            const ch = this.peek();
            if (ch === undefined) return out;
            if (ch === "}") { this.pos++; return out; }
            if (ch === ",") { this.pos++; continue; }
            if (this.src.startsWith("...", this.pos)) { this.pos += 3; this.value(); continue; }
            let key: string | null = null;
            if (ch === "\"" || ch === "'") {
                const k = this.readString(ch);
                key = k === UNRESOLVED ? null : k;
            } else if (ch === "[") {
                this.skipBalanced();
            } else if (/[\w$]/.test(ch)) {
                // An identifier key, or a numeric one (`50: "#f8fafc"` in a color scale).
                const m = this.src.slice(this.pos).match(/^(?:[A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/);
                key = m ? m[0] : null;
                this.pos += m ? m[0].length : 1;
            } else {
                this.pos++;
                continue;
            }
            const sep = this.peek();
            if (sep === ":") {
                this.pos++;
                const v = this.value();
                if (key !== null && v !== UNRESOLVED) out[key] = v;
            } else if (sep === "(") {
                // A method: `foo() { ... }`.
                this.skipBalanced();
                if (this.peek() === "{") this.skipBalanced();
            } else if (key !== null && (sep === "," || sep === "}")) {
                // Shorthand `{ colors }`: resolvable only through a top-level literal.
                const v = this.resolveConst(key);
                if (v !== UNRESOLVED) out[key] = v;
            } else {
                this.skipExpression();
            }
        }
    }
}

/** Offsets of every top-level `const|let|var name = <value>` (value start), by name. */
function topLevelConsts(src: string): Map<string, number> {
    const consts = new Map<string, number>();
    for (const m of src.matchAll(/(?:^|[;\n])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*/g)) {
        if (!consts.has(m[1]!)) consts.set(m[1]!, m.index! + m[0].length);
    }
    return consts;
}

/**
 * The object a config module exports - `module.exports = {...}`, `export default {...}`,
 * `export default defineConfig({...})`, or `export default <name>` where `<name>` is a
 * top-level literal - or null when there is no statically readable export.
 */
export function readExportedObject(source: string): Record<string, LiteralValue> | null {
    const consts = topLevelConsts(source);
    const patterns = [
        /module\.exports\s*=\s*(?:[\w$.]+\s*\(\s*)?/,
        /export\s+default\s+(?:[\w$.]+\s*\(\s*)?/,
    ];
    for (const pattern of patterns) {
        const m = pattern.exec(source);
        if (!m) continue;
        const reader = new Reader(source, consts);
        reader.pos = m.index + m[0].length;
        const parsed = reader.value();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, LiteralValue>;
    }
    return null;
}

/**
 * Every top-level literal binding in a module (`export const colors = {...}` and plain
 * consts), for token modules that export named objects instead of a default one.
 */
export function readTopLevelLiterals(source: string): Record<string, LiteralValue> {
    const consts = topLevelConsts(source);
    const out: Record<string, LiteralValue> = {};
    for (const [name, at] of consts) {
        const reader = new Reader(source, consts);
        reader.pos = at;
        const parsed = reader.value();
        if (parsed !== UNRESOLVED) out[name] = parsed;
    }
    return out;
}
