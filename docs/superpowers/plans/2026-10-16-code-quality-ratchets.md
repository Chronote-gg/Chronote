# Code quality ratchets implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for Native execution, or superpowers:subagent-driven-development if the user selects it. Implement task-by-task and track the checkbox steps below.

**Goal:** Prevent newly introduced duplication, complex functions, and oversized JavaScript/TypeScript files, with a persistent PR-wide exception and visible findings.

**Architecture:** Adapt Perkcord's tested Git-relative scanners, extracting their existing shared Git/path operations so complexity and file size do not import the duplication engine. A combined runner provides strict local results; a pure policy function lets a dedicated PR workflow apply the approved label-and-rationale exception. Replace the old blocking Lizard policy with diagnostic output, then verify hosted merge enforcement separately.

**Tech Stack:** Node.js 24.15.0, ESM JavaScript, Node test runner, ESLint 10, typescript-eslint, SonarJS, jscpd, Yarn classic, GitHub Actions. Reuse the installed YAML dependency for workflow contract tests.

**Spec:** [Approved design](../specs/2026-10-16-code-quality-ratchets-design.md), approved in chat on October 16, 2026. The user approved Native execution with a fresh whole-branch review.

## Global constraints

- Complexity threshold: 15. File size: fewer than 1,000 physical lines for new files. Duplicate minimums: 8 lines and 50 tokens. Preserve the design's per-function, per-file, and per-clone comparison semantics.
- Include authored tests, fixtures, mocks, and stories by default. Support `.js`, `.jsx`, `.cjs`, `.mjs`, `.ts`, `.tsx`, `.cts`, and `.mts`. Exclude declarations, generated output, dependencies, Git metadata, and nested worktrees.
- Git is the baseline. Include unstaged and eligible untracked files without mutating the caller's index. Local default base: `origin/master`. Explicit `--base` supports other targets and test repositories.
- One `quality-exception` label and a nonempty `## Quality exception` section waive PR-wide regressions across pushes. They never waive operational failures, checker-test failures, or unrelated CI failures.
- CLI scanner outcomes: 0 clean, 1 regression, 2 operational failure. Unexpected exits, signals, invalid or missing reports, and missing scanner results become operational failures.
- Local commands are strict and do not fetch PR exemption state. No new source suppression, allowance registry, per-PR threshold override, optional structural engine, or checked-in debt inventory.
- Use one check named `Code quality ratchet`, read-only permissions, no inherited secrets, all scanners, live metadata validation, job summaries, and report artifacts. Do not post PR comments.
- Preserve production/Sandbox operational gates and core CI's offline Python audit tests. The new PR exemption must not be reapplied as a strict post-merge deployment check.
- Planning and implementation are separate. Do not install dependencies, implement scanners, publish PRs, or change repository rules while this plan awaits review.
- Keep new files below the approved size limit. Use shared test fixtures instead of copying setup. No em dashes in human-facing text.

## Review focus

1. A truncated or contradictory report, or a missing scanner, must never become an exempt pass. Task 3 validates the report boundary and required scanner set.
2. Head, target branch, or base-tip changes during a run must prevent a stale pass. Task 4 tests preparation and final-metadata comparisons.
3. Baseline materialization and untracked-file handling must not change an author's index or working files. Task 1 compares status and index identity before and after real-process checks.
4. Module extensions and files moved out of excluded directories must not disappear from the source set. Tasks 1 and 2 test `.mts`/`.cts`, declarations, and eligibility-changing renames.
5. A heading embedded in a fenced example or a comment-only rationale must not silently authorize an exception. Task 3 tests rationale parsing and the PR-template case.

## Execution context and file ownership

Continue in the attached managed worktree on `codex/code-quality-ratchets-design`. Before execution, load the selected execution skill and worktree guidance, verify a clean tree, and refresh `origin/master`. Incorporate ordinary upstream changes without touching the dirty primary checkout. Revisit the design only if upstream changes invalidate a requirement.

Port from Perkcord commit `9242ae028830eb405b265184522050e9c09bed3f`, using Git reads of that snapshot rather than assuming another chat's working tree is unchanged. The source is `D:/bench/perkcord`; its relevant implementation files and policy links are recorded in the design.

| Files                                                                                                                    | Responsibility                                                              | Owner task |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------- |
| `scripts/quality-git.mjs`, `scripts/quality-git.test.mjs`                                                                | Reused Git, diff ranges, rename mapping, and eligible-source policy         | 1          |
| `scripts/dup-gate.mjs`, `scripts/dup-gate.test.mjs`, `scripts/dup-gate.integration.test.mjs`                             | Token clones, baseline suppression, and duplication process tests           | 1          |
| `scripts/ratchet-test-helpers.mjs`                                                                                       | Shared temporary repositories and fixture/process helpers                   | 1          |
| `scripts/ratchet-common.mjs`, `scripts/complexity-gate.mjs`, `scripts/file-size-gate.mjs`, their two `*.test.mjs` suites | Shared scanner CLI/reporting and the other two scanners                     | 2          |
| `scripts/check-quality.mjs`, `scripts/check-quality.test.mjs`                                                            | Three-scanner collection, validated reports, strict local CLI               | 3          |
| `scripts/quality-policy.mjs`, `scripts/quality-policy.test.mjs`                                                          | Exception parsing, freshness checks, and final policy decision              | 3          |
| `.github/workflows/code-quality.yml`, `scripts/quality-workflow.test.mjs`                                                | PR orchestration and workflow contracts                                     | 4          |
| `package.json`, `yarn.lock`                                                                                              | Pinned dependencies in task 1; public aliases/check integration in task 5   | 1, 5       |
| `eslint.config.mjs`, `.github/workflows/ci-core.yml`, `.github/workflows/deploy-staging.yml`, `whitelizard.txt`          | Lint the new modules, retire whitelist enforcement, retain diagnostic tools | 5          |
| `AGENTS.md`, `.github/copilot-instructions.md`, `README.md`, `.github/pull_request_template.md`                          | Author/agent instructions and rationale entry point                         | 5          |
| `docs/engineering/code-quality.md`, `docs/adr-20261016-code-quality-ratchets.md`                                         | Operational policy and concise ADR linking to the design                    | 5          |
| `docs/analysis/2026-10-16-code-quality-acceptance.md`                                                                    | Sanitized calibration, hosted results, and activation evidence              | 6          |

Review `ci.yml` and `deploy.yml` when changing their reusable core, but do not edit them merely to repeat the dedicated workflow. No pre-commit hook change is planned.

## Shared interfaces

Keep measurements in the scanner modules. Reuse Perkcord's `main(argv: string[]) -> Promise<0 | 1 | 2>` CLI shape, `--repo`, `--base`, and `--json`. Remove inherited threshold, warning-only, and test-exclusion bypass flags from the supported CLI.

Use JSDoc for these cross-file contracts:

- `GateName = "duplication" | "complexity" | "file-size"`.
- `GateReport = { base: string, mergeBase: string, changedFiles: number, scanned: number, findings: object[], preExisting?: number }`. Preserve scanner-specific finding fields; do not replace them with new generic finding classes.
- `ScannerResult = { name: GateName, exitCode: 0 | 1 | 2, report: GateReport | null, error: string | null }`.
- `QualityReport = { schemaVersion: 1, scanners: ScannerResult[], strictExitCode: 0 | 1 | 2 }`.
- `ScannedRevision = { headSha: string, baseRef: string, baseSha: string, treeSha: string }`.
- `CurrentPr = { headSha: string, baseRef: string, baseSha: string, labels: string[], body: string }`.
- `PolicyResult = { exitCode: 0 | 1 | 2, outcome: "clean" | "exception" | "regression" | "invalid-exception" | "stale" | "error", rationale: string | null, message: string }`.

A report describes exactly three distinct scanner results. For each successful scan, require the known envelope fields, finite nonnegative counts, an array of findings, and consistent baseline metadata. Exit 0 with findings or exit 1 without findings is contradictory. Exit 2 does not require a successful report.

### Task 1: Port shared Git handling and the duplication checker

**Files:** Create the six task-1 files in the map; modify `package.json` and `yarn.lock` for dependencies.

**Interfaces:**

- Consume Perkcord's diff parser, rename, normalized-endpoint, baseline-snapshot, and clone classification code and its relevant tests.
- Produce `SetupError`, `norm(path)`, `overlaps(s1,e1,s2,e2)`, `resolveMergeBase(repo, explicit)`, `changedRanges(repo, mergeBase)`, `isSourcePath(path)`, and the existing diff-parser exports in `quality-git.mjs`.
- Preserve `changedRanges` as a map of path to line-range pairs with the existing `renames`, hunk, and new-path metadata. Preserve `resolveMergeBase`'s `{base, mergeBase} | null` result and in-progress-merge support.
- Produce the duplication CLI and `GateReport`. Retain `fingerprintCloneSource`, `classify`, `filterPreExisting`, and their ported signatures for the retained tests.
- Reuse helper exports `tempRepo`, `withRepo`, `write`, `git`, `commit`, `runGate`, and `assertRatchetJson`. Extend async cleanup support only where an asynchronous test actually needs it.

- [x] **Step 1: Write the failing source-selection test and port relevant regression assertions.**

```js
test("source eligibility includes modules and tests but excludes output", () => {
  for (const path of [
    "vite.config.mts",
    "src/run.cts",
    "test/a.test.ts",
    "src/A.stories.tsx",
  ])
    assert.equal(isSourcePath(path), true, path);
  for (const path of [
    "src/api.d.ts",
    "src/api.d.mts",
    "src/api.d.cts",
    "apps/desktop/src-tauri/gen/a.ts",
    ".worktrees/other/src/a.ts",
    "node_modules/pkg/index.js",
    "build/app.js",
  ])
    assert.equal(isSourcePath(path), false, path);
});
```

Port the existing tests for new copies, same-file copies, formatting-only old clones, shortened clones, rewritten endpoints, preceding deletions, untracked files, unique filesystem renames, and baseline failures. Move Git-specific tests into `quality-git.test.mjs`; separate pure clone tests from scanner/process tests. Keep their actual assertions, not just their test names. Add an eligible-source rename out of generated output and an excluded directory symlink case.

- [x] **Step 2: Run the new suites and observe failure.** Run `node --test scripts/quality-git.test.mjs scripts/dup-gate.test.mjs scripts/dup-gate.integration.test.mjs`. Expect missing implementation/dependencies, not a skipped suite.
- [x] **Step 3: Port the minimum implementation.** Pin `jscpd@5.0.12` and `@jscpd/tokenizer@4.2.5` as dev dependencies and install with Yarn in the isolated worktree. Extract the existing Git operations once, preserve their error paths, and set the default to `origin/master`. Use one source predicate on diff collection and both scans. Add scanner format/pattern mappings so module extensions are measured rather than silently ignored. Normalize line endings consistently for clone identity.
- [x] **Step 4: Finish the duplicate port.** Keep normalized token endpoint identity, baseline suppression, deletion boundaries, temporary-index snapshots, and bounded subprocesses. Remove the Perkcord allowance registry, Markdown/shell parsers, unsupported-language paths, and optional structural engine. Do not add `mdast-util-from-markdown` or `sh-syntax`.
- [x] **Step 5: Verify the suites pass.** Rerun the step-2 command. Tests must compare `git status --porcelain=v1 -z` and the index tree before/after baseline scans and untracked renames. Real-process missing-engine, missing-base, malformed scanner output, and timeout/signal cases must return 2. Use temporary repositories outside the source tree.
- [x] **Step 6: Commit.** Stage only this task's source/tests/dependency files and commit as `feat: add Git-relative duplication checks`.

### Task 2: Port complexity and file-size checks

**Files:** Create `ratchet-common.mjs`, the two scanners, and their tests. Modify `package.json`/`yarn.lock` only to add pinned `eslint-plugin-sonarjs@4.2.0`.

**Interfaces:**

- Consume task 1's Git/path exports and shared test helpers. Import shared Git functions from `quality-git.mjs`, never from the duplication engine.
- Preserve `physicalLines(text)`, `classify(file, lines, baseLines, cap = 1000)`, `functionName(node, sourceCode)`, `joinMessages(records,messages,filePath)`, `candidates(functions,ranges,threshold)`, and `verdicts(candidates,base)` from Perkcord.
- Produce the two CLI entry points, each returning the shared `GateReport` and exit-code contract.

- [x] **Step 1: Write failing boundaries and port the original function-identity tests.**

```js
test("file-size boundaries retain reduced legacy debt", () => {
  assert.equal(classify("a.ts", 999, null), null);
  assert.equal(classify("a.ts", 1000, null).verdict, "NEW");
  assert.equal(classify("a.ts", 1000, 999).verdict, "GREW");
  assert.equal(classify("a.ts", 1220, 1250), null);
  assert.equal(classify("a.ts", 1230, 1220).verdict, "GREW");
  assert.equal(physicalLines("a\r\nb\r\n"), 2);
});
```

Keep Perkcord's executable tests proving complexity 15 passes, 16 fails, unchanged complex functions pass, either metric increasing fails, and parse errors return 2. Retain method/getter/setter identity, duplicate names, callback ordinals, inline-disable resistance, and nested-function position tests. Add real `.cts`/`.mts` files and CommonJS top-level return parsing. Test renamed legacy files and inclusion of tests/stories.

- [x] **Step 2: Observe red.** Run `node --test scripts/complexity-gate.test.mjs scripts/file-size-gate.test.mjs`. Expect missing scanners before implementation.
- [x] **Step 3: Adapt the scanners and reporting.** Reuse the existing ESLint/TypeScript stack, install the pinned SonarJS dependency, and verify compatibility with the actual locked versions. Use script-owned configuration and `noInlineConfig`; keep known function-matching limitations. Include tests by default without the source implementation's false-default override.
- [x] **Step 4: Verify green.** Rerun step 2, then task 1's suites. In each CLI, compare clean, regression, invalid arguments, parser failure, and missing-baseline exit behavior. Check same scanner/base metadata on both sides.
- [x] **Step 5: Commit.** Commit only the two scanners, common code, tests, and dependency changes as `feat: add complexity and file-size checks`.

### Task 3: Add the strict runner and exception policy

**Files:** Create `check-quality.mjs`, `quality-policy.mjs`, and their tests.

**Interfaces:**

- `parseScannerResult(name, processResult) -> ScannerResult`, where `processResult` has `status`, `signal`, `stdout`, and `stderr` from Node's child-process boundary.
- `runQuality({repo, base}) -> Promise<QualityReport>`. It invokes exactly the three task-1/task-2 CLI entry points with the same explicit comparison ref and collects all outcomes.
- `extractRationale(body: string) -> string | null`.
- `evaluatePolicy({report, scanned, current, checkerTestsPassed}) -> PolicyResult`. `scanned` and `current` use the shared revision contracts; local strict execution does not call this PR policy.
- Runner CLI: `node scripts/check-quality.mjs [--repo path] [--base ref] [--json]`. JSON mode emits only one `QualityReport` to stdout, including operational error outcomes; human diagnostics go to stderr.

- [x] **Step 1: Write the failing policy test with literal scanner results.**

```js
test("an exception cannot waive an unavailable scanner", () => {
  const scans = ["duplication", "complexity", "file-size"].map((name) => ({
    name,
    exitCode: 2,
    report: null,
    error: "scanner unavailable",
  }));
  const revision = {
    headSha: "a",
    baseRef: "master",
    baseSha: "b",
    treeSha: "t",
  };
  const result = evaluatePolicy({
    report: { schemaVersion: 1, scanners: scans, strictExitCode: 2 },
    scanned: revision,
    current: {
      ...revision,
      labels: ["quality-exception"],
      body: "## Quality exception\nReason.",
    },
    checkerTestsPassed: true,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.outcome, "error");
});
```

Add table-driven assertions for every design policy row. Assert missing/duplicate scanners, malformed JSON, wrong counts, mismatched baselines, unexpected exits, and exit-0-with-findings become 2. Assert comment-only/template rationale is absent, headings in fenced examples do not open sections, actual sections stop at the next real level-one/two heading, and shell-looking text remains inert data.

- [x] **Step 2: Observe red.** Run `node --test scripts/check-quality.test.mjs scripts/quality-policy.test.mjs`.
- [x] **Step 3: Implement the runner and pure policy.** Keep scanner order fixed, collect all three even after a regression or process failure, validate child-process output before using it, and derive strict exit precedence 2, then 1, then 0. Require the complete scanner set. Use the explicit policy table, not truthiness of an empty findings collection. Fail freshness mismatches and checker-test failure before considering a label.
- [x] **Step 4: Verify green and real-process behavior.** Rerun step 2. In a shared temporary repository, introduce one oversized file, one complex function, and one duplicate and assert `runQuality` reports all three. Verify the CLI returns 1 while retaining all reports. A missing ref returns 2. Repeated calls with a persistent label/current head retain the exception; removing the label returns a regression. No test invokes a shell using the rationale.
- [x] **Step 5: Commit.** Commit the runner, policy, and tests as `feat: add persistent PR quality exceptions`.

### Task 4: Wire the dedicated PR workflow

**Files:** Create `.github/workflows/code-quality.yml` and `scripts/quality-workflow.test.mjs`. Extend policy freshness tests from task 3 as needed.

**Interfaces:** Consume `runQuality`'s report and `evaluatePolicy`. The workflow's GitHub-script adapters populate `ScannedRevision` and `CurrentPr`; they do not reimplement policy. Persist `quality-results.json` and `quality-evidence.json` as artifacts. Evidence includes revision identities, installed scanner versions, checker-test result, and final policy outcome.

- [x] **Step 1: Write failing workflow contracts using the existing `yaml` package.** Parse the YAML and assert the exact job name, seven approved PR events, absence of path filters, read-only permissions, PR concurrency cancellation, exact-head checkout, full history, and existing dependency installer. Assert no privileged trigger or inherited secrets. Assert final policy/reporting still runs after scanner or checker-test failure and cannot replace preparation/test failures with success.
- [x] **Step 2: Observe red.** Run `node --test scripts/quality-workflow.test.mjs`; expect the workflow file to be absent.
- [x] **Step 3: Implement preparation.** Use `pull_request` only, Node 24.15.0, and existing action versions. Check out the event head with persisted credentials disabled, fetch the live base tip, and perform `git merge --no-commit --no-ff` before dependency installation. For already-up-to-date branches, use the checked-out tree and resolved base correctly. Record the scanned head, target ref/tip, and index tree. Never manufacture a baseline at the first checker commit.
- [x] **Step 4: Implement scanning, validation, and reporting.** Run all checker suites through the task-5 alias. Capture the runner's expected 0/1/2 outcome without globally ignoring errors. Re-read PR metadata and the actual target branch tip through the read-only API, then call `evaluatePolicy`. Upload reports and write a summary even on a failure where data exists. Missing data remains blocking. Pass PR body/labels as API data, not generated shell source.
- [x] **Step 5: Verify green and metadata races.** Run `node --test scripts/quality-workflow.test.mjs scripts/quality-policy.test.mjs`. Pin these assertions:

```js
assert.equal(
  evaluatePolicy({
    ...cleanInput,
    current: { ...cleanInput.current, baseSha: "advanced" },
  }).outcome,
  "stale",
);
assert.equal(
  evaluatePolicy({
    ...cleanInput,
    current: { ...cleanInput.current, headSha: "new-push" },
  }).outcome,
  "stale",
);
assert.equal(
  evaluatePolicy({
    ...cleanInput,
    current: { ...cleanInput.current, baseRef: "other" },
  }).outcome,
  "stale",
);
```

Define `cleanInput` once in the policy suite as a complete valid three-scanner input. Add real temporary-Git preparation tests for a live-base merge, an already-current branch, a conflict, and a comparison predating the checker. The metadata adapter must fetch the live branch tip, not treat the event's recorded base SHA as current.

- [x] **Step 6: Commit.** Commit workflow/contracts as `ci: enforce PR code-quality policy`. The workflow intentionally depends on the aliases completed in task 5 before pushing.

### Task 5: Integrate local checks and retire whitelist enforcement

**Files:** Modify `package.json`, `eslint.config.mjs`, `ci-core.yml`, `deploy-staging.yml`, agent/contributor docs, and the PR template; delete `whitelizard.txt`. Create the engineering guide and ADR. Extend `quality-workflow.test.mjs`.

**Interfaces:** Expose `check:duplication`, `check:complexity`, `check:file-size`, and `check:quality` as direct Node script commands. Add `test:dup-gate`, `test:complexity-gate`, `test:file-size-gate`, and `test:quality`. The last lists all eight new test files explicitly so shell glob behavior does not differ between Windows and Linux.

- [x] **Step 1: Add failing integration contracts.** Assert `check:parallel` and `check:ci` include `check:quality` and `test:quality`. Assert the two workflow Lizard invocations and local `code:stats` use `-i -1` without `-W`, the suppression file is absent, and core CI retains the offline Python audit step. Assert production continues to call reusable core CI and neither deployment runs the strict PR-relative scanner. Assert the PR template's untouched exception section extracts no rationale.
- [x] **Step 2: Observe red.** Run `node --test scripts/quality-workflow.test.mjs scripts/quality-policy.test.mjs`; expected failures identify the old commands/template.
- [x] **Step 3: Integrate commands and lint coverage.** Add the aliases and parity hooks. Extend the existing Node-script ESLint override to `.mjs`; append only the new quality/gate/common/helper module patterns to `lint:check` so the new implementation is checked without expanding to unrelated legacy scripts. Keep the existing `lint` fixer and pre-commit hook scope unchanged.
- [x] **Step 4: Retire the absolute gate.** Replace each Lizard warning policy with its supported `-i -1`, keep existing locked-version installation and scc output, and delete the whitelist after searching for remaining consumers. Preserve subprocess/tool failure propagation. Review `ci.yml`, `ci-core.yml`, `deploy.yml`, and `deploy-staging.yml` together.
- [x] **Step 5: Update author guidance.** Document commands, thresholds, supported paths, exit codes, known rename/callback limits, local failures on exempt PRs, and the ban on agents self-exempting. Add the exact `## Quality exception` heading with an HTML comment prompt to the PR template. Keep contributor README edits short. Write the ADR with Status, Date, Owners, Context, Decision, Consequences, Alternatives Considered, and Notes, linking to the approved design.
- [x] **Step 6: Verify green.** Run `yarn test:quality`, `yarn lint:check`, and `yarn prettier:check`, then lint the changed Markdown with `npx --no-install markdownlint-cli2 <changed-markdown-paths>`. Fix new-file findings through simplification/reuse, not source exclusions. Run `yarn check:quality --base origin/master` on the full implementation diff. If an intentional violation remains, retain the failing result and request user authorization before self-exempting the implementation PR.
- [x] **Step 7: Commit.** Commit integration/docs as `chore: replace whitelist enforcement with quality ratchets`.

### Task 6: Calibrate, prove hosted behavior, and activate enforcement

**Files:** Create `docs/analysis/2026-10-16-code-quality-acceptance.md`. Change scanner/workflow code only if the acceptance probes expose a defect, with the owning task's regression tests.

**Interfaces:** Consume the exact emitted check context and application identity from hosted check runs. Produce sanitized evidence of source/test results, hosted behavior, timing, and required-rule read-back. No invented check context, default-branch identity, or repository-settings payload.

- [x] **Step 1: Refresh ownership and state.** Discover the current connected operations before choosing a fallback. Re-read the default branch and active rulesets. Verify the source worktree/head, and record any unrelated upstream changes. Administrative access is not proven merely by successful repository reads.
- [x] **Step 2: Calibrate with bounded local probes.** Use isolated temporary repositories/checkouts for representative backend, React, desktop, root `.mts`, and test changes, including intentional regressions and unchanged debt. Reuse test helpers. Measure baseline/current duplication scanning and set a finite job timeout with measured headroom. Preserve thresholds unless actual evidence supports a reviewed design revision.
- [x] **Step 3: Complete source verification.** Reuse task 5's focused results unless code changed. Run `yarn check:ci` once for broader integration, including its existing docs build. Record failures from unavailable providers/tooling separately from code failures; do not claim a full pass if a required check cannot run. For an explicitly exempt PR, retain the strict local failure and verify the other required checks through hosted CI. Avoid repeating passing checks without changed inputs or unresolved concerns.
- [x] **Step 4: Open the implementation PR and verify its exact head.** Use a concise `[AGENT]` description and attach every created PR using the Desktop attachment tool. Apply the repository's post-push/review skills. Do not apply `quality-exception` to this PR without explicit user authorization.
- [x] **Step 5: Prove exception transitions in a temporary draft PR.** Its body must state that it is a tooling acceptance probe and is not for merge. Obtain explicit user authorization for applying the exception to that probe when presenting its concrete URL. Verify an intentional regression fails; label without rationale fails; label plus rationale passes with findings; a subsequent push retains the exception; removing the reason fails; removing the label restores strict failure. Verify an unavailable scanner still fails with a valid exception. Close the probe after recording results. Attach it as required; do not merge probe commits into product branches.
- [x] **Step 6: Commit acceptance evidence before final readiness checks.** Record the source head, local/hosted outcomes, scan timings, exception transitions, and the fact that rule activation is pending. Commit the sanitized report as `docs: record code-quality acceptance evidence` and push it. Treat the recorded source head as the implementation head before this evidence-only commit, not as the new commit's own hash.
- [ ] **Step 7: Check late feedback and prepare activation.** For merge-ready completion, allow at least 30 minutes from the latest pushed commit timestamp, then refresh checks, comments, inline threads, formal reviews, mutable AI summaries, and mergeability for that exact head. Resolve valid feedback and reread the surfaces. Every new commit resets the window. Save the exact proposed required-check rule with `Code quality ratchet`, its observed integration identity, and strict up-to-date enforcement, preserving existing rules.
- [ ] **Step 8: Activate in a coordinated pre-merge window and reconcile.** A new required context may block other PRs until the workflow reaches the default branch. Apply the reviewed rule only when the implementation PR has passed hosted acceptance and is ready for immediate user-authorized merge. Read back the rule before that merge, as the spec requires. If immediate merge or the administrative write is unavailable, record activation as pending and leave this step unchecked rather than imposing a prolonged block on other PRs. Record final rule read-back and activation state in the owning chat's handoff with a link to the dated source-acceptance report; do not push another evidence commit between activation and merge and reset the readiness window. Report source, hosted checks, required-rule activation, merge, and deployment as separate states. No production deployment is part of this plan.

## Plan review and execution handoff

Recommended execution: **Native**, with one fresh whole-branch reviewer after implementation. The six tasks share the Git and report contracts, and most scanner behavior already has tests to port; keeping implementation in one session avoids repeated context transfer. Subagent-driven execution remains an option for a fresh implementer/reviewer per task at higher context cost.

The user approved this plan and selected Native execution with a fresh whole-branch review. Repository-rule activation and exception use retain the concrete checks described in task 6.

Self-review completed: every design section maps to a task; all five review-focus risks have tests; cross-task names, reports, CLI commands, and exit codes agree. The design's original inventory is historical evidence, not a threshold to bake into tests. Operational acceptance remains unchecked until execution.
