/**
 * Recursive filesystem copy preserving symlinks and file permissions. Faithful
 * port of the no-mistakes `internal/pipeline/steps/common_fs.go`.
 *
 * Go returned errors; here the sync fs calls throw, matching the port-wide
 * "(value, error) -> throw on error" convention.
 */

import { join } from "node:path";
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    symlinkSync,
    readdirSync,
    copyFileSync,
    readlinkSync
} from "node:fs";

/** Copies every entry of srcDir into dstDir. */
export function copyDirContents(srcDir: string, dstDir: string): void {
    for (const name of readdirSync(srcDir)) {
        copyPath(join(srcDir, name), join(dstDir, name));
    }
}

/** Copies a single path (symlink, directory, or file) from src to dst. */
export function copyPath(srcPath: string, dstPath: string): void {
    const info = lstatSync(srcPath);
    if (info.isSymbolicLink()) {
        const target = readlinkSync(srcPath);
        symlinkSync(target, dstPath);
        return;
    }
    if (info.isDirectory()) {
        mkdirSync(dstPath, { recursive: true, mode: info.mode & 0o777 });
        copyDirContents(srcPath, dstPath);
        return;
    }
    copyFile(srcPath, dstPath, info.mode & 0o777);
}

function copyFile(srcPath: string, dstPath: string, perm: number): void {
    copyFileSync(srcPath, dstPath);
    chmodSync(dstPath, perm);
}
