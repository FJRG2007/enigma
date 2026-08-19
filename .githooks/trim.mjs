#!/usr/bin/env node

// src/trim.ts
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { extname, join } from "path";
import { open, stat } from "fs/promises";
import { execFileSync } from "child_process";
var TAIL_BYTES = 4096;
var MAX_TAIL = 1024 * 1024;
var CONCURRENCY = 32;
var SKIP_EXT = /* @__PURE__ */ new Set([
  ".patch",
  ".diff",
  ".snap",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".tiff",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".jar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".mov",
  ".avi",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".node",
  ".class",
  ".pyc",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".lock"
]);
var SKIP_DIR = /(^|\/)(__snapshots__|fixtures|testdata|golden|node_modules|\.git|vendor|third_party|third-party|dist|build|coverage|\.next|\.venv)(\/|$)/;
function readIgnoreGlobs(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".githooks", "enigma-trim.json"), "utf8"));
    return Array.isArray(raw.ignore) ? raw.ignore.filter((g) => typeof g === "string") : [];
  } catch {
    return [];
  }
}
function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = esc.replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*").replace(/\?/g, "[^/]");
  return new RegExp(glob.includes("/") ? `^${body}$` : `(^|/)${body}$`);
}
var BLANK_LINE = /^[ \t\r]*$/;
function isSkipped(file) {
  const norm = file.replace(/\\/g, "/");
  return SKIP_DIR.test(norm) || SKIP_EXT.has(extname(norm).toLowerCase());
}
function trailingBlankBytes(tail, atStart) {
  const lines = tail.split("\n");
  if (lines.pop() !== "") return 0;
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!BLANK_LINE.test(line)) return bytes;
    bytes += line.length + 1;
  }
  return atStart ? 0 : -1;
}
async function trimFile(file) {
  if (isSkipped(file)) return false;
  let handle;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0) return false;
    handle = await open(file, "r+");
    let want = TAIL_BYTES;
    for (; ; ) {
      const length = Math.min(want, info.size);
      const position = info.size - length;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, position);
      const tail = buf.subarray(0, bytesRead);
      if (tail.includes(0)) return false;
      const cut = trailingBlankBytes(tail.toString("latin1"), position === 0);
      if (cut === 0) return false;
      if (cut > 0) {
        await handle.truncate(info.size - cut);
        return true;
      }
      if (position === 0 || want >= MAX_TAIL) return false;
      want *= 2;
    }
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {
    });
  }
}
async function trimAll(files, task = trimFile) {
  const changed = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < files.length; i = next++) {
      if (await task(files[i])) changed.push(files[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return changed;
}
function gitLines(args) {
  try {
    const out = execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return out.split("\0").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() || null;
  } catch {
    return null;
  }
}
function stage(files) {
  for (let i = 0; i < files.length; i += 500) {
    try {
      execFileSync("git", ["add", "--", ...files.slice(i, i + 500)], { stdio: "ignore", windowsHide: true });
    } catch {
    }
  }
}
async function runTrimScan(all) {
  const root = repoRoot();
  if (root === null) return { changed: [], unstaged: [], count: 0, notRepo: true };
  const listed = all ? gitLines(["ls-files", "-z"]) : gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"]);
  const ignore = readIgnoreGlobs(root).map(globToRegExp);
  const files = ignore.length ? listed.filter((f) => !ignore.some((re) => re.test(f))) : listed;
  if (files.length === 0) return { changed: [], unstaged: [], count: 0 };
  const dirty = all ? /* @__PURE__ */ new Set() : new Set(gitLines(["diff", "--name-only", "-z"]));
  const changed = await trimAll(files);
  const unstaged = changed.filter((f) => dirty.has(f));
  const restage = changed.filter((f) => !dirty.has(f));
  if (!all && restage.length) stage(restage);
  return { changed, unstaged, count: files.length };
}
async function runTrimHook(payload) {
  try {
    const file = JSON.parse(payload || "{}")?.tool_input?.file_path;
    if (typeof file === "string" && file) await trimFile(file);
  } catch {
  }
  return 0;
}
async function runTrimScanCli(all) {
  const r = await runTrimScan(all);
  if (r.notRepo) {
    console.error("enigma-trim: not a git repository; nothing to do.");
    return 0;
  }
  if (r.changed.length === 0) {
    console.log(`enigma-trim: ${r.count} ${all ? "tracked" : "staged"} file(s) checked, no trailing blank lines.`);
    return 0;
  }
  const staged = r.changed.length - r.unstaged.length;
  console.log(`enigma-trim: removed a trailing blank line from ${r.changed.length} file(s)${all ? "" : `, ${staged} re-staged`}.`);
  for (const f of r.changed.slice(0, 20)) console.log(`  - ${f}`);
  if (r.changed.length > 20) console.log(`  ... and ${r.changed.length - 20} more`);
  if (r.unstaged.length) {
    console.log(`
enigma-trim: ${r.unstaged.length} file(s) were fixed on disk but NOT re-staged, because they also`);
    console.log("hold unstaged edits and `git add` would have pulled those into this commit:");
    for (const f of r.unstaged) console.log(`  ! ${f}`);
  }
  return 0;
}
var trimEntry = process.argv[1] ?? "";
var isTrimEntry = /(^|[\\/])trim\.[mc]?[jt]s$/.test(trimEntry);
if (isTrimEntry && fileURLToPath(import.meta.url) === trimEntry) {
  void runTrimScanCli(process.argv.includes("--all")).then((code) => process.exit(code));
}
export {
  isSkipped,
  readIgnoreGlobs,
  runTrimHook,
  runTrimScan,
  runTrimScanCli,
  trailingBlankBytes,
  trimFile
};
