/**
 * Log compression by templating. Volatile tokens (timestamps, numbers, hex/UUIDs,
 * IPs) are masked to derive each line's template; runs of lines sharing a template
 * collapse into one representative plus a repeat count. Error/warning lines are
 * always kept verbatim - they are the reason anyone reads logs. The full original
 * is recoverable via CCR (see index.ts).
 */

const ERROR_LINE = /\b(ERROR|WARN|WARNING|FATAL|CRITICAL|EXCEPTION|TRACEBACK|PANIC)\b/;

/** Reduce a line to its structural template by masking volatile substrings. */
function template(line: string): string {
    return line
        .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<TS>")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>")
        .replace(/\b0x[0-9a-f]+\b/gi, "<HEX>")
        .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<IP>")
        .replace(/\b\d+\b/g, "<N>");
}

/** Collapse repeated log lines; returns the compressed text and how many lines were dropped. */
export function crushLogs(content: string): { compressed: string; offloaded: number; } {
    const lines = content.split("\n");
    if (lines.length < 6) return { compressed: content, offloaded: 0 };

    const out: string[] = [];
    let offloaded = 0;
    let runTemplate: string | null = null;
    let runFirst = "";
    let runCount = 0;

    const flush = () => {
        if (runCount === 0) return;
        out.push(runFirst);
        if (runCount > 1) {
            out.push(`    ... (${runCount - 1} more similar line${runCount - 1 === 1 ? "" : "s"})`);
            offloaded += runCount - 1;
        }
        runTemplate = null; runCount = 0;
    };

    for (const line of lines) {
        // Keep error/warning lines verbatim, breaking any active run.
        if (ERROR_LINE.test(line)) { flush(); out.push(line); continue; }
        const tpl = template(line);
        if (tpl === runTemplate) { runCount++; continue; }
        flush();
        runTemplate = tpl; runFirst = line; runCount = 1;
    }
    flush();

    if (offloaded === 0) return { compressed: content, offloaded: 0 };
    return { compressed: out.join("\n"), offloaded };
}
