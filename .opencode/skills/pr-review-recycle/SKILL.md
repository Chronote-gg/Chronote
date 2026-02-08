# PR Review Recycle Loop (OpenCode wrapper)

Use this skill when you need to process automated PR review feedback (Copilot, Greptile, Codex) and iterate until:

- All automated review threads are addressed (fixed, explained, or explicitly deferred).
- PR checks are green.
- The PR is ready for a human to merge.

Canonical workflow: `.codex/prompts/automated-review-cycle.md`.

This file is intentionally a thin wrapper for OpenCode usage and repo-specific standing rules.

## Standing Rules (OpenCode-specific)

- Prefix all GitHub prose (PR comments, issue comments, PR descriptions) with `[AGENT]`.
- Do not create commits unless explicitly asked by the user.
- Do not force push.
- Do not amend commits unless explicitly asked.
- Do not bypass git hooks (for example, do not use `--no-verify`).
- Do not commit secrets or `.env` files.

## Inputs You Need

- PR number (or PR URL).
- Repo owner/name.

## Practical Command Set

Snapshot state:

```bash
gh pr view <PR> --json url,title,headRefName,baseRefName,state,mergeable,updatedAt
gh pr view <PR> --json statusCheckRollup
gh pr diff <PR>
```

Collect review threads (paginate until `hasNextPage=false`):

```bash
gh api graphql -f query='query($owner:String!, $name:String!, $number:Int!, $after:String){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ reviewThreads(first:100, after:$after){ totalCount pageInfo{hasNextPage endCursor} nodes{ id isResolved isOutdated comments(first:50){ nodes{ id author{login} body } } } } } } }' \
  -F owner=<OWNER> -F name=<REPO> -F number=<PR> -F after=<CURSOR_OR_null>
```

Resolve a thread after replying:

```bash
gh api graphql -f query='mutation($threadId:ID!){ resolveReviewThread(input:{threadId:$threadId}){ thread{ id isResolved } } }' \
  -F threadId=<THREAD_ID>
```

## Permissions Note

Inline replies and `resolveReviewThread` can fail due to token permissions.

Fallback behavior:

- Reply where possible.
- Add a PR-level `[AGENT]` comment listing what you addressed, and ask a maintainer to resolve remaining threads.
