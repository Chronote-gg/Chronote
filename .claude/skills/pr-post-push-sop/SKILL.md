---
name: pr-post-push-sop
description: Use every time you push a commit to an active pull request, to verify the PR is truly stable before reporting merge readiness. Covers the post-push wait window, AI review audit (Copilot/Greptile/Codex), and the gh commands to snapshot PR state. Trigger on "I pushed" or "is the PR ready to merge".
---

# PR Post Push SOP

Use this skill every time you push a commit to an active pull request. This is
the Claude Code mirror of `.opencode/skills/pr-post-push-sop/SKILL.md`.

## Objective

Make sure the PR is truly stable before reporting merge readiness.

## Required Loop

1. Capture current PR state and checks.
2. Audit unresolved AI review feedback (Copilot, Greptile, Codex) across:
   - Review threads (paginate until `hasNextPage=false`)
   - PR issue comments for bot follow-ups
3. Fix, reply, and resolve all actionable AI comments.
4. Re-run relevant local checks for the latest changes.
5. Push updates.
6. Wait at least 5 minutes after the latest push.
7. Re-run the review and checks audit.
8. Only mark merge-ready if:
   - Required checks are green
   - No unresolved actionable AI feedback remains
   - No new AI comments arrived during the wait window

## Command Hints

```bash
gh pr view <PR> --json url,headRefName,statusCheckRollup,mergeable,updatedAt
gh api graphql -f query='query($owner:String!, $name:String!, $number:Int!, $after:String){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ reviewThreads(first:100, after:$after){ pageInfo{hasNextPage endCursor} nodes{ id isResolved isOutdated comments(first:50){ nodes{ id author{login} body createdAt } } } } } } }' -F owner=<OWNER> -F name=<REPO> -F number=<PR> -F after=<CURSOR_OR_null>
gh pr view <PR> --comments
```

## Repo Rules Reminder

- Prefix GitHub prose with `[AGENT]`.
- Never skip pagination for review threads.
- Do not force push or amend unless explicitly requested.
