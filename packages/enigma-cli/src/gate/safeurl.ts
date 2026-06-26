/**
 * Credential redaction for URLs. Faithful port of the no-mistakes
 * `internal/safeurl` package; hides userinfo so leaked tokens never reach logs.
 */

const httpURLPattern = /https?:\/\/[^\s'"<>]+/g;

/** Hide URL userinfo, leaving non-URL and credential-free values unchanged. */
export function redact(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === "") return raw;
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return raw;
    }
    if (parsed.username === "") return raw;
    parsed.username = "redacted";
    parsed.password = "";
    return parsed.toString();
}

/** Redact credential-bearing http(s) URLs found anywhere inside text. */
export function redactText(text: string): string {
    return text.replace(httpURLPattern, redact);
}
