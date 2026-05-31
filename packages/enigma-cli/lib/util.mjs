/**
 * Shared, side-effect-free helpers. Kept tiny and dependency-free so any module
 * can import them without pulling in heavier concerns.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

/** True if `pth` exists and is a directory. */
export function isDir(pth) {
  try { return statSync(pth).isDirectory(); } catch { return false; }
}

/** Parse a JSON file, returning null on any error. */
export function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** Is an executable named `bin` resolvable on the user's PATH? (cross-platform, no spawn) */
export function isOnPath(bin) {
  const dirs = (process.env.PATH || process.env.Path || "").split(sep === "\\" ? ";" : ":").filter(Boolean);
  const exts = sep === "\\"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())
    : [""];
  return dirs.some((d) => exts.some((ext) => existsSync(join(d, bin + ext))));
}
