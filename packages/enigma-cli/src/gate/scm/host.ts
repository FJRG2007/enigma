/**
 * SCM provider detection and pure URL helpers. Faithful port of the
 * no-mistakes `internal/scm` host detection plus the GitHub `RepoSlug` helper.
 *
 * Only the pure, network-free pieces are ported here; the provider CLI clients
 * (github/gitlab) land in sibling files in a later phase.
 */

/** SCM hosting provider detected from a repository or PR URL. */
export type Provider = "github" | "gitlab" | "bitbucket" | "unknown";

/** Provider serving repositories on github.com. */
export const PROVIDER_GITHUB: Provider = "github";

/** Provider serving repositories on gitlab.com or a self-hosted GitLab. */
export const PROVIDER_GITLAB: Provider = "gitlab";

/** Provider serving repositories on bitbucket.org. */
export const PROVIDER_BITBUCKET: Provider = "bitbucket";

/** Sentinel for a URL whose provider could not be identified. */
export const PROVIDER_UNKNOWN: Provider = "unknown";

/** Detect the SCM provider from a repository or PR URL by host substring. */
export function detectProvider(url: string): Provider {
    const lower = url.toLowerCase();
    if (lower.includes("github.com")) return PROVIDER_GITHUB;
    if (lower.includes("gitlab.com") || lower.includes("gitlab.")) return PROVIDER_GITLAB;
    if (lower.includes("bitbucket.org")) return PROVIDER_BITBUCKET;
    return PROVIDER_UNKNOWN;
}

/**
 * Extract the "owner/repo" slug from a GitHub remote URL, supporting https,
 * scp-style ssh, and bare path forms. Returns "" when no owner/name pair.
 */
export function repoSlug(remoteURL: string): string {
    let raw = remoteURL.trim();
    if (raw === "") return "";
    if (raw.endsWith(".git")) raw = raw.slice(0, -".git".length);

    // Reduce raw to the path portion after the host.
    if (raw.includes("://")) {
        const rest = raw.slice(raw.indexOf("://") + "://".length);
        const slash = rest.indexOf("/");
        if (slash < 0) return "";
        raw = rest.slice(slash + 1);
    } else if (raw.includes(":")) {
        // scp-style ssh: [user@]host:owner/name
        raw = raw.slice(raw.indexOf(":") + 1);
    }

    const parts = raw.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) return "";
    const owner = parts[0].trim();
    const name = parts[1].trim();
    if (owner === "" || name === "") return "";
    return `${owner}/${name}`;
}
