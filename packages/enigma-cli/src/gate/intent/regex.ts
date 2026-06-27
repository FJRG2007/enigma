/**
 * Faithful port of upstream's `internal/intent/regex.go`.
 */

/**
 * filePathTokens picks out tokens that plausibly look like a file path.
 * We require at least one alphanumeric char and allow common path chars.
 * The `g` flag matches Go's `FindAllString` (scan every occurrence).
 */
export const filePathTokens = /[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,8}/g;
