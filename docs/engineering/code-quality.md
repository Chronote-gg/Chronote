# Code quality checks

Run `yarn check:quality` before committing. It launches the pinned [BASIC-BIT/quality-ratchet](https://github.com/BASIC-BIT/quality-ratchet) tool in a separate checkout. The tool compares the working tree, including eligible untracked files, with the merge base of the default branch recorded in `origin/HEAD`. Fetch the intended target first and pass `--base origin/master` for an explicit target. The command does not fetch.

The checks prevent new debt. Existing violations may remain unchanged or improve. Once an improvement merges, its new value becomes the baseline. A reduction elsewhere cannot pay for a regression.

| Check       | Rule                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Complexity  | New touched functions above 15 cyclomatic or cognitive complexity fail. Existing offenders fail if either measure increases.                |
| File size   | New files must have fewer than 1,000 physical lines. Existing files at or above that limit may not grow.                                    |
| Duplication | New repeated blocks of at least 8 lines and 50 tokens fail. Copies of unchanged source are included; matching old copies are grandfathered. |

Use `yarn check:quality --base origin/master --json` for the complete structured report. `yarn test:quality` runs Chronote's workflow and launcher contracts. Scanner and exception-policy regression suites live in the shared repository. The old individual scanner commands have been removed.

## Scope and outcomes

All authored JavaScript/TypeScript files are included, including tests, fixtures, mocks, stories, scripts, and root configuration. Module variants `.mjs`, `.cjs`, `.mts`, and `.cts` are included.

Dependencies, generated declarations/code, build output, coverage, Tauri generated/target output, Git metadata, and nested worktrees are excluded. Rust, Terraform, CSS, shell, and prose are outside this initial scope. External directory symlinks are not followed. Tracked source remains eligible even when it matches `.gitignore`; ignored untracked scratch files do not participate in duplication scans.

Exit codes are 0 for clean, 1 for a regression, and 2 for an operational failure. The combined command runs all three scanners. An unavailable scanner, parser error, missing baseline, or malformed report is not clean.

Function matching uses lexical owners, names, and callback ordinals within a file. If the count of indistinguishable same-name functions changes, touched offenders are conservatively treated as new. Renaming a complex function or inserting callbacks can make it appear new. Recognized file renames retain their baseline. Consider these limits when interpreting a finding.

## PR exceptions

The dedicated `Code quality ratchet` check analyzes the proposed merge with the live target branch. It also verifies current PR metadata before accepting the result. Findings appear in the Actions summary and report artifacts.

For a deliberate exception, add a reason under this exact heading in the PR description:

```markdown
## Quality exception

Explain why the current regressions should be accepted.
```

A maintainer then applies `quality-exception`. Agents need explicit user authorization before applying the label. The exception covers all three checks and remains active across pushes, with current findings shown on each run. A comment-only template section is insufficient.

Removing the label restores strict enforcement. Keeping the label while removing the reason fails the policy, even when the scanners are clean. Tool-verification, scanner, configuration, preparation, stale-result, and unrelated CI failures remain blocking.

Local commands remain strict and do not fetch exemptions. An intentionally exempt PR can fail `yarn check:quality` locally. Report that failure accurately rather than claiming a clean result.

If an exempt regression merges, it becomes the ordinary Git baseline for later PRs. The label does not schedule cleanup or preserve an earlier limit.

## CI and deployment

The dedicated job keeps the name `Code quality ratchet`. Its checkout and root shared action use full commit pins. The action installs its own locked production dependencies without application lifecycle scripts, validates the live target policy, and uploads available reports with seven-day retention. It needs only `contents: read` and `pull-requests: read`.

A workflow definition alone does not prove the emitted check name or effective branch-rule enforcement. Confirm both on the migration PR, preserving unrelated rules. If the required context remains unchanged, no settings update is needed. Branches may need rebasing after another PR lands.

`yarn code:stats` retains scc and unsuppressed Lizard diagnostics. Lizard warnings do not block deployment; tool execution failures still do. Production and Sandbox retain their existing operational checks and do not reapply a strict PR-relative check after an exception has merged.

Do not suppress a finding through source comments, a growing allowlist, threshold flags, or a checked-in debt inventory. Simplify or share the implementation, or use the reviewed PR exception. Small functions and files still need sensible interfaces; extracting a helper solely to lower a score can make the code worse.

## Active shared-tool policy

The root [quality-ratchet.json](../../quality-ratchet.json) owns Chronote's policy.
It was staged on the target branch before this migration. The same target-branch
policy applies to both source trees. A proposed policy edit cannot relax its
own comparison.

All three checks remain in ratchet mode at the limits above. Complexity, file
size, and duplication include all eight JS/TS extensions, tests, stories,
fixtures, scripts, and root configuration. Duplication remains JS/TS-only.
The shared test-debt and oversized-test reports are disabled because this
repository has no equivalent reports today. Oversized tests still obey the
blocking file-growth rule.

The explicit exclusions preserve dependency/build output, generated code and
declarations, package-manager lockfiles, Terraform lockfiles, generated
Docusaurus/Tauri output, and `.superpowers` work directories. The shared tool also
always excludes Git metadata, dependency/cache directories, nested worktrees,
generated output, and symlinks. No authored test directory is excluded.
Configuration changes are validated as proposals; the target branch's policy
governs a shared-tool comparison.

## Local tool setup

Use Node 24.15.0 or a newer Node 24 release. Keep the tool separate from the application checkout. For example, in PowerShell:

```powershell
git clone https://github.com/BASIC-BIT/quality-ratchet.git D:/tools/quality-ratchet
git -C D:/tools/quality-ratchet checkout --detach 0873869f6b8fd80150d24689849ec0aebd94e9dd
Push-Location D:/tools/quality-ratchet
npm ci --ignore-scripts --omit=dev --include=optional
Pop-Location
$env:QUALITY_RATCHET_HOME = "D:/tools/quality-ratchet"
yarn check:quality --base origin/master
```

`QUALITY_RATCHET_HOME` only locates the tool. The launcher verifies its HEAD matches the workflow pin and refuses tracked changes or untracked source files. It starts the CLI with the current Node executable, literal arguments, and no shell. Missing setup exits with code 2 and setup instructions. Keep the checkout clean; install dependencies without lifecycle scripts.

On Linux, set `QUALITY_RATCHET_HOME=/path/to/quality-ratchet` in the command environment after the same checkout and install steps. No threshold, mode, scope, or exception override is available through this setting.

The shared [design](https://github.com/BASIC-BIT/quality-ratchet/blob/0873869f6b8fd80150d24689849ec0aebd94e9dd/docs/superpowers/specs/2026-10-16-quality-ratchet-design.md) and [implementation plan](https://github.com/BASIC-BIT/quality-ratchet/blob/0873869f6b8fd80150d24689849ec0aebd94e9dd/docs/superpowers/plans/2026-10-16-quality-ratchet.md) are maintained in the shared repository. Earlier Chronote design and acceptance documents describe the original local implementation.
