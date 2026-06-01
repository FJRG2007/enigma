/**
 * Runtime detection. OpenTUI's native Zig core loads through Bun's FFI and only
 * runs under Bun today, so the hub selects the OpenTUI TUI under Bun and the Ink
 * TUI under Node. Detected via process.versions.bun, which Bun sets and Node never
 * does - no dependency on the global `Bun` object, which a bundler could shim.
 */
export const isBun = (): boolean =>
    typeof (process.versions as { bun?: string }).bun === "string";
