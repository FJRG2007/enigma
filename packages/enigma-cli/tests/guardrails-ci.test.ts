/**
 * Precision matrix for the CI workflow rules (ci-policy): each rule's true positives and the shapes
 * that must stay quiet - local actions, digest-pinned images, untrusted text passed through `env:`,
 * and privileged workflows that admit only same-repository pull requests. Temp HOME + isolated
 * config set before import, like the other guardrails suites.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { test, expect, afterAll } from "bun:test";

const HOME = mkdtempSync(join(tmpdir(), "enigma-gr-ci-"));
process.env.USERPROFILE = HOME;
process.env.ENIGMA_CONFIG_HOME = HOME;
process.env.HOME = HOME;
process.env.ENIGMA_GUARDRAILS_CONFIG = join(HOME, "guardrails.json");

const { BUILTIN_RULES, checkFile } = await import("../src/guardrails");

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const WORKFLOW = ".github/workflows/ci.yml";
const SHA = "11bd71901bbe5b1630ceea73d27597364c9af683";

/** Whether `ruleId` fired, checked at the rule's own stage (a diff rule is invisible at the edit stage). */
function flagged(ruleId: string, file: string, code: string): boolean {
    const stage = BUILTIN_RULES.find((r) => r.id === ruleId)?.stage ?? "edit";
    return checkFile(file, code, null, stage).some((f) => f.ruleId === ruleId);
}

function matrix(ruleId: string, expected: boolean, cases: Array<{ name: string; file?: string; code: string; }>): void {
    for (const c of cases) {
        test(`${ruleId} ${expected ? "flags" : "ignores"}: ${c.name}`, () => {
            expect(flagged(ruleId, c.file ?? WORKFLOW, c.code)).toBe(expected);
        });
    }
}

test("every CI rule blocks, names ci-policy, and sits at the stage its backlog allows", () => {
    const expected: Record<string, "edit" | "diff"> = {
        "ci-action-unpinned": "diff",
        "ci-untrusted-checkout": "edit",
        "ci-script-injection": "edit",
    };
    for (const [id, stage] of Object.entries(expected)) {
        const rule = BUILTIN_RULES.find((r) => r.id === id);
        expect(rule?.severity).toBe("block");
        expect(rule?.skill).toBe("ci-policy");
        expect(rule?.stage ?? "edit").toBe(stage);
    }
});

// --- ci-action-unpinned ------------------------------------------------------------------

matrix("ci-action-unpinned", true, [
    { name: "a version tag", code: "    steps:\n      - uses: actions/checkout@v4\n" },
    { name: "a branch", code: "      - uses: errata-ai/vale-action@reviewdog\n" },
    { name: "a reusable workflow by tag", code: "jobs:\n  call:\n    uses: org/shared/.github/workflows/build.yml@v2\n" },
    { name: "no ref at all", code: "      - uses: someone/action\n" },
    { name: "a docker image by tag", code: "      - uses: docker://alpine:3.20\n" },
    { name: "a quoted tag", code: "      - uses: \"actions/setup-node@v4\"\n" },
    { name: "a short SHA", code: "      - uses: actions/checkout@11bd719\n" },
    { name: "a composite action's step", file: ".github/actions/setup/action.yml", code: "    - uses: actions/cache@v4\n" },
    { name: "a nested project's workflow", file: "apps/web/.github/workflows/deploy.yaml", code: "      - uses: actions/checkout@v4\n" },
]);

matrix("ci-action-unpinned", false, [
    { name: "a full SHA with the version as a comment", code: `      - uses: actions/checkout@${SHA} # v4.2.2\n` },
    { name: "a local action", code: "      - uses: ./.github/actions/setup\n" },
    { name: "a docker image by digest", code: `      - uses: docker://alpine@sha256:${"a".repeat(64)}\n` },
    { name: "a commented-out step", code: "      # - uses: actions/checkout@v4\n" },
    { name: "a marked first-party action", code: "      - uses: our-org/release@v1 # enigma:allow-unpinned-action\n" },
    { name: "a file that is not a workflow", file: "docs/ci.yml", code: "      - uses: actions/checkout@v4\n" },
]);

// --- ci-untrusted-checkout ---------------------------------------------------------------

const PRT = "on:\n  pull_request_target:\n    types: [opened, synchronize]\n";
const RUN = "on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n";

matrix("ci-untrusted-checkout", true, [
    { name: "pull_request_target checking out the head SHA", code: `${PRT}jobs:\n  t:\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: npm ci && npm test\n` },
    { name: "pull_request_target checking out head_ref", code: `${PRT}jobs:\n  t:\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          ref: \${{ github.head_ref }}\n` },
    { name: "workflow_run checking out the head SHA", code: `${RUN}jobs:\n  t:\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          ref: \${{ github.event.workflow_run.head_sha }}\n` },
    { name: "a git fetch of the pull request ref", code: `${PRT}jobs:\n  t:\n    steps:\n      - run: git fetch origin refs/pull/\${{ github.event.number }}/head && git checkout FETCH_HEAD\n` },
    { name: "gh pr checkout", code: `${PRT}jobs:\n  t:\n    steps:\n      - run: gh pr checkout \${{ github.event.number }}\n` },
    { name: "the inline trigger list form", code: `on: [pull_request_target]\njobs:\n  t:\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.head.ref }}\n` },
    { name: "the fork checked out by repository and ref", code: `${PRT}jobs:\n  t:\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          repository: \${{ github.event.pull_request.head.repo.full_name }}\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: npm ci && npm test\n` },
    { name: "the merge commit SHA", code: `${PRT}jobs:\n  t:\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.merge_commit_sha }}\n` },
    { name: "a guard that admits only forks", code: `${PRT}jobs:\n  t:\n    if: github.event.pull_request.head.repo.fork == true\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.head.sha }}\n` },
    { name: "a same-repo guard on a different job", code: `${PRT}jobs:\n  label:\n    if: github.event.pull_request.head.repo.full_name == github.repository\n    steps:\n      - run: echo ok\n  test:\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.head.sha }}\n` },
]);

matrix("ci-untrusted-checkout", false, [
    { name: "plain pull_request checking out the head", code: `on: pull_request\njobs:\n  t:\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.head.sha }}\n` },
    { name: "pull_request_target checking out the base (default)", code: `${PRT}jobs:\n  t:\n    steps:\n      - uses: actions/checkout@${SHA}\n      - run: gh pr comment \${{ github.event.number }} --body hi\n` },
    { name: "workflow_run limited to same-repository pull requests", code: `${RUN}jobs:\n  t:\n    if: |\n      github.event.workflow_run.head_repository.full_name == github.repository\n    steps:\n      - with:\n          ref: \${{ github.event.workflow_run.head_branch }}\n` },
    { name: "pull_request_target comparing github.repository first", code: `${PRT}jobs:\n  t:\n    if: \${{ github.repository == github.event.pull_request.head.repo.full_name }}\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.head.sha }}\n` },
    { name: "a step guarded by a negated fork check", code: `${PRT}jobs:\n  t:\n    steps:\n      - if: \${{ !github.event.pull_request.head.repo.fork }}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n` },
    { name: "pull_request_target rejecting forks", code: `${PRT}jobs:\n  t:\n    if: github.event.pull_request.head.repo.fork == false\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.head.sha }}\n` },
    { name: "a marked data-only checkout", code: `${PRT}jobs:\n  t:\n    steps:\n      - with:\n          ref: \${{ github.event.pull_request.head.sha }} # enigma:allow-untrusted-checkout\n` },
    { name: "the trigger only named in a comment", code: `# not pull_request_target on purpose\non: pull_request\njobs:\n  t:\n    steps:\n      - with:\n          ref: \${{ github.head_ref }}\n` },
]);

// --- ci-script-injection -----------------------------------------------------------------

matrix("ci-script-injection", true, [
    { name: "an issue title in an inline run", code: "      - run: echo \"${{ github.event.issue.title }}\"\n" },
    { name: "a comment body in a run block", code: "      - name: x\n        run: |\n          echo start\n          body=\"${{ github.event.comment.body }}\"\n" },
    { name: "the head branch name in a folded block", code: "      - run: >-\n          git push origin ${{ github.head_ref }}\n" },
    { name: "a commit message in a run block", code: "      - run: |\n          msg='${{ github.event.head_commit.message }}'\n" },
    { name: "a pull request body in github-script", code: `      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            const body = \`\${{ github.event.pull_request.body }}\`;\n` },
    { name: "untrusted text inside a shell comment line", code: "      - run: |\n          # ${{ github.event.issue.title }}\n          echo ok\n" },
    { name: "a run key on its own mapping line", code: "    steps:\n      - name: greet\n        run: echo ${{ github.event.pull_request.title }}\n" },
]);

matrix("ci-script-injection", false, [
    { name: "the same text passed through env", code: "      - env:\n          TITLE: ${{ github.event.issue.title }}\n        run: echo \"$TITLE\"\n" },
    { name: "an action input (not a script)", code: `      - uses: some/action@${SHA}\n        with:\n          prompt: \${{ github.event.comment.body }}\n` },
    { name: "trusted context in a run", code: "      - run: echo ${{ github.sha }} ${{ github.event.pull_request.number }} ${{ github.repository }}\n" },
    { name: "a run block that ended before the env key", code: "      - run: |\n          echo hi\n        env:\n          BODY: ${{ github.event.comment.body }}\n" },
    { name: "a commented-out run", code: "      # - run: echo ${{ github.event.issue.title }}\n" },
    { name: "a marked line", code: "      - run: echo ${{ github.head_ref }} # enigma:allow-script-injection\n" },
]);
