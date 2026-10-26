# Code quality acceptance

The implementation in [PR #415](https://github.com/Chronote-gg/Chronote/pull/415) prevents new or worsened duplication, function complexity, and oversized authored JavaScript/TypeScript files. Existing debt may remain unchanged or shrink. Source verification and the fresh review are complete. Hosted exception transitions are verified, including persistence across a push and refusal to exempt an unavailable scanner. The disposable probe is closed without merging.

Required-check activation is pending. No branch rules, merge, or deployment are claimed by this report. Activation needs an immediate user-authorized merge window, so other PRs are not left waiting for a workflow absent from the default branch.

## Source verification

- All 111 checker tests passed with no skips, including actual scanner processes and Git merge preparation.
- The strict full implementation diff passed all three scanners with zero findings and no exception.
- Source/script lint, formatting, and changed Markdown checks passed.
- Representative temporary-repository probes preserved unchanged legacy debt, then detected regressions in backend, React, desktop, root `.mts`, and test source. Clean comparison took 14.021 seconds; the regressed comparison took 12.526 seconds locally.
- The broader local `yarn check:ci` run did not finish successfully. The mock backend exceeded its 180-second startup limit while cold desktop, Docker, docs, and test builds ran concurrently. Isolated E2E then passed 81 tests, with 88 expected visual-only skips, in 234.66 seconds. Hosted broad CI passed on the prior implementation commit. The final commit still requires an exact-head post-window check refresh.
- The initial local Jest run had four voice-dependency failures while a dependency installation relinked patched packages. After restoring `patch-package`, the affected suites passed all six tests. This is not a claim that the interrupted local aggregate run passed.

## Fresh review

A fresh whole-branch review found four false-pass boundaries. Each was reproduced before its fix, then covered by the final green suite:

1. Malformed scanner findings or contradictory counts could receive exceptions. Scanner-specific field validation now makes them operational errors.
2. Indented ATX and Setext headings could make unrelated PR text count as rationale. The exception section now stops at those Markdown boundaries.
3. User Git diff-prefix settings could hide changed files. Parser input now forces `a/` and `b/` prefixes.
4. jscpd implicitly excluded Git-ignored tracked source and files over 1 MiB. Its invocation now ignores `.gitignore` and removes the practical size ceiling. Both cases have real-scanner tests.

The fresh-review suite passed 107/107. Later hosted review found three further input/identity defects, all reproduced and fixed before the full suite passed 111/111. Scans now verify tracked files against the prepared tree before and after execution, named functions include lexical owners, ambiguous same-name count changes are treated conservatively, and duplication uses an isolated snapshot of Git-eligible source. Ignored untracked scratch files cannot affect its results. A hosted code-quality comment about an ignored extra argument was fixed, replied to, and resolved. A possible double-escaped character in the Actions summary is a deferred cosmetic issue; the JSON artifacts preserve the exact data.

Documented function/callback matching limits, deferred languages and merge queues remain as approved. The PR executes its own checker code; independent trusted-checker enforcement was outside the approved scope. Repository review still owns changes to the tooling itself.

## Hosted acceptance

Implementation source checks passed without `quality-exception`. The emitted check is exactly `Code quality ratchet`, from GitHub Actions, integration ID `15368`.

The first successful hosted job took 200 seconds: dependency installation took 131 seconds, checker tests 32 seconds, and combined scanning 7 seconds. The 20-minute job timeout has measured headroom. Individual external scans retain their three-minute ceiling and fail operationally on timeout.

Exception transitions use [disposable PR #416](https://github.com/Chronote-gg/Chronote/pull/416), explicitly authorized by the user for label and rationale testing. It deliberately added a 1,000-line authored module and is now closed without merging.

| Probe                                    | Expected result            | Observed result            |
| ---------------------------------------- | -------------------------- | -------------------------- |
| Intentional regression, no label         | Regression failure         | Confirmed, run 38953964620 |
| Label with no rationale                  | Invalid exception          | Confirmed, run 38948749820 |
| Label and rationale                      | Pass with findings visible | Confirmed, run 38950217417 |
| New push retaining label and rationale   | Pass with current findings | Confirmed, run 38950918191 |
| Remove rationale, retain label           | Invalid exception          | Confirmed, run 38952812167 |
| Remove label                             | Strict regression failure  | Confirmed, run 38953964620 |
| Unavailable scanner with valid exception | Operational failure        | Confirmed, run 38954453789 |

An initial probe fixture removed other workflows and broke checker integration tests. Its scan still reported the deliberate size regression, but policy correctly rejected the failed tests with operational exit 2. That run is not counted as regression-only acceptance. The workflows were restored before transition testing.

The unavailable-scanner run used the latest source implementation. All checker tests passed before the probe renamed the installed jscpd entry point. The final report retained the size finding and reported duplication exit 2, strict exit 2, and policy outcome `error` despite the valid label and rationale.

Current source quality, build, documentation, lint, desktop, Docker and scanning jobs passed. Broad CI passed in full at the prior source commit; unit, deployment-integration and visual jobs for the last source commit were still running when this evidence was prepared. The final readiness audit must refresh all checks and feedback for the evidence commit after its 30-minute window. This report is not that readiness claim.

## Proposed activation

Add this rule to the existing active default-branch ruleset, preserving all existing rules, conditions, enforcement, and bypass actors:

```json
{
  "type": "required_status_checks",
  "parameters": {
    "do_not_enforce_on_create": false,
    "required_status_checks": [
      { "context": "Code quality ratchet", "integration_id": 15368 }
    ],
    "strict_required_status_checks_policy": true
  }
}
```

The rule uses the observed hosted check identity. GitHub documents these fields and strict up-to-date behavior in its [rules REST API](https://docs.github.com/en/rest/repos/rules#update-a-repository-ruleset). Re-read current settings before constructing the final update. Successful repository reads do not prove administrative write access.

Do not activate until hosted acceptance, late feedback checks, and the immediate merge authorization are complete. Read back the applied rule before that merge. Keep the dated source evidence in this report; record the final rule read-back and merge state in the owning chat without creating another commit between activation and merge.

## Execution decisions and remaining limits

| Decision                                                                                                                                  | Consequence or cost if wrong                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Run focused checker tests per task and broad application tests during acceptance.                                                         | Integration defects could be found later; hosted CI verifies the final source.                  |
| Use the existing installer-supported `--ignore-scripts` path locally and reapply dependency patches after native binary download failure. | Local native voice runtime is not proved by scanner tests.                                      |
| Adapt inherited fixtures to `origin/master` and include tests as authored source.                                                         | An incorrect fixture could hide a porting mismatch; actual Git/scanner cases also run.          |
| Reuse a completed green suite instead of repeating it solely for task bookkeeping.                                                        | Evidence depends on unchanged source between that run and its recorded checkpoint.              |
| Exclude dependencies before ESLint rather than expect an ignored-dependency failure.                                                      | This checks authored code, not installed package internals.                                     |
| Exclude generated `.superpowers` scratch from Prettier.                                                                                   | Scratch prose is not formatting-gated; authored source remains checked.                         |
| Preserve the existing lowercase PR-template filename.                                                                                     | A mistaken path would break Linux checks; hosted contracts passed.                              |
| Run broad CI, hosted checks and fresh review concurrently on a frozen source commit.                                                      | Results must be reconciled before claiming readiness.                                           |
| Keep hosted acceptance, activation, merge and deployment as separate states.                                                              | Confusing those states could overstate enforcement.                                             |
| Retain documented function rename and anonymous-callback ordinal limits.                                                                  | Some identity changes can require an exception.                                                 |
| Keep deferred languages and merge queues outside this rollout; keep approved exceptions persistent across pushes.                         | Those languages remain unmeasured; an active exception covers later pushes.                     |
| Leave an independently trusted checker architecture outside scope.                                                                        | A PR can alter its checker/workflow; repository review remains responsible for tooling changes. |
| Preserve intentional Markdown hard breaks in the ADR.                                                                                     | Cosmetic trailing-space notices remain.                                                         |
| Include lexical owners and treat changed ambiguous same-name counts conservatively after later review.                                    | A touched legacy function can need an exception when indistinguishable sibling counts change.   |

Deferred minor: the Actions summary may double-escape a character in a code block. The JSON artifact preserves exact findings and rationale.

## Evidence appendix

- Default-branch baseline: `149b017ff72bb767e0940a4c1fff84602b7a4e66`.
- Reviewed implementation: `6defdaa4cd0fdcf42a5014ebeb6b546335091fff`.
- Implementation after review fixes: `e572b5a876d5c90ddcc7faa758e3e06a93b699b3`.
- Latest source after hosted review fixes: `4d6695fd97c85dfcf6e68e104ffd4f5f1d699371`.
- First successful hosted job: [run 38943171563](https://github.com/Chronote-gg/Chronote/actions/runs/38943171563).
- Confirmed probe runs: [missing reason](https://github.com/Chronote-gg/Chronote/actions/runs/38948749820), [accepted exception](https://github.com/Chronote-gg/Chronote/actions/runs/38950217417), [persistent across push](https://github.com/Chronote-gg/Chronote/actions/runs/38950918191), [removed reason](https://github.com/Chronote-gg/Chronote/actions/runs/38952812167), [removed label](https://github.com/Chronote-gg/Chronote/actions/runs/38953964620), [unavailable scanner](https://github.com/Chronote-gg/Chronote/actions/runs/38954453789).
- Initial operational probe: [run 38946676274](https://github.com/Chronote-gg/Chronote/actions/runs/38946676274).
- Existing rulesets read: `20028150` (Main Protection, active), `11582842` (Master, active), `19369655` (Code Quality Copilot review for default branch, disabled). No existing required Actions check rule was found in the active snapshots.
- Acceptance evidence is recorded before the final readiness window. Every later commit resets the minimum 30-minute wait before an exact-head post-window check and feedback audit.
