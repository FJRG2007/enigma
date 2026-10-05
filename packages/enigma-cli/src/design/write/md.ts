/**
 * Markdown helpers for text that came from a third-party site or repository.
 *
 * Everything the writers embed - class names, labels, titles, CSS values, HTML samples -
 * was authored by someone else, and the result is loaded into a coding agent's context
 * as a skill. Each value is therefore kept inside the construct it was put in: an
 * inline value cannot close its code span or start a new line, and a sample block uses a
 * fence longer than any backtick run inside it, so nothing extracted can turn into
 * markdown structure (a heading, a link, an instruction-looking paragraph).
 */

/** One line of plain text: whitespace collapsed, capped, markdown-active characters escaped. */
export function text(value: string, max = 120): string {
    return value.replace(/\s+/g, " ").trim().slice(0, max).replace(/([\\`*_[\]<>|#])/g, "\\$1");
}

/** An inline code span that cannot be broken out of. */
export function code(value: string, max = 200): string {
    const flat = value.replace(/\s+/g, " ").trim().slice(0, max);
    const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
    const ticks = "`".repeat(longest + 1);
    const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
    return `${ticks}${pad}${flat}${pad}${ticks}`;
}

/** A fenced block whose fence is longer than any backtick run in `body`. */
export function fenced(lang: string, body: string): string {
    const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    return `${fence}${lang}\n${body.replace(/\s+$/, "")}\n${fence}\n`;
}

/** A markdown image whose alt text and path are inert. */
export function image(alt: string, path: string): string {
    return `![${text(alt, 80)}](${encodeURI(path).replace(/[()]/g, (c) => encodeURIComponent(c))})`;
}

/** Ensure exactly one trailing newline. */
export function finish(md: string): string {
    return `${md.replace(/\s+$/, "")}\n`;
}
