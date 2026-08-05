/**
 * The guard's shared detection helpers (reused by the commit guard AND the prompt
 * secret guard), the global guard-config list persistence, and the three scan modes
 * (staged / --all / --range) with their exit codes. The first group is the pure,
 * git-independent part: glob translation, secret matching/redaction, and the
 * block/allow/secret-pattern lists written to ~/.enigma-guard.json.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readGlobalGuard, setGuardList, setGuardProtection } from "../src/guard-config";
import {
    runGuard,
    parseRange,
    runGuardCli,
    findSecrets,
    globToRegExp,
    parseGuardArgv,
    redactSecrets,
    buildSecretMatchers
} from "../src/guard";

// Built at runtime by concatenation so this test file does not itself trip enigma's
// own commit guard (which scans tracked files for literal credential patterns).
const ANTHRO_KEY = "sk-ant-" + "api03-" + "A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

test("globToRegExp matches basenames for slash-less globs and full paths otherwise", () => {
    expect(globToRegExp("*.env.local").test("config/db.env.local")).toBe(true); // basename anchored
    expect(globToRegExp("*.env.local").test("notes.txt")).toBe(false);
    expect(globToRegExp("secrets/*.json").test("secrets/api.json")).toBe(true); // path anchored
    expect(globToRegExp("secrets/*.json").test("app/secrets/api.json")).toBe(false); // * does not cross /
    expect(globToRegExp("tests/fixtures/**").test("tests/fixtures/deep/a.key")).toBe(true); // ** crosses /
});

test("built-in matchers detect a real credential and ignore clean text", () => {
    const m = buildSecretMatchers();
    expect(findSecrets("here is " + ANTHRO_KEY, m)).toContain("Anthropic API key");
    expect(findSecrets("just a normal sentence", m)).toEqual([]);
});

test("custom patterns extend detection; bad regex sources are skipped", () => {
    const m = buildSecretMatchers(["mycorp_[a-z0-9]{8}", "((("]); // second is invalid, must not throw
    expect(findSecrets("token mycorp_abcd1234 ok", m)).toContain("custom secret");
});

test("redactSecrets replaces the secret with a labelled placeholder", () => {
    const m = buildSecretMatchers();
    const { text, hits } = redactSecrets("key=" + AWS_KEY + " done", m);
    expect(text).not.toContain(AWS_KEY);
    expect(text).toContain("[REDACTED: AWS access key id]");
    expect(hits).toContain("AWS access key id");
});

test("guard-config persists and dedupes user lists without dropping protections", () => {
    const HOME = mkdtempSync(join(tmpdir(), "enigma-guard-"));
    const prev = { home: process.env.HOME, profile: process.env.USERPROFILE };
    process.env.HOME = HOME; process.env.USERPROFILE = HOME;
    try {
        setGuardProtection("largeFiles", false);
        setGuardList("blockPaths", ["secrets/*.json", "secrets/*.json", " ", "*.local.env"]);
        setGuardList("secretPatterns", ["mycorp_[a-z0-9]{8}"]);
        const cfg = readGlobalGuard();
        expect(cfg.blockPaths).toEqual(["secrets/*.json", "*.local.env"]); // deduped + trimmed
        expect(cfg.secretPatterns).toEqual(["mycorp_[a-z0-9]{8}"]);
        expect(cfg.largeFiles).toBe(false);   // a list write must preserve the protections
        expect(cfg.secrets).toBe(true);       // untouched defaults remain on
    } finally {
        process.env.HOME = prev.home; process.env.USERPROFILE = prev.profile;
        rmSync(HOME, { recursive: true, force: true });
    }
});

// --- scan modes: staged (default), --all, --range <base>..<head> ------------------------

/**
 * The tests below drive real git (and one of them the real CLI), several spawns each. Bun's
 * default 5s budget is enough on an idle machine and not on a loaded one - process spawn is
 * the slow part on Windows in particular - so each of them carries an explicit, generous
 * budget. It bounds a genuine hang without turning machine load into a red CI run.
 */
const GIT_TEST_MS = 60_000;

/** A throwaway repo with one clean commit, then one that commits a credential. */
function repoWithLeak(): string {
    const dir = mkdtempSync(join(tmpdir(), "enigma-guard-range-"));
    const git = (...args: string[]): void => { execFileSync("git", args, { cwd: dir, windowsHide: true, stdio: "ignore" }); };
    git("init", "-q", ".");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "hello\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(join(dir, "leak.js"), `const k = "${AWS_KEY}";\n`);
    git("add", "-A");
    git("commit", "-qm", "leak");
    return dir;
}

/** runGuard resolves paths relative to the process cwd, so a scan runs inside the repo. */
function inRepo<T>(dir: string, fn: () => T): T {
    const prev = process.cwd();
    process.chdir(dir);
    try { return fn(); } finally { process.chdir(prev); }
}

test("parseRange normalizes both ends and rejects a value that is not a ref expression", () => {
    expect(parseRange("main..HEAD")).toEqual({ range: "main..HEAD", head: "HEAD" });
    expect(parseRange("v1.0..v2.0")).toEqual({ range: "v1.0..v2.0", head: "v2.0" }); // dots inside a ref
    expect(parseRange("origin/main...HEAD")).toEqual({ range: "origin/main...HEAD", head: "HEAD" });
    expect(parseRange("origin/main..")).toEqual({ range: "origin/main..HEAD", head: "HEAD" }); // open end
    expect(parseRange("HEAD~3")).toEqual({ range: "HEAD~3..HEAD", head: "HEAD" }); // a lone ref
    // A value with no non-dot character is a typo, not an empty-sided range git matches nothing for.
    expect(parseRange("...")).toBeNull();
    expect(parseRange("")).toBeNull();
    expect(parseRange("bad ref..HEAD")).toBeNull();
    // A leading dash would reach git's argv as an OPTION, so it never becomes a range.
    expect(parseRange("--upload-pack=evil..HEAD")).toBeNull();
    expect(parseRange("-x")).toBeNull();
});

test("--range scans what the range committed, even after the working tree moved on", () => {
    const dir = repoWithLeak();
    try {
        // The secret is gone from the working tree, so only a scan of the committed blob finds it.
        writeFileSync(join(dir, "leak.js"), "const k = process.env.K;\n");
        inRepo(dir, () => {
            const ranged = runGuard({ range: "HEAD~1..HEAD" });
            expect(ranged.mode).toBe("range");
            expect(ranged.ok).toBe(false);
            expect(ranged.findings).toEqual([
                { severity: "block", rule: "secret", file: "leak.js", line: 1, detail: "secret: AWS access key id" },
            ]);
            expect(ranged.count).toBe(1); // only the file the range touched, not the whole tree

            // Nothing is staged after a commit, which is exactly why --range exists.
            expect(runGuard().findings).toEqual([]);
            // --all reads the working tree, where the secret no longer is.
            expect(runGuard({ all: true }).findings).toEqual([]);
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, GIT_TEST_MS);

test("exit codes separate findings (1) from a guard that could not run (2)", () => {
    const dir = repoWithLeak();
    const quiet = { log: console.log, error: console.error };
    console.log = () => {}; console.error = () => {};
    try {
        inRepo(dir, () => {
            expect(runGuardCli({ range: "HEAD~1..HEAD" })).toBe(1); // blocking findings
            expect(runGuardCli({ range: "HEAD~1..HEAD", json: true })).toBe(1);
            expect(runGuardCli({})).toBe(0);                        // nothing staged, nothing wrong
            expect(runGuardCli({ range: "..." })).toBe(2);          // not a range
            expect(runGuardCli({ range: "no/such/ref..HEAD" })).toBe(2); // git cannot resolve it
        });
        // A guard that checked nothing must not read as a pass.
        const empty = mkdtempSync(join(tmpdir(), "enigma-guard-norepo-"));
        try { inRepo(empty, () => { expect(runGuardCli({})).toBe(2); }); }
        finally { rmSync(empty, { recursive: true, force: true }); }
    } finally {
        console.log = quiet.log; console.error = quiet.error;
        rmSync(dir, { recursive: true, force: true });
    }
}, GIT_TEST_MS);

test("parseGuardArgv reads the flags the copied hook is handed", () => {
    expect(parseGuardArgv([])).toEqual({ all: false, json: false });
    expect(parseGuardArgv(["--all", "--json"])).toEqual({ all: true, json: true });
    expect(parseGuardArgv(["--range", "a..b"]).range).toBe("a..b");
    expect(parseGuardArgv(["--range=a..b"]).range).toBe("a..b");
    // A pre-push hook line forwards "$@" - the remote name and its URL - to the copied hook.
    expect(parseGuardArgv(["origin", "git@github.com:o/r.git"]).usageError).toBeUndefined();
});

test("an unrecognized flag is a usage error, not a silent fall back to the staged scan", () => {
    // `enigma guard` dispatches straight to this parser, so nothing else rejects a typo:
    // treating one as "not passed" selects the staged scan, which passes having checked
    // nothing wherever the flag was needed (a pre-push hook, CI).
    for (const bad of [["--rangee", "a..b"], ["--range-from", "a..b"], ["-r", "a..b"], ["--al"]]) {
        expect(parseGuardArgv(bad).usageError).toMatch(/unknown option/);
    }
    // The value of a well-formed --range is a value, not an unknown flag.
    expect(parseGuardArgv(["--range", "a..b", "--json"]).usageError).toBeUndefined();

    const dir = repoWithLeak();
    const quiet = { log: console.log, error: console.error };
    console.log = () => {}; console.error = () => {};
    try {
        inRepo(dir, () => expect(runGuardCli(parseGuardArgv(["--rangee", "a..b"]))).toBe(2));
    } finally {
        console.log = quiet.log; console.error = quiet.error;
        rmSync(dir, { recursive: true, force: true });
    }
}, GIT_TEST_MS);

test("a --range with no value is a usage error, never a silent staged scan", () => {
    // Dropping the flag used to leave the staged scan, which in a pre-push hook has nothing
    // staged: "0 file(s) checked" and exit 0, having looked at none of the commits pushed.
    expect(parseGuardArgv(["--range"]).usageError).toMatch(/--range needs a value/);
    expect(parseGuardArgv(["--range"]).range).toBeFalsy();
    expect(parseGuardArgv(["--range="]).usageError).toMatch(/--range needs a value/);

    const dir = repoWithLeak();
    const quiet = { log: console.log, error: console.error };
    console.log = () => {}; console.error = () => {};
    try {
        inRepo(dir, () => {
            expect(runGuardCli(parseGuardArgv(["--range"]))).toBe(2);
            expect(runGuardCli(parseGuardArgv(["--range", "--json"]))).toBe(2);
            expect(runGuardCli({ ...parseGuardArgv(["--range="]), json: true })).toBe(2);
        });
    } finally {
        console.log = quiet.log; console.error = quiet.error;
        rmSync(dir, { recursive: true, force: true });
    }
}, GIT_TEST_MS);

test("a --range the CLI cannot honour exits 2, empty string included", () => {
    const cli = join(import.meta.dir, "..", "src", "bin", "enigma.ts");
    const run = (...args: string[]): { status: number | null; err: string; out: string; } => {
        const r = Bun.spawnSync(["bun", cli, ...args], { stderr: "pipe", stdout: "pipe" });
        return { status: r.exitCode, err: r.stderr.toString(), out: r.stdout.toString() };
    };
    for (const args of [["guard", "--range"], ["guard", "--range", ""], ["guard", "--range="]]) {
        // The empty string is the shape a CI script produces from `--range "$RANGE"` with
        // RANGE unset; it used to read as staged mode and exit 0 having checked nothing.
        const r = run(...args);
        expect(r.status).toBe(2);
        expect(r.err).toMatch(/--range needs a value/);
    }
    // The CLI and the copied hook take the same spellings, so a hook line ported to CI works.
    expect(run("guard", "--range=...").status).toBe(2); // reaches the guard, rejected as a range
    expect(run("guard", "--help").status).toBe(0);      // help still belongs to the CLI
}, GIT_TEST_MS);

test("a non-blob entry in the range does not shift the content of the files after it", () => {
    // `git diff --name-only` lists a submodule gitlink, and `cat-file --batch` answers it with
    // a commit object whose payload used to be left in the stream - so every later file was
    // read from the wrong offset and the secret scan silently looked at the wrong bytes.
    const dir = mkdtempSync(join(tmpdir(), "enigma-guard-gitlink-"));
    const git = (...args: string[]): string =>
        execFileSync("git", args, { cwd: dir, windowsHide: true, encoding: "utf8" }).trim();
    try {
        git("init", "-q", ".");
        git("config", "user.email", "t@t.t");
        git("config", "user.name", "t");
        writeFileSync(join(dir, "a.txt"), "hello\n");
        git("add", "-A");
        git("commit", "-qm", "base");
        // A gitlink pointing at a commit this repo really has, so cat-file returns the object
        // (and its payload) rather than the `missing` a superproject usually gets.
        git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},sub`);
        // Enough files after the gitlink (they all sort after `sub`) that the skipped payload
        // pushes a later one onto a real blob header, which is where the misattribution shows:
        // only t01 holds the credential, so any other file reported for it read foreign bytes.
        const names = ["t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08"].map((n) => `${n}.js`);
        names.forEach((name, i) => writeFileSync(join(dir, name), i === 0 ? `const k = "${AWS_KEY}";\n` : `const n = ${i};\n`));
        git("add", ...names);
        git("commit", "-qm", "gitlink and leak");

        inRepo(dir, () => {
            const ranged = runGuard({ range: "HEAD~1..HEAD" });
            expect(ranged.findings).toEqual([
                { severity: "block", rule: "secret", file: "t01.js", line: 1, detail: "secret: AWS access key id" },
            ]);
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, GIT_TEST_MS);
