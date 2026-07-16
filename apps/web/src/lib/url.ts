// Prefix a path with the configured base (/enigma) so links and public assets resolve
// under the GitHub Pages project subpath. BASE_URL may or may not carry a trailing slash
// depending on the trailingSlash config, so normalize it to exactly one.
const BASE = import.meta.env.BASE_URL.replace(/\/?$/, "/");

export const url = (path = ""): string => BASE + path.replace(/^\//, "");

// Cache-busting URL for a static sub-resource served from public/ (image, icon, script).
// Page links use url() and stay clean; only sub-resources get the ?v= token, which changes
// per deploy (the short commit SHA, see astro.config.mjs) so a new build is never served
// from a stale browser/CDN cache. Astro's own bundled CSS/JS are already content-hashed.
const BUILD_ID = import.meta.env.PUBLIC_BUILD_ID || "dev";
export const asset = (path = ""): string => `${url(path)}?v=${BUILD_ID}`;

// A docs route from its slug (the collection entry id), with optional heading anchor.
export const docHref = (slug: string, anchor = ""): string =>
    url(`docs/${slug}/`) + (anchor ? `#${anchor}` : "");
