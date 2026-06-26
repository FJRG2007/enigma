/**
 * Agent interface plus structured-output parsing for the gate pipeline.
 *
 * Faithful 1:1 port of the CORE of the Go `internal/agent/agent.go`: the Agent
 * interface, RunOpts/Result/TokenUsage/Options, and the text -> structured-JSON
 * extraction + validation chain (finalizeTextResult, parseStructuredTextOutput,
 * fenced/bare JSON candidate scanning, and a minimal inline JSON Schema check).
 *
 * Divergences from the Go original (all intentional):
 * - JSONSchema is a parsed JSON value (`unknown`) instead of `json.RawMessage`
 *   raw bytes, matching the rest of the gate package which carries parsed JSON.
 *   "no schema" is `undefined`/`null` (Go's `len(schema) == 0`); an empty object
 *   `{}` is still a real schema that accepts anything.
 * - The validator is a zero-dependency inline subset (no ajv): it checks `enum`,
 *   `type` (object/array/string/integer/number/boolean/null and unions), object
 *   `required`, `additionalProperties: false`, nested `properties`, and array
 *   `items` - exactly the subset the Go validator implements for these findings
 *   schemas. Integer-ness is checked with `Number.isInteger`, so integers beyond
 *   `Number.MAX_SAFE_INTEGER` lose the precision Go's `json.Number` would keep.
 * - The backend factory (`New`/`NewWithOptions`/`acpTarget`) is intentionally
 *   omitted: it constructs per-agent backends (claude/codex/opencode/...) that
 *   land in a later phase. The generic no-op agent is kept as a reference impl.
 */

/** Runs a single AI agent task and returns its structured/text output. */
export interface Agent {
    name(): string;
    run(opts: RunOpts, signal?: AbortSignal): Promise<Result>;
    close(): Promise<void>;
}

/** Configures a single agent invocation. */
export interface RunOpts {
    /** Prompt handed to the agent. */
    prompt: string;
    /** Working directory the agent runs in. */
    cwd: string;
    /** Parsed JSON Schema for structured output; absent disables validation. */
    jsonSchema?: unknown;
    /** Streaming text callback invoked with incremental output. */
    onChunk?: (text: string) => void;
}

/** Holds the output of an agent invocation. */
export interface Result {
    /**
     * Structured JSON returned by the agent (parsed). Text-parsed fallback
     * results are validated before return; optional fields may be nullable.
     * Absent for plain-text results with no schema.
     */
    output?: unknown;
    /** Raw text output. */
    text: string;
    /** Token consumption for the invocation. */
    usage: TokenUsage;
}

/** Tracks token consumption for an agent invocation. */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
}

/**
 * Configures backend-specific agent construction.
 * `acpRegistryOverrides` maps acpx target names to raw ACP agent commands.
 */
export interface Options {
    acpRegistryOverrides?: Record<string, string>;
}

/** Returns input + output tokens (the billing-relevant total). */
export function totalTokens(u: TokenUsage): number {
    return u.inputTokens + u.outputTokens;
}

/** Accumulates another usage into `into` (mutates `into`). */
export function addTokenUsage(into: TokenUsage, other: TokenUsage): void {
    into.inputTokens += other.inputTokens;
    into.outputTokens += other.outputTokens;
    into.cacheReadTokens += other.cacheReadTokens;
    into.cacheCreationTokens += other.cacheCreationTokens;
}

/** Returns a fresh zeroed TokenUsage. */
export function emptyTokenUsage(): TokenUsage {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

/**
 * Builds a Result from raw agent text. With no schema the text is returned
 * verbatim; otherwise the text is parsed into validated structured output.
 * Throws when the text is empty or no candidate satisfies the schema.
 */
export function finalizeTextResult(
    agentName: string,
    text: string,
    schema: unknown,
    usage: TokenUsage
): Result {
    if (text === "") throw new Error(`${agentName} returned no text output`);
    if (schema === undefined || schema === null) return { text, usage };

    let output: unknown;
    try {
        output = parseStructuredTextOutput(text, schema);
    } catch (err) {
        throw new Error(`${agentName} output parse: ${errMessage(err)}`);
    }
    return { output, text, usage };
}

/**
 * Extracts validated structured JSON from agent text. Tries the whole text,
 * then ```json fences, then the last bare balanced `{...}` object. Throws if
 * none parse, and if multiple distinct JSON fences are present.
 */
export function parseStructuredTextOutput(text: string, schema: unknown): unknown {
    const validationSchema = textValidationSchema(schema);

    let rawErr: unknown;
    try {
        return parseStructuredCandidate(text, validationSchema);
    } catch (err) {
        rawErr = err;
    }

    const candidates = fencedJSONCandidates(text);
    const parsed: unknown[] = [];
    let candidateErr: unknown;
    for (const candidate of candidates) {
        try {
            parsed.push(parseStructuredCandidate(candidate, validationSchema));
        } catch (err) {
            if (candidateErr === undefined) candidateErr = err;
        }
    }
    if (parsed.length === 1) return parsed[0];
    if (parsed.length > 1) throw new Error("multiple JSON code fences found in output");

    try {
        const bare = lastBareJSONObject(text, validationSchema);
        if (bare !== undefined) return bare;
    } catch (err) {
        if (candidateErr === undefined) candidateErr = err;
    }

    if (candidateErr !== undefined) throw candidateErr;
    throw rawErr;
}

/**
 * Clones a schema and relaxes optional fields to also accept null, so a model
 * that emits `null` for an absent optional field still validates. Returns
 * `undefined` when there is no schema.
 */
export function textValidationSchema(schema: unknown): unknown {
    if (schema === undefined || schema === null) return undefined;
    const value = JSON.parse(JSON.stringify(schema));
    allowOptionalSchemaNulls(value);
    return value;
}

/**
 * Extracts JSON bodies from ```json ... ``` fences. Fence markers may appear
 * anywhere in the text, including glued to the end of a preceding line (e.g.
 * "...behavior.```json"), a shape real codex/GPT-5 output regularly produces.
 */
export function fencedJSONCandidates(text: string): string[] {
    const candidates: string[] = [];
    let rest = text;
    for (;;) {
        const start = indexJSONFenceOpen(rest);
        if (start < 0) return candidates;
        const body = rest.slice(start);
        const [end, next] = indexJSONFenceClose(body);
        if (end < 0) return candidates;
        candidates.push(body.slice(0, end));
        rest = body.slice(next);
    }
}

/**
 * Scans text for balanced `{...}` substrings that parse as JSON and returns the
 * last one. Handles models that emit reasoning prose followed by a raw JSON
 * answer with no code fence. Returns `undefined` when none are found; throws the
 * first parse/validation error when candidates existed but all failed.
 */
export function lastBareJSONObject(text: string, schema: unknown): unknown | undefined {
    let last: unknown;
    let found = false;
    let lastErr: unknown;
    for (let i = 0; i < text.length; i++) {
        if (text.startsWith("```", i)) {
            const [contentStart] = fenceContentStart(text, i);
            const next = skipFenceBlock(text.slice(contentStart));
            if (next < 0) break;
            i = contentStart + next - 1;
            continue;
        }
        if (text[i] !== "{") continue;
        const [end, ok] = scanBalancedObject(text, i);
        if (!ok) continue;
        const candidate = text.slice(i, end);
        try {
            last = parseStructuredCandidate(candidate, schema);
            found = true;
            lastErr = undefined;
        } catch (err) {
            if (lastErr === undefined) lastErr = err;
        }
        i = end - 1;
    }
    if (found) return last;
    if (lastErr !== undefined) throw lastErr;
    return undefined;
}

/** Parses a candidate string into JSON and validates it against `schema`. */
export function parseStructuredCandidate(candidate: string, schema: unknown): unknown {
    const output = JSON.parse(candidate);
    validateStructuredOutput(output, schema);
    return output;
}

// indexJSONFenceOpen returns the offset of the content immediately following an
// opening ```json fence (the char after the info line's newline), or -1.
function indexJSONFenceOpen(text: string): number {
    for (let searchStart = 0; searchStart < text.length; ) {
        const found = text.slice(searchStart).indexOf("```");
        if (found < 0) return -1;
        const i = found + searchStart;
        const [contentStart, info] = fenceContentStart(text, i);
        if (info.trim().toLowerCase() === "json") return contentStart;
        const next = skipFenceBlock(text.slice(contentStart));
        if (next < 0) return -1;
        searchStart = contentStart + next;
    }
    return -1;
}

function fenceContentStart(text: string, fenceStart: number): [number, string] {
    const after = text.slice(fenceStart + 3);
    const lineEnd = after.indexOf("\n");
    if (lineEnd < 0) return [fenceStart + 3 + after.length, after];
    return [fenceStart + 3 + lineEnd + 1, after.slice(0, lineEnd)];
}

function skipFenceBlock(text: string): number {
    let depth = 1;
    for (let lineStart = 0; lineStart < text.length; ) {
        let lineEnd = text.slice(lineStart).indexOf("\n");
        if (lineEnd < 0) lineEnd = text.length;
        else lineEnd += lineStart;
        const line = text.slice(lineStart, lineEnd);
        const trimmed = line.replace(/^[ \t]+/, "");
        if (trimmed.startsWith("```")) {
            if (trimmed.slice(3).trim() === "") {
                depth--;
                if (depth === 0) return lineStart + (line.length - trimmed.length) + 3;
            } else {
                depth++;
            }
        }
        if (lineEnd === text.length) break;
        lineStart = lineEnd + 1;
    }
    return -1;
}

function indexJSONFenceClose(text: string): [number, number] {
    for (let lineStart = 0; lineStart < text.length; ) {
        let lineEnd = text.slice(lineStart).indexOf("\n");
        if (lineEnd < 0) lineEnd = text.length;
        else lineEnd += lineStart;
        const line = text.slice(lineStart, lineEnd);
        const trimmed = line.replace(/^[ \t]+/, "");
        if (trimmed.startsWith("```")) {
            const indent = line.length - trimmed.length;
            return [lineStart, lineStart + indent + 3];
        }
        if (lineEnd === text.length) break;
        lineStart = lineEnd + 1;
    }
    const trimmed = text.replace(/[ \t\r\n]+$/, "");
    if (trimmed.endsWith("```")) return [trimmed.length - 3, trimmed.length];
    return [-1, -1];
}

// scanBalancedObject returns the exclusive end index of a brace-balanced
// substring starting at text[start] === '{', or [0, false] if no balanced close
// exists. JSON string literals are respected so braces inside strings do not
// affect the depth count.
function scanBalancedObject(text: string, start: number): [number, boolean] {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escape) {
                escape = false;
                continue;
            }
            if (c === "\\") escape = true;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return [i + 1, true];
        }
    }
    return [0, false];
}

function validateStructuredOutput(value: unknown, schema: unknown): void {
    if (schema === undefined || schema === null) return;
    try {
        validateJSONValue(value, schema, "");
    } catch (err) {
        throw new Error(`JSON output ${errMessage(err)}`);
    }
}

function allowOptionalSchemaNulls(value: unknown): void {
    const schema = asObject(value);
    if (!schema) return;

    const required = requiredSet(schema);
    const properties = asObject(schema.properties);
    if (properties) {
        for (const [name, property] of Object.entries(properties)) {
            allowOptionalSchemaNulls(property);
            if (!required.has(name)) allowSchemaNull(property);
        }
    }
    if (hasOwn(schema, "items")) allowOptionalSchemaNulls(schema.items);
}

function requiredSet(schema: Record<string, unknown>): Set<string> {
    const required = new Set<string>();
    const items = schema.required;
    if (Array.isArray(items)) {
        for (const item of items) if (typeof item === "string") required.add(item);
    }
    return required;
}

function allowSchemaNull(value: unknown): void {
    const schema = asObject(value);
    if (!schema) return;

    const enumValues = schema.enum;
    if (Array.isArray(enumValues) && !enumValues.includes(null)) {
        schema.enum = [...enumValues, null];
    }
    const typ = schema.type;
    if (typeof typ === "string") {
        if (typ !== "null") schema.type = [typ, "null"];
    } else if (Array.isArray(typ)) {
        if (!typ.includes("null")) schema.type = [...typ, "null"];
    }
}

function validateJSONValue(value: unknown, schema: unknown, path: string): void {
    const schemaMap = asObject(schema);
    if (!schemaMap) return;

    const enumValues = schemaMap.enum;
    if (Array.isArray(enumValues) && !matchesEnum(value, enumValues)) {
        throw new Error(`${formatJSONPath(path)}must match one of the allowed values`);
    }

    const types = schemaTypes(schemaMap);
    if (types && !matchesAnyType(value, types)) {
        throw new Error(`${formatJSONPath(path)}must be ${types.join(" or ")}`);
    }

    const object = asObject(value);
    if (object) validateJSONObject(object, schemaMap, path);
    if (Array.isArray(value)) validateJSONArray(value, schemaMap, path);
}

function validateJSONObject(
    object: Record<string, unknown>,
    schema: Record<string, unknown>,
    path: string
): void {
    const required = stringSlice(schema.required);
    for (const key of required) {
        if (!hasOwn(object, key)) {
            throw new Error(`${formatJSONPath(path)}missing required field ${JSON.stringify(key)}`);
        }
    }

    const properties = asObject(schema.properties);
    if (schema.additionalProperties === false) {
        for (const key of Object.keys(object)) {
            if (!properties || !hasOwn(properties, key)) {
                throw new Error(`${formatJSONPath(path)}contains unknown field ${JSON.stringify(key)}`);
            }
        }
    }

    if (properties) {
        for (const [key, propSchema] of Object.entries(properties)) {
            if (!hasOwn(object, key)) continue;
            validateJSONValue(object[key], propSchema, joinJSONPath(path, key));
        }
    }
}

function validateJSONArray(array: unknown[], schema: Record<string, unknown>, path: string): void {
    if (!hasOwn(schema, "items")) return;
    const itemsSchema = schema.items;
    array.forEach((item, i) => {
        validateJSONValue(item, itemsSchema, `${path}[${i}]`);
    });
}

function schemaTypes(schema: Record<string, unknown>): string[] | undefined {
    const raw = schema.type;
    if (typeof raw === "string") return [raw];
    if (Array.isArray(raw)) {
        const types = stringSlice(raw);
        return types.length > 0 ? types : undefined;
    }
    return undefined;
}

function stringSlice(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) if (typeof item === "string") out.push(item);
    return out;
}

function matchesAnyType(value: unknown, types: string[]): boolean {
    return types.some(typ => matchesType(value, typ));
}

function matchesType(value: unknown, typ: string): boolean {
    switch (typ) {
        case "object":
            return asObject(value) !== undefined;
        case "array":
            return Array.isArray(value);
        case "string":
            return typeof value === "string";
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "number":
            return typeof value === "number";
        case "boolean":
            return typeof value === "boolean";
        case "null":
            return value === null;
        default:
            return true;
    }
}

function matchesEnum(value: unknown, allowed: unknown[]): boolean {
    const valueJSON = JSON.stringify(value);
    for (const candidate of allowed) {
        if (JSON.stringify(candidate) === valueJSON) return true;
    }
    return false;
}

function joinJSONPath(path: string, key: string): string {
    return path === "" ? key : `${path}.${key}`;
}

function formatJSONPath(path: string): string {
    return path === "" ? "" : `${path} `;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function hasOwn(object: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Returns an agent that does nothing. Used for demo mode where mock steps drive
 * all logic without calling a real agent.
 */
export function createNoopAgent(): Agent {
    return {
        name: () => "noop",
        run: async () => ({ text: "", usage: emptyTokenUsage() }),
        close: async () => {}
    };
}
