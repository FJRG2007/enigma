/**
 * Right-sizing a run to the change it is validating.
 *
 * The pipeline is nine steps and the same nine ran whatever the diff was, so adding a
 * line to a slash command bought a full review with fix rounds, a test suite that
 * tested nothing new, and a documentation pass over a documentation change. That is
 * not caution, it is the gate charging for work it cannot possibly do: there is no
 * code in the diff for `test` to exercise, and `document` is being asked whether a
 * documentation change needs documenting.
 *
 * So the skip is decided from WHAT THE DIFF TOUCHES, never from how big it is. Size is
 * the wrong axis and a dangerous one - a three-line change to an auth check deserves
 * every step the pipeline has. File class is not: a change with no executable file in
 * it cannot break a test, and that is a fact about the diff rather than a judgement
 * about the work.
 *
 * The steps that CAN say something are always kept. `review` runs on a prose-only
 * change because prose can be wrong, and `push`/`pr`/`ci` are how the work ships.
 */

import { type StepName } from "../types";

/**
 * Extensions of files a test suite or a compiler acts on. Deliberately generous: a
 * language missing from this list is treated as CODE (see `isCode`), so the gate
 * over-runs rather than under-runs on anything unfamiliar.
 */
const CODE_EXTENSIONS = new Set([
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro",
    "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "scala", "swift", "m", "mm",
    "c", "h", "cc", "cpp", "hpp", "cs", "php", "ex", "exs", "erl", "clj", "cljs",
    "dart", "lua", "pl", "pm", "r", "jl", "hs", "ml", "fs", "sql", "sh", "bash",
    "zsh", "fish", "ps1", "psm1", "bat", "cmd",
]);

/** Extensions that carry prose or configuration and no executable behaviour. */
const INERT_EXTENSIONS = new Set([
    "md", "mdx", "markdown", "txt", "rst", "adoc",
    "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
    "csv", "tsv", "lock",
    "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp",
    "woff", "woff2", "ttf", "otf", "eot",
    "mp4", "webm", "mov", "mp3", "wav", "pdf",
]);

/** Files whose whole name carries the meaning, with no useful extension. */
const INERT_NAMES = new Set([
    "license", "licence", "notice", "authors", "codeowners", "contributors",
    "changelog", "readme", ".gitignore", ".gitattributes", ".npmignore",
    ".dockerignore", ".editorconfig", ".mailmap", ".nvmrc", ".node-version",
]);

function extensionOf(path: string): string {
    const name = path.split("/").pop() ?? path;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * True when the file is something a test or a compiler acts on.
 *
 * UNKNOWN COUNTS AS CODE. A file this does not recognise - a new language, a build
 * script with no extension, a Dockerfile - runs the full pipeline, because the cost of
 * being wrong is asymmetric: over-running wastes minutes, under-running ships a defect
 * the gate was asked to catch.
 */
export function isCode(path: string): boolean {
    const name = (path.split("/").pop() ?? path).toLowerCase();
    if (INERT_NAMES.has(name)) return false;
    const ext = extensionOf(path);
    if (!ext) return true;
    if (CODE_EXTENSIONS.has(ext)) return true;
    return !INERT_EXTENSIONS.has(ext);
}

export interface ChangeProfile {
    /** Steps that cannot say anything about this change. */
    skip: StepName[];
    /** One sentence naming why, for the run's reported outcome. */
    reason: string;
    /** True when the diff contains at least one file a test or compiler acts on. */
    hasCode: boolean;
}

/**
 * Decide which steps a diff makes pointless. An empty file list profiles as code, so a
 * diff that could not be read runs everything.
 */
export function profileChange(files: string[]): ChangeProfile {
    const paths = files.map((f) => f.trim()).filter(Boolean);
    if (paths.length === 0) return { skip: [], reason: "", hasCode: true };

    const code = paths.filter(isCode);
    if (code.length > 0) return { skip: [], reason: "", hasCode: true };

    return {
        skip: ["test", "document"],
        hasCode: false,
        reason: `no executable file changed (${paths.length} file(s): docs, config or assets), so there is nothing for the test suite to exercise and the change is itself documentation`,
    };
}
