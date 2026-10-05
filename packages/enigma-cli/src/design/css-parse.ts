/**
 * A tolerant CSS walker: reports every declaration (`prop: value`) and every at-rule
 * prelude in a stylesheet, at any nesting depth (media queries, supports blocks, CSS
 * nesting, SCSS/LESS rule nesting).
 *
 * It replaces a full CSS AST library because extraction only ever needs those two
 * things, and a walker that never throws is worth more here than a parser that rejects
 * the first SCSS-ism or minifier quirk: a scan of real-world stylesheets meets both all
 * the time. Strings, comments and parentheses are tracked so a `;` inside
 * `url(data:...)` or a quoted font name never splits a declaration.
 */

export interface CssWalker {
    /** A declaration; `value` has `!important` removed and whitespace collapsed. */
    declaration?: (property: string, value: string) => void;
    /** An at-rule (`@media`, `@import`, ...); `prelude` is everything before its `{` or `;`. */
    atRule?: (name: string, prelude: string) => void;
}

export interface CssWalkOptions {
    /** Treat `//` as a line comment (SCSS and LESS); off for plain CSS, where it is not one. */
    lineComments?: boolean;
}

function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function emitStatement(buffer: string, inBlock: boolean, walker: CssWalker): void {
    const text = buffer.trim();
    if (!text) return;
    // `@name: value` is a LESS variable, not an at-rule.
    if (text.startsWith("@") && !/^@[\w-]+\s*:/.test(text)) {
        const m = text.match(/^@([\w-]+)\s*([\s\S]*)$/);
        if (m) walker.atRule?.(m[1]!.toLowerCase(), collapse(m[2]!));
        return;
    }
    const colon = text.indexOf(":");
    if (colon <= 0) return;
    const property = text.slice(0, colon).trim();
    // Outside a block only preprocessor variables (`$x`, `@x`) are declarations.
    if (!inBlock && !/^[$@]/.test(property)) return;
    // A property is an identifier (custom properties and SCSS/LESS variables included);
    // anything else that reached here is a stray selector fragment, not a declaration.
    if (!/^(--|[$@])?-?[A-Za-z_][\w-]*$/.test(property)) return;
    const value = collapse(text.slice(colon + 1).replace(/!\s*important\s*$/i, ""));
    walker.declaration?.(property.startsWith("--") ? property : property.toLowerCase(), value);
}

/** Walk `css`, calling the walker for each declaration and at-rule. Never throws. */
export function walkCss(css: string, walker: CssWalker, options: CssWalkOptions = {}): void {
    let buffer = "";
    let depth = 0;
    let parens = 0;
    let quote: string | null = null;
    for (let i = 0; i < css.length; i++) {
        const ch = css[i]!;
        if (quote) {
            buffer += ch;
            if (ch === "\\" && i + 1 < css.length) { buffer += css[++i]; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "/" && css[i + 1] === "*") {
            const end = css.indexOf("*/", i + 2);
            i = end === -1 ? css.length : end + 1;
            continue;
        }
        if (options.lineComments && parens === 0 && ch === "/" && css[i + 1] === "/" && css[i - 1] !== ":") {
            const end = css.indexOf("\n", i);
            i = end === -1 ? css.length : end - 1;
            continue;
        }
        if (ch === "\"" || ch === "'") { quote = ch; buffer += ch; continue; }
        if (ch === "(") { parens++; buffer += ch; continue; }
        if (ch === ")") { parens = Math.max(0, parens - 1); buffer += ch; continue; }
        if (parens > 0) { buffer += ch; continue; }
        if (ch === "{") {
            const prelude = buffer.trim();
            if (prelude.startsWith("@")) emitStatement(prelude, depth > 0, walker);
            buffer = "";
            depth++;
            continue;
        }
        if (ch === ";") { emitStatement(buffer, depth > 0, walker); buffer = ""; continue; }
        if (ch === "}") {
            emitStatement(buffer, depth > 0, walker);
            buffer = "";
            depth = Math.max(0, depth - 1);
            continue;
        }
        buffer += ch;
    }
    emitStatement(buffer, depth > 0, walker);
}
