# Proposed code quality checks for Chronote

> Historical research snapshot. The [design](../superpowers/specs/2026-10-16-code-quality-ratchets-design.md) refreshes Chronote's counts and workflow topology from current master and records the approved persistent exception policy.

Prevent pull requests from adding substantial duplication, overly complex functions, or oversized source files. Reuse Perkcord's Git-based checks, which let existing debt stay unchanged or improve. Give agents the same commands locally so they can fix findings before review.

This is a research proposal. No checks, dependencies, labels, or repository settings have changed. The recommended defaults below need agreement before implementation.

## Recommendation and decisions

| Decision     | Recommended default                                                              | Tradeoff                                                                                                           |
| ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Baseline     | Compare with Git history, without a checked-in debt inventory                    | Improvements become the new limit after merge. Approved regressions also become the new baseline.                  |
| Complexity   | Perkcord's cyclomatic and cognitive checks, threshold 15                         | Measures branches and difficulty following control flow, but cannot judge whether an abstraction is useful.        |
| File size    | Fewer than 1,000 physical lines for new authored JavaScript/TypeScript files     | Existing large files may stay unchanged or shrink. Growing one, or crossing the limit, fails.                      |
| Duplication  | Perkcord's token checker, initially 8 lines and 50 tokens                        | Finds substantial repeated blocks, including copies of unchanged code. It does not establish semantic equivalence. |
| Tests        | Include tests, fixtures, mocks, and stories in all three CI checks               | Stops test sprawl too, but repeated test setup may need extraction or a deliberate exception.                      |
| Escape hatch | One PR label, `quality-exception`, with a reason in the PR description           | Simple to operate, but waives all reported quality regressions on that PR. Findings stay visible.                  |
| Rollout      | Calibrate on representative changes, then enforce in the first implementation PR | Avoids an indefinite warning-only phase. Threshold adjustments must be justified by actual false positives.        |

The initial enforced scope is authored JavaScript/TypeScript across the bot, API, frontend, desktop app, docs-site code, scripts, and tests. Exclude dependency folders, build output, generated Tauri files, declarations, lockfiles, and local worktree directories. Rust, Terraform, prose, and semantic similarity checks are deferred. Scanning local worktrees would otherwise count other checkouts as source.

## What already exists

### Perkcord is the closest match

Its [complexity and size documentation](https://github.com/Perkcord/perkcord/blob/9242ae028830eb405b265184522050e9c09bed3f/docs/agentic/complexity-and-size-ratchets.md) describes two checks implemented in `scripts/complexity-gate.mjs` and `scripts/file-size-gate.mjs`, sharing Git and CLI handling through `scripts/ratchet-common.mjs` and `scripts/dup-gate.mjs`.

- A new function above 15 cyclomatic or cognitive complexity fails. For a touched function still above the threshold, an increase in either measure fails. Existing debt can remain equal or decrease.
- New source files at or above 1,000 lines fail. An existing file fails when it is at or above the limit and has grown. A file can grow below the limit.
- The [duplication checker](https://github.com/Perkcord/perkcord/blob/9242ae028830eb405b265184522050e9c09bed3f/docs/agentic/duplication-ratchet.md) scans current and baseline source, then filters findings against the diff. It distinguishes `ADDED TWICE` from `DUPLICATES EXISTING` and suppresses matching pre-existing clones. Formatting an old clone is not automatically new debt.
- Its CI includes tests in all three checks. The checkers return 0 for clean, 1 for a violation, and 2 for a setup failure. Inline ESLint suppressions do not bypass the complexity checker.
- PR CI constructs a merge with the live target branch before installing dependencies and running the checks. Pushes compare against the pre-push commit.

Perkcord does not supply the requested PR-label exemption. It also contains reviewed exceptions for Perkcord business logic and infrastructure. Those must not be copied into Chronote.

### Loominist has the earlier duplication setup

Its `scripts/dup-gate.mjs` is an earlier version of the same approach. Its `scripts/check-file-size.mjs` enforces an absolute limit of fewer than 1,000 lines, including tests. That absolute cap would immediately fail on existing Chronote files. Prefer Perkcord's later implementation and regression tests.

### Chronote has an older complexity gate

`yarn code:stats` runs scc and Lizard. CI, production deploy, and Sandbox deploy each repeat that tooling. Lizard uses `whitelizard.txt`, which has 98 active suppression entries, including paired Windows/Linux paths. Its length check is a function-length check, not a file-size policy.

A read-only inventory of this checkout found:

- 715 tracked authored JavaScript/TypeScript files, excluding declaration files.
- 13 files at or above 1,000 physical lines, including tests. The largest are `src/db.ts` at 2,546 lines and `src/trpc/routers/meetings.ts` at 1,906.
- 13 functions above cyclomatic complexity 15 in the 667 JavaScript/TypeScript files scanned under `src` and `test`, using installed Lizard without suppressions. These values are not an ESLint/SonarJS baseline, and this scan did not cover `apps` or `scripts`.

Chronote already has a label-based exception pattern in `.github/workflows/docs-policy.yml`. It handles PR open, push, reopen, label, and unlabel events through an ordinary `pull_request` workflow.

## How the proposed checks behave

Local commands compare the working tree with the target branch's merge base and include untracked files. CI checks the proposed merge against the current target branch. Use the same scanner versions for both sides. Renames retain their baseline where supported, and missing history or a failed parser must fail visibly.

For example, a 1,250-line file reduced to 1,220 lines passes. After it merges, a later PR growing it to 1,230 fails. A new 700-line file passes the size check; a new 1,000-line file fails. Deleting unrelated code cannot offset a newly complex function or duplicate elsewhere.

Function matching has limits. Perkcord matches names and anonymous callback ordinals within files. Renaming a complex function or inserting callbacks can make it appear new. Preserve that documented behavior and test it during calibration instead of promising perfect refactor recognition.

## Escape hatch

Always run all scanners and publish their findings. After successful scans, the policy result may accept violation exit code 1 when the PR has `quality-exception` and a nonempty explanation under a documented heading in its description. Exit code 2, missing reports, failed checker tests, and unrelated CI failures remain blocking.

The label applies to the PR, including later commits. Each run must report the current findings and rationale so the reviewer can assess the full diff. Adding or removing the label, editing the rationale, or pushing commits must rerun the decision for the current head. Read current label state before the verdict and cancel superseded runs to reduce stale results.

Use ordinary `pull_request` execution with read-only permissions and no secrets. GitHub supports `labeled` and `unlabeled` events, but they must be explicitly requested. See [GitHub's event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request). Keep any future privileged metadata workflow separate from execution of PR code, following [GitHub's security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).

The authority is GitHub's label permission. It cannot distinguish a human from an agent using the same credential. Agent instructions must prohibit self-exemption without explicit user authorization. A separate human-only approval identity would be stronger, but is outside this proposal.

## Proposed changeset

1. Adapt Perkcord's three checkers, shared Git handling, and relevant Node test suites. Restrict the duplication scan to the initial code scope so unrelated Markdown and shell normalizers and private exception registries are unnecessary. Preserve clone identity, diff ranges, deletion handling, and rename behavior with their tests.
2. Add pinned scanner dependencies to `package.json` and `yarn.lock`, reusing Chronote's installed ESLint and TypeScript tooling. Add `check:duplication`, `check:complexity`, `check:file-size`, a combined `check:quality`, and checker tests. Wire the combined check into `check:parallel` and `check:ci`.
3. Add `.github/workflows/code-quality.yml`, with full history, a live-target merge, scanner tests, all three reports, and one final policy verdict. Include PR label and description events without rerunning the rest of application CI. After the check exists, make that exact check required in the target branch rules. Running CI alone does not guarantee merge enforcement.
4. Keep scc reporting. Convert Lizard to an unsuppressed diagnostic report using its supported warning-only option, and remove the old suppression file once no caller needs it. Update `.github/workflows/ci.yml`, `deploy.yml`, and `deploy-staging.yml` together so accepted PR exceptions do not fail an obsolete absolute gate during deployment. Preserve failures when the reporting tool itself cannot run.
5. Update `AGENTS.md` and `.github/copilot-instructions.md` to require local quality checks and explain how agents respond to findings. Document the commands, scope, thresholds, and exception policy in `docs/analysis` or a dedicated engineering guide. Keep the existing pre-commit formatting hook lightweight initially.

No runtime behavior, user data, product analytics, or public product documentation changes are needed. Implement in an isolated worktree because the current checkout contains unrelated edits.

## Validation before enforcement

- Prove unchanged and reduced debt passes, new violations fail, and improvements in one location cannot pay for regressions elsewhere.
- Cover untracked files, CRLF paths, deletions, renames, old-clone formatting, rewritten clone endpoints, generated output, and test inclusion using the existing regression cases where applicable.
- Test missing scanner, missing history, parser failure, and malformed report. None may become a clean or exempt result.
- Test label absent, present with and without rationale, removed, and still present after another push. Test stale events and confirm the exact current head is checked.
- Exercise representative Chronote backend, React, desktop, and test changes. Measure duplication scan duration before selecting the job timeout. Do not report a clean unchanged checkout as proof that regression detection works.
- Run focused checker tests and formatting/lint checks, then inspect a hosted PR run. Confirm required branch rules separately from workflow success.

## Evidence and limits

Research date: October 16, 2026. Findings come from local source reads, Git snapshot checks, the tracked-file inventory, an installed Lizard scan, and upstream documentation. No remote branch fetch or hosted workflow execution was performed.

| Repository | Inspected snapshot                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chronote   | `7157db5f941d13adf528067b787505a2ae47071d` with unrelated working-tree changes                                              | `package.json`, `whitelizard.txt`, CI/deploy/docs-policy workflows, tracked source                                                                                                                                                                                                                                                    |
| Perkcord   | `9242ae028830eb405b265184522050e9c09bed3f`, matching the locally recorded `origin/main`; checker files had no local changes | [Complexity and size policy](https://github.com/Perkcord/perkcord/blob/9242ae028830eb405b265184522050e9c09bed3f/docs/agentic/complexity-and-size-ratchets.md), [duplication policy](https://github.com/Perkcord/perkcord/blob/9242ae028830eb405b265184522050e9c09bed3f/docs/agentic/duplication-ratchet.md), checker source and tests |
| Loominist  | `9fb793f26ec15d32189f7af3c7eed2caa77afe5b`; recorded `origin/main` is newer, but the two inspected checker scripts match it | [File-size checker](https://github.com/BASIC-BIT/loominist/blob/9fb793f26ec15d32189f7af3c7eed2caa77afe5b/scripts/check-file-size.mjs), duplication checker and local CI                                                                                                                                                               |

ESLint documents its branching metric in the [complexity rule reference](https://eslint.org/docs/latest/rules/complexity). Scanner output is a review aid, not proof of elegant design. A small function can still have a poor interface, and mechanically extracting helpers can make code harder to follow.

Chronote currently has no root `node_modules`, and the Perkcord root scanner dependencies were also absent. The Perkcord checker suites, token duplication scan, cognitive complexity scan, and hosted exception behavior have therefore not been run here. Dependency compatibility and false-positive rates remain implementation acceptance work.
