/**
 * Heuristic content-type detection for compression routing. Dependency-free: the
 * upstream design uses an ML model (Magika) for this, but a small set of robust
 * rules covers the content that actually reaches a coding agent (JSON tool
 * outputs, logs, diffs, code, prose) without an ONNX runtime. JSON is confirmed
 * by an actual parse, so it is never guessed wrong.
 *
 * "shell" is never returned here: command output is identified by the command that
 * produced it, not by its shape (see ./shell), so only compress() assigns that type.
 */

export type ContentType = "json" | "code" | "log" | "diff" | "markdown" | "shell" | "text" | "unknown";

export interface Detection {
    type: ContentType;
    confidence: number;
}

const CODE_INDICATORS = [
    "def ", "class ", "function ", "import ", "export ", "const ", "let ", "var ",
    "func ", "fn ", "pub ", "package ", "#include", "public ", "private ",
];
const LOG_LEVELS = /\b(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL|CRITICAL)\b/;
const TIMESTAMP_LINE = /^\s*(\[)?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/m;

/** True when `content` is a diff/patch (git or unified). */
function looksLikeDiff(content: string): boolean {
    if (/^diff --git /m.test(content) || /^@@ -\d/m.test(content)) return true;
    if (/^--- /m.test(content) && /^\+\+\+ /m.test(content)) return true;
    // Many lines starting with +/- (but not ++/-- headers) signal a patch body.
    const lines = content.split("\n");
    const marks = lines.filter((l) => /^[+-][^+-]/.test(l)).length;
    return lines.length >= 6 && marks / lines.length > 0.3;
}

/** Detect the content type of `content` via cheap, ordered heuristics. */
export function detect(content: string): Detection {
    if (!content || !content.trim()) return { type: "unknown", confidence: 0 };
    const stripped = content.trim();

    // JSON: confirmed by a real parse so it is authoritative.
    if (stripped.startsWith("{") || stripped.startsWith("[")) try { JSON.parse(stripped); return { type: "json", confidence: 1 }; } catch { /* not JSON */ }
    if (looksLikeDiff(content)) return { type: "diff", confidence: 0.8 };
    // Logs: a timestamped line or a recognizable level token, common in tool output.
    if (TIMESTAMP_LINE.test(content) || LOG_LEVELS.test(content)) return { type: "log", confidence: 0.7 };
    if (CODE_INDICATORS.some((i) => content.includes(i))) return { type: "code", confidence: 0.7 };
    if (/^\s{0,3}#{1,6}\s/m.test(content) || /^\s*[-*]\s+/m.test(stripped)) return { type: "markdown", confidence: 0.6 };
    return { type: "text", confidence: 0.5 };
}
