/**
 * A code graph index for `enigma serve`, run in a child process. Indexing reads up to the file
 * cap of a tree and builds every edge synchronously, so in the server's own process one large
 * repository would stall the requests of every other tenant for as long as it takes. The child
 * gets the tenant's store overrides in its own environment, so nothing here touches the
 * server's process.env and the job may outlive any number of other requests.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ProjectEntry } from "../codegraph";

/** Longest an index job may run before it is killed. */
const INDEX_TIMEOUT_MS = 10 * 60 * 1000;
/** Most stdout a job may print; the entry it reports is a few hundred bytes. */
const MAX_STDOUT = 1024 * 1024;

/** argv that re-invokes this enigma: the compiled binary directly, a runtime with its entry script. */
function selfArgs(args: string[]): string[] {
    const exe = basename(process.execPath).toLowerCase();
    if (!["node", "node.exe", "bun", "bun.exe"].includes(exe)) return args;
    const source = fileURLToPath(new URL("../bin/enigma.ts", import.meta.url));
    return [existsSync(source) ? source : process.argv[1]!, ...args];
}

/** Index `root` with the tenant's store overrides; resolves with the indexed project. */
export function runIndexJob(root: string, env: Record<string, string>, timeoutMs = INDEX_TIMEOUT_MS): Promise<ProjectEntry> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, selfArgs(["__codegraph-index", root]), {
            env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
        let out = "";
        let err = "";
        let failure: Error | null = null;
        const timer = setTimeout(() => { failure = new Error(`index job timed out after ${timeoutMs} ms`); child.kill(); }, timeoutMs);
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            out += chunk;
            if (out.length > MAX_STDOUT && !failure) { failure = new Error("index job printed more than expected"); child.kill(); }
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err = (err + chunk).slice(-4000); });
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (failure) return reject(failure);
            if (code !== 0) return reject(new Error(`index job exited ${code}: ${err.trim().split(/\r?\n/).pop() ?? ""}`));
            try { resolve(JSON.parse(out) as ProjectEntry); } catch { reject(new Error("index job printed no project entry")); }
        });
    });
}
