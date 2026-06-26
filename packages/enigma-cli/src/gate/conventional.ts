/**
 * Conventional-commit title helpers.
 *
 * Faithful 1:1 port of the Go `internal/conventional/title.go`: the title regex,
 * the valid-type set, the release-type rule used in agent suggestion prompts,
 * `isTitle`, and `tightenTitle` (with its type-inference fallback). Behavior is
 * preserved; only naming follows enigma's TypeScript conventions.
 */

const TITLE_RE = /^([a-z]+)(\([^)]+\))?(!)?: (.+)$/;

const VALID_TYPES = new Set([
    "feat",
    "fix",
    "docs",
    "style",
    "refactor",
    "perf",
    "test",
    "build",
    "ci",
    "chore",
    "revert"
]);

/** Release-automation guidance shared by the commit/PR title prompts. */
export const RELEASE_TYPE_RULE =
    "- If the change has any user-facing product impact, the type must use feat or fix so release automation can pick it up. Use feat for a new user-visible capability and fix for a user-visible correction or behavior improvement. Use docs, refactor, chore, test, build, or ci only when the change has no user-facing product behavior impact.";

/** Reports whether `title` is a well-formed conventional-commit subject. */
export function isTitle(title: string): boolean {
    const m = TITLE_RE.exec(title.trim());
    return m !== null && VALID_TYPES.has(m[1]);
}

/**
 * Normalizes a subject into conventional-commit form. A title that already has a
 * valid type is returned untouched; otherwise an inferred `type:` prefix is added.
 */
export function tightenTitle(title: string): string {
    title = title.trim();
    if (title === "") return "";

    const m = TITLE_RE.exec(title);
    if (m === null || !VALID_TYPES.has(m[1])) return `${inferType(title)}: ${title}`;
    return title;
}

function inferType(text: string): string {
    const lower = text.trim().toLowerCase();
    if (hasDocumentationLanguage(lower)) return "docs";
    if (hasProductImpactLanguage(lower) || isFeatureLanguage(lower) || isFixLanguage(lower)) {
        return inferReleaseType(lower);
    }
    return "chore";
}

function inferReleaseType(text: string): string {
    if (isFeatureLanguage(text)) return "feat";
    return "fix";
}

function isFixLanguage(text: string): boolean {
    const lower = text.trim().toLowerCase();
    const fixPrefixes = [
        "fix ", "fixes ", "fixed ", "resolve ", "resolves ", "resolved ",
        "correct ", "corrects ", "corrected ", "repair ", "repairs ", "repaired "
    ];
    return fixPrefixes.some(prefix => lower.startsWith(prefix));
}

function isFeatureLanguage(text: string): boolean {
    const lower = text.trim().toLowerCase();
    const featurePrefixes = [
        "add ", "adds ", "added ", "introduce ", "introduces ", "introduced ",
        "create ", "creates ", "created ", "implement ", "implements ", "implemented ",
        "support ", "supports ", "supported ", "enable ", "enables ", "enabled ",
        "allow ", "allows ", "allowed "
    ];
    if (featurePrefixes.some(prefix => lower.startsWith(prefix))) return true;
    return lower.includes(" new ") || lower.startsWith("new ");
}

function hasProductImpactLanguage(text: string): boolean {
    const lower = text.toLowerCase();
    const terms = [
        "user-facing", "user visible", "user-visible", "user experience", " ux", "ux ",
        " ui", "ui ", "cli", "command", "output", "behavior", "workflow",
        "prompt", "flag", "error message"
    ];
    return terms.some(term => lower.includes(term));
}

function hasDocumentationLanguage(text: string): boolean {
    const lower = text.toLowerCase();
    return lower.includes("readme") || lower.includes("documentation") || lower.includes("docs");
}
