// Prefix a path with the configured base (/enigma) so links and public assets resolve
// under the GitHub Pages project subpath. BASE_URL may or may not carry a trailing slash
// depending on the trailingSlash config, so normalize it to exactly one.
const BASE = import.meta.env.BASE_URL.replace(/\/?$/, "/");

export const url = (path = ""): string => BASE + path.replace(/^\//, "");

// A docs route from its slug (the collection entry id), with optional heading anchor.
export const docHref = (slug: string, anchor = ""): string =>
    url(`docs/${slug}/`) + (anchor ? `#${anchor}` : "");
