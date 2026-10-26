# Code quality checks that prevent new debt

## Review brief

Add local and required PR checks that stop agents from introducing substantial duplication, overly complex functions, or oversized source files. Existing debt may stay unchanged or improve. Reuse Perkcord's implementation and tests, with a JavaScript/TypeScript scope suited to Chronote.

The user approved this design in chat on October 16, 2026, including one PR-wide `quality-exception` label plus a written rationale remaining active across pushes. That approval authorizes writing the implementation plan. Implementation and repository-setting changes await plan review and selection of an execution method.

The main tradeoffs are deliberate. Tests receive the same checks as production code. Exceptions waive every reported regression on the PR, including later commits. Required checks will also require an up-to-date branch so another merge cannot silently invalidate the comparison.

No product behavior, stored data, public URLs, authentication, or deployment authority changes. Product UX research is unnecessary for this engineering workflow.

## Decisions and scope

| Status    | Decision                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed | One PR-wide exception label plus rationale. Keep it active across pushes. Always show current findings.                                 |
| Approved  | Use Git as the baseline, with no checked-in inventory of grandfathered violations.                                                      |
| Approved  | Start with complexity 15, file size below 1,000 physical lines, and token duplicates of at least 8 lines and 50 tokens.                 |
| Approved  | Include authored tests, mocks, fixtures, and stories in the same checks.                                                                |
| Approved  | Make one dedicated Actions check required and require branches to be up to date.                                                        |
| Approved  | Retain scc and Lizard as diagnostic reports, replacing the blocking Lizard whitelist policy.                                            |
| Deferred  | Rust, Terraform, CSS, shell, prose, semantic similarity, custom per-file allowances, pre-commit scanning, and shared tooling packaging. |

The initial source set is authored `.js`, `.jsx`, `.cjs`, `.mjs`, `.ts`, `.tsx`, `.cts`, and `.mts` files throughout the repository. This includes bot, API, frontend, desktop, docs-site code, scripts, tests, and root configuration files. In particular, `vite.config.mts` must be checked.

Exclude dependencies, generated declarations and code, build output, coverage, Tauri generated/target directories, Git metadata, and nested worktrees. Apply the same exclusions when collecting diff paths and scanning baseline and current source. A dependency folder must not become eligible merely because it contains an untracked file. Do not follow symlinks outside the source tree.

## Author and reviewer experience

1. The author runs `yarn check:quality` before committing. It scans the working tree, including eligible untracked files, against the target branch's merge base.
2. Findings identify the file and location, the affected function or duplicate partner, the current value, and the baseline value where applicable. They explain the action: simplify the function, split the file, reuse existing code, or extract a shared implementation.
3. The PR runs the same scanners on its proposed merge with the current target branch. A single check named `Code quality ratchet` reports success, regression, accepted exception, or an operational failure.
4. If the exception is needed, the author writes a reason under `## Quality exception` in the PR description. A maintainer applies `quality-exception`. Agents need explicit user authorization before applying it.
5. Every later push rescans the full PR. The label stays active, and reviewers see the current findings with the reason. Removing the label restores strict enforcement. Removing the reason while retaining the label fails the policy.

Local commands stay strict and do not query GitHub or inherit PR exemptions. An intentionally exempt PR may therefore fail the strict local command. The author reports that result accurately and explains the exception; there is no local claim of clean results.

No scanner posts PR comments. Use the Actions job summary and machine-readable artifacts to avoid repeated bot messages. Summaries contain locations and metrics, rather than source excerpts.

## Check semantics

### Complexity

Use ESLint core cyclomatic complexity and SonarJS cognitive complexity, with a script-owned configuration independent of the repository lint configuration. A value of 15 passes; 16 is above the limit. Inline ESLint configuration cannot suppress these measurements.

Only touched functions that currently exceed either threshold are candidates. A new candidate fails. An existing candidate fails if either complexity measure increased relative to the baseline. This deliberately follows Perkcord's semantics even when one measure decreases while the other increases.

Match functions using Perkcord's names, class/member identity, duplicate-name disambiguation, and anonymous callback ordinals. Retain its tests. Renaming a complex function or inserting callbacks can make an existing function appear new. Document this limitation rather than adding a second identity mechanism.

Parse the supported module extensions correctly, including CommonJS and TypeScript module configuration. A parser failure is an operational error, never a clean file.

### File size

Count physical lines consistently for LF and CRLF. A terminal newline does not create an extra line. New files must have fewer than 1,000 lines.

An existing file fails if it is now at or above 1,000 lines and longer than its baseline version. An unchanged or shrinking oversized file passes. A recognized rename retains the old file's baseline. An unrecognized move may be treated as a new file.

Examples: 999 to 1,000 fails; 1,250 to 1,220 passes; 1,250 to 1,251 fails. After 1,220 merges, 1,230 fails on the next PR. A reduction in another file cannot offset growth.

### Duplication

Use Perkcord's locked token scanner with at least 8 lines and 50 tokens, ignoring comments for detection. Scan the whole eligible source set so a changed block can be compared with an untouched file.

Compare current clone pairs with pairs from a baseline snapshot, using the same scanner and normalized endpoint identity. Intersect new findings with changed ranges, including deletion boundaries. Formatting old copies does not create new debt, while rewriting both endpoints can create a new clone.

Report `ADDED TWICE` and `DUPLICATES EXISTING` with both locations. Preserve Perkcord's tested handling of normalized content, shortened clones, diff ranges, and renames. Do not replace that behavior with a repository-wide duplication percentage.

Restrict both scans to the initial language scope. Leave out Perkcord's business-specific exception registry and unrelated Markdown and shell normalization. Do not reintroduce its older optional structural matching engine.

### Operational outcomes

Each scanner returns 0 for clean, 1 for a regression, and 2 for an operational failure. Unexpected exits or signals, missing history, unsupported report shapes, missing reports, and unavailable dependencies become operational failures.

The combined runner executes every scanner even when another reports a regression. It retains individual outcomes and emits one report. Its strict result is 2 if any scanner fails operationally, otherwise 1 if any scanner reports a regression, otherwise 0. Checker-test failures also block CI.

No exception may waive operational failures, failed checker tests, workflow preparation errors, or failures in other CI checks.

## Exception policy

The exception is PR-wide and deliberately persists across pushes. Require the label and nonempty text under the exact level-two heading `## Quality exception`. The section ends at the next level-one or level-two heading. Ignore HTML comments and whitespace when deciding whether the reason is present. The template provides an HTML comment prompt, so the untouched template is insufficient.

Humans assess whether the explanation is convincing. No language model or keyword scoring determines whether the reason is good enough. Treat the PR description as data and never interpolate it into executable shell code.

| Scanner result          | Label and reason         | Policy result                                                 |
| ----------------------- | ------------------------ | ------------------------------------------------------------- |
| All clean               | No label                 | Pass                                                          |
| All clean               | Label and valid reason   | Pass, report that the exception is currently unnecessary      |
| One or more regressions | Label and valid reason   | Pass with an explicit accepted-exception summary              |
| One or more regressions | No label                 | Fail with findings                                            |
| Any complete scan       | Label but missing reason | Fail and explain how to supply the reason or remove the label |
| Any operational failure | Any state                | Fail                                                          |

The label relies on GitHub's label permissions. It cannot distinguish an agent from a person using the same account token. The agent instruction is therefore part of the operating policy, not a claim of a separate technical authorization boundary.

There is no source-comment suppression, growing allowlist, threshold change on an individual PR, or checked-in baseline file. If a labeled regression merges, its resulting code becomes ordinary legacy debt for subsequent comparisons. The exception is not a promise to restore the old limit later.

## Architecture and CI behavior

Keep the implementation within existing scripts and Actions patterns:

- Three scanner modules own measurements and regression verdicts.
- Shared Git/path handling owns baseline resolution, eligible paths, changed ranges, untracked files, and rename mappings.
- One combined runner owns collection and strict local results.
- One small, independently tested policy function owns the label/rationale decision. The workflow supplies live PR metadata and scanner outcomes; the policy function does not fetch GitHub data.
- A dedicated `.github/workflows/code-quality.yml` runs preparation, checker tests, all scanners, reporting, and the final policy decision in one job. Use a unique job name distinct from the existing `Code Quality (Lint, Format, Markdown)` job.

A separate workflow keeps label or rationale edits from restarting application tests, browser work, and builds. Trigger on `opened`, `synchronize`, `reopened`, `ready_for_review`, `edited`, `labeled`, and `unlabeled` PR events. Do not add a path filter that could leave a required check pending. Use a PR-specific concurrency group with cancellation of superseded runs.

Run with read-only contents and PR permissions, no inherited secrets, and no deployment credentials. Reuse `scripts/ci-install-dependencies.sh`. Fetch full history, check out the event's exact PR head, fetch the live base branch tip, and materialize its merge before installing dependencies and testing the checker code. A merge conflict blocks the run.

Compare that merge tree directly with the fetched base tip, using Perkcord's support for an in-progress merge. Use the same installed scanner versions on the baseline and current trees. Scan the full PR even when the comparison predates the introduction of these checkers. Do not substitute the first checker commit as the baseline.

Before reporting the verdict, re-read the current PR head, base branch identity, labels, and body. A stale head or retargeted PR must not pass under an old result. Confirm the base tip still matches the scanned tip; if it advanced, fail with a clear rerun message rather than claiming a current comparison. This is a bounded check, not a retry loop.

GitHub events and reads cannot provide an atomic transaction with merge. Requiring an up-to-date PR branch covers later target-branch advances. New pushes and metadata changes rerun the workflow, and the final live read reduces stale label/body decisions. Do not claim this is a security system against authors who can modify the workflow itself.

Artifacts record the PR head, fetched base tip, merge tree identity, scanner versions, individual outcomes, and findings. The job summary states which check failed or which exception was accepted, with the current rationale. Reporting does not convert absent or malformed scanner output into a clean result.

## Local and deployment integration

Expose `check:duplication`, `check:complexity`, `check:file-size`, `check:quality`, and focused checker tests in `package.json`. Include tests by default, accept an explicit base ref, and use `origin/master` for this repository's ordinary local comparison. Avoid a stale newly added baseline file.

Add the strict combined command and checker tests to local CI-parity checks. Keep the existing pre-commit formatting hook unchanged. Pin scanner dependencies in `yarn.lock`; use the existing ESLint and TypeScript stack and verify compatibility during implementation.

The current production deployment calls `.github/workflows/ci-core.yml`; Sandbox still contains a separate Lizard step. Keep their diagnostic behavior aligned. Retain scc reporting, run Lizard without the suppression file using its supported warning-only option, and remove `whitelizard.txt` once no caller uses it. Preserve real tool-execution failures. The existing offline Python audit-tool tests in the core Code Stats job must remain.

The new regression policy gates PR merges. Production and Sandbox do not reapply a strict local diff check after merge or require rediscovering the old PR label. Such a check would reject an approved exception again. Existing deployment build, lint, test, security, and operational gates remain. Direct pushes that bypass the PR rule are outside this policy's guarantee.

Update `AGENTS.md`, `.github/copilot-instructions.md`, the contributor check references in `README.md`, and the PR template. Put detailed policy in a dedicated engineering guide. No public product-doc update is required.

## Activation and rollout

Repository source and hosted enforcement are separate acceptance steps. The live rulesets currently have no required Actions status-check rule, so shipping a workflow alone would not block merges.

1. Build the checkers, regression tests, policy, workflow, and documentation in the implementation PR.
2. Calibrate on actual Chronote changes and intentional regressions across backend, React, desktop, scripts, and tests. Start with the approved thresholds. Correct false positives before enforcement, and document any proposed threshold change for review.
3. Exercise hosted PR behavior, including label addition/removal, rationale edits, further pushes under an exception, and operational failure with the label present. Confirm the exact emitted check context.
4. Add `Code quality ratchet` as a required Actions check for the default branch, with strict up-to-date checking. Preserve existing repository rules. Inspect the exact settings change before applying it during implementation, then read it back.
5. Confirm the implementation PR has a terminal passing check and the rule really requires it before merging. Enforce from rollout rather than leaving an indefinite warning-only phase.

Strict up-to-date enforcement can require authors to merge or rebase after unrelated PRs land. That cost is preferable to accepting stale comparisons. Merge-queue support is deferred because it is not part of the currently inspected workflow.

## Alternatives considered

| Approach                                         | Why not choose it                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Repository-wide hard caps                        | Would fail on current debt and encourage another exclusion list.                                                             |
| ESLint-only changes                              | Cannot cover cross-file duplicates or a Git-relative file-size limit.                                                        |
| Checked-in violation inventory                   | Adds baseline update and conflict handling when Git already provides the comparison.                                         |
| Copy all of Perkcord's tooling                   | Brings unrelated language handling and reviewed exceptions into Chronote. Preserve the relevant tested behavior instead.     |
| Per-check labels or per-push exception approvals | More policy and operator work. The user selected one persistent PR-wide exception.                                           |
| New pre-commit scans                             | Adds commit latency before scan duration and false-positive rates are known. Local commands and CI are sufficient initially. |

## Acceptance evidence required

- Boundary cases: 15/16 complexity and 999/1,000 lines, new/existing files, unchanged debt, shrinking debt, and growth after a prior improvement.
- Clone cases: copies of unchanged code, copies introduced twice, formatted old copies, shortened old copies, and rewritten endpoints. Removing another clone cannot pay for a new clone.
- Git/path cases: untracked files, CRLF, Windows paths, renames, deletions, moved target branches, merge conflicts, full inaugural PR diffs, supported module extensions, generated files, and nested worktrees.
- Failure cases: missing engines/history, parser failures, timeout or signal, invalid reports, failed checker tests, and failure while the exception is present.
- Policy cases: the complete decision table, comment-only rationale, section boundaries, injection-shaped rationale treated as data, persistent labels after pushes, label removal, and stale PR/base metadata.
- Hosted acceptance: current-head check results, visible exception findings, a new push retaining the exception, label removal restoring enforcement, and read-back of the required-check rule.
- Performance: measure a representative full baseline/current duplication scan. Set a finite CI timeout with headroom for the observed run. An unchanged-tree scan alone does not prove regression detection.

Metrics cannot prove good design. Reviewers should reject a gratuitous helper introduced solely to lower a score when it makes the code harder to understand. Meaningful repeated test cases can use the approved exception process.

## Evidence appendix

### Refreshed Chronote snapshot

The first research inventory used an older checkout branch. This design refreshes that evidence from `master` at `149b017ff72bb767e0940a4c1fff84602b7a4e66`, also confirmed through the connected GitHub branch API on October 16, 2026.

A tracked-file scan found 1,125 JavaScript/TypeScript files matching the earlier inventory's extension set, excluding declarations, with 34 files at or above 1,000 physical lines. The largest was `src/db.ts` at 4,573 lines. Lizard without suppressions found 43 functions above cyclomatic complexity 15 across 1,057 files under `src` and `test`. The suppression file had 102 active entries. Lizard measurements are not ESLint/SonarJS measurements, and the inventory does not yet include the newly specified module extensions.

Current code uses `ci-core.yml` for PR core checks and production deployment. Sandbox has its own Code Stats job. Shared core CI already uses the locked Lizard version in `uv.lock` and also runs offline audit-tool tests. These details supersede the earlier proposal's workflow file list.

Read-only GitHub inspection found the active default-branch rulesets `Main Protection` and `Master`. Their returned rules include PR/review, code quality, and code scanning requirements but no required Actions status-check rule. No settings were changed.

### Reuse and references

- [Research and earlier repository comparison](../../analysis/2026-10-16-code-quality-ratchets.md). Treat its earlier Chronote counts and workflow topology as historical.
- [Perkcord complexity and size policy](https://github.com/Perkcord/perkcord/blob/9242ae028830eb405b265184522050e9c09bed3f/docs/agentic/complexity-and-size-ratchets.md).
- [Perkcord duplication policy](https://github.com/Perkcord/perkcord/blob/9242ae028830eb405b265184522050e9c09bed3f/docs/agentic/duplication-ratchet.md).
- [GitHub PR event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).
- [GitHub guidance for privileged PR workflows](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).
- [ESLint complexity reference](https://eslint.org/docs/latest/rules/complexity).

No scanner dependencies were installed and no product, scanner, workflow, label, or repository-setting implementation was made in this design stage. Token/cognitive scan calibration and hosted exception acceptance remain implementation work.
