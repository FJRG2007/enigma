/**
 * Server-Sent-Events parser shared by the opencode and rovodev backends.
 *
 * Faithful port of the Go `internal/agent/sse.go` line/event state machine:
 * multi-line `data:` fields, both `\n\n` and `\r\n\r\n` separators, single
 * leading-space trimming on field values, and stopping when the handler returns
 * false. Go's `bufio.Scanner` is mapped to a carry-buffer over an async byte
 * stream so it consumes a `fetch` response body directly.
 */

/** A parsed Server-Sent Event. */
export interface SSEEvent {
    /** event: field (empty if not specified). */
    name: string;
    /** Concatenated data: fields. */
    data: string;
}

/**
 * Reads SSE events from a byte/string stream and dispatches them to handler.
 * Stops when the stream is exhausted or the handler returns false.
 */
export async function parseSSE(
    source: AsyncIterable<Uint8Array | string>,
    handler: (event: SSEEvent) => boolean
): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    let name = "";
    let dataLines: string[] = [];
    let stopped = false;

    const flush = (): boolean => {
        if (dataLines.length === 0 && name === "") return true;
        const data = dataLines.join("\n");
        const cont = handler({ name, data });
        name = "";
        dataLines = [];
        return cont;
    };

    const processLine = (raw: string): boolean => {
        const line = raw.replace(/\r+$/, "");
        if (line === "") return flush();
        if (line.startsWith("event:")) {
            name = trimOneLeadingSpace(line.slice(6));
        } else if (line.startsWith("data:")) {
            dataLines.push(trimOneLeadingSpace(line.slice(5)));
        }
        return true;
    };

    for await (const chunk of source) {
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (!processLine(raw)) {
                stopped = true;
                break;
            }
        }
        if (stopped) break;
    }

    if (!stopped) {
        buffer += decoder.decode();
        if (buffer !== "") processLine(buffer);
        flush();
    }
}

function trimOneLeadingSpace(value: string): string {
    return value.startsWith(" ") ? value.slice(1) : value;
}
