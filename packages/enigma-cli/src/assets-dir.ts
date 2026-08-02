/**
 * Single resolution of the on-disk assets root shipped with this CLI.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const LOCAL_ASSETS = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "assets");

/**
 * `ENIGMA_ASSETS_DIR` exists only because the compiled binary cannot see its own files
 * (its `__dirname` points into Bun's virtual fs), so the launcher stamps it with the real
 * package path. Whenever the assets ARE on disk beside the code - running from source
 * (`tsx`/`bun`) or from `dist/` - they win: the launcher sets that variable unconditionally
 * and every shell or tool an enigma spawns inherits it, so honoring it here makes this
 * process read ANOTHER install's assets (a stale skill set, and a spurious `enigma check`
 * version mismatch when that install's version differs from this package's).
 */
export const ASSETS_DIR = existsSync(LOCAL_ASSETS) ? LOCAL_ASSETS : (process.env.ENIGMA_ASSETS_DIR ?? LOCAL_ASSETS);
