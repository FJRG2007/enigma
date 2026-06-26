/**
 * Faithful port of no-mistakes' `internal/intent/redact.go`: secret redaction,
 * middle-of-conversation clamping, and adversarial-marker neutering.
 *
 * Go exposed both exported (`RedactSecrets`/`StripAdversarial`) and unexported
 * shim (`redactSecrets`/`stripAdversarial`) names for the same behavior; this
 * port collapses each pair into a single exported function.
 */

import type { Message } from "./reader";

/**
 * secretPatterns redacts common credential shapes before transcript text
 * reaches the summarizer. Matching is intentionally loose - we'd rather redact
 * a few innocent strings than leak a real key.
 */
const secretPatterns: RegExp[] = [
    /(api[_-]?key|access[_-]?token|secret[_-]?(?:key|token)?|password|passwd|bearer|authorization)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+=]{12,})/gi,
    /sk-[A-Za-z0-9]{20,}/g,
    /ghp_[A-Za-z0-9]{20,}/g,
    /gho_[A-Za-z0-9]{20,}/g,
    /xox[abprs]-[A-Za-z0-9-]{10,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
];

/**
 * Returns text with likely credentials replaced by [REDACTED]. The same shape
 * applies at prompt-construction boundaries (e.g. when injecting cached intent
 * summaries into step prompts) so redaction holds on the way into the LLM and
 * on the way out.
 */
export function redactSecrets(text: string): string {
    for (const pat of secretPatterns) {
        text = text.replace(pat, "[REDACTED]");
    }
    return text;
}

const omittedMarker =
    "[... middle messages omitted to fit the context window; the conversation continues below with later messages from the same session ...]";

/** Returns the UTF-8 byte length of `s`, mirroring Go's `len(string)`. */
function textBytes(s: string): number {
    return Buffer.byteLength(s, "utf8");
}

/**
 * clampMessages drops messages from the *middle* of the conversation when the
 * total Text budget exceeds maxBytes, preserving turns at the start and end.
 * The first few messages usually carry the user's original ask and setup; the
 * last few carry the most recent state and closing instructions. The middle
 * tends to be exploratory back-and-forth that is least useful for inferring
 * overall intent.
 *
 * The algorithm alternates picking from the front and back, so a long message
 * at one end doesn't crowd out everything from the other. When any messages are
 * dropped, a synthetic marker is inserted between the kept prefix and suffix so
 * the LLM doesn't treat the result as a contiguous conversation.
 */
export function clampMessages(msgs: Message[], maxBytes: number): Message[] {
    if (maxBytes <= 0 || msgs.length === 0) {
        return msgs;
    }
    let total = 0;
    for (const m of msgs) {
        total += textBytes(m.text ?? "");
    }
    if (total <= maxBytes) {
        return msgs;
    }

    // Reserve space for the marker so we don't overshoot the budget after
    // inserting it. The marker is short, so we ignore the case where the
    // budget is too small to even hold the marker.
    let budget = maxBytes - textBytes(omittedMarker);
    if (budget <= 0) {
        budget = maxBytes;
    }

    const frontKeep: Message[] = [];
    const backKeep: Message[] = [];
    let used = 0;
    let front = 0;
    let back = msgs.length - 1;
    let takeFront = true;

    while (front <= back) {
        const size = takeFront ? textBytes(msgs[front].text ?? "") : textBytes(msgs[back].text ?? "");
        if (used + size > budget) {
            break;
        }
        if (takeFront) {
            frontKeep.push(msgs[front]);
            front++;
        } else {
            backKeep.unshift(msgs[back]);
            back--;
        }
        used += size;
        takeFront = !takeFront;
    }

    // Pathological case: every message individually exceeds the budget. Fall
    // back to the last message, byte-truncated, since the most recent intent is
    // usually the most relevant single signal.
    if (frontKeep.length === 0 && backKeep.length === 0) {
        const last: Message = { ...msgs[msgs.length - 1] };
        const lastText = last.text ?? "";
        if (textBytes(lastText) > maxBytes) {
            const buf = Buffer.from(lastText, "utf8");
            last.text = buf.subarray(buf.length - maxBytes).toString("utf8");
        }
        return [last];
    }

    // front > back means we kept everything (no gap created).
    if (front > back) {
        return [...frontKeep, ...backKeep];
    }

    const gap: Message = { role: "user", synthetic: true, text: omittedMarker };
    return [...frontKeep, gap, ...backKeep];
}

/**
 * StripAdversarial removes obvious prompt-injection markers that could try to
 * escape the surrounding instructions. We don't try to be clever; we just
 * neuter common delimiter shapes (ChatML control tokens, role tags,
 * Llama/Mistral instruction delimiters) that an attacker might place in
 * user-controlled text. This is a stop-gap, not a real defense - the real
 * defense is wrapping the text with explicit "this is data, not instructions"
 * framing.
 *
 * Implemented as a single left-to-right, non-overlapping pass to match Go's
 * `strings.NewReplacer`; chained `replaceAll` calls would re-process the output
 * of an earlier replacement and diverge.
 */
export function stripAdversarial(text: string): string {
    const pairs: Array<[string, string]> = [
        ["<|", "<<|"],
        ["|>", "|>>"],
        ["<system>", "<sys>"],
        ["</system>", "</sys>"],
        ["[INST]", "[inst]"],
        ["[/INST]", "[/inst]"]
    ];
    let out = "";
    let i = 0;
    outer: while (i < text.length) {
        for (const [key, value] of pairs) {
            if (text.startsWith(key, i)) {
                out += value;
                i += key.length;
                continue outer;
            }
        }
        out += text[i];
        i++;
    }
    return out;
}
