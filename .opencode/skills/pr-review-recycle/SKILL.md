# PR Review Recycle Loop

Use this skill when you need to process automated PR review feedback (Copilot, Greptile, Codex) and iterate until:

- All automated review threads are addressed (fixed, explained, or explicitly deferred).
- PR checks are green.
- The PR is ready for a human to merge.

This is designed for a human+agent pairing.

## Standing Rules

- Prefix all GitHub prose (PR comments, issue comments, PR descriptions) with `[AGENT]`.
- Do not create commits unless explicitly asked by the user.
- Do not force push.
- Do not amend commits unless explicitly asked.
- Do not commit secrets or `.env` files.

## Inputs You Need

- PR number (or PR URL).
- Repo owner/name.

If the user only gives a branch name, resolve the PR via `gh pr list`.

## Loop Outline

Repeat the steps below until convergence.

### 0) Snapshot State

Commands:

```bash
gh pr view <PR> --json url,title,headRefName,baseRefName,state,mergeable,updatedAt
gh pr view <PR> --json statusCheckRollup
gh pr diff <PR>
```

### 1) Collect Review Threads (Bots + Humans)

Preferred: fetch review threads (not just PR conversation comments).

```bash
gh api graphql -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated comments(first:50){nodes{databaseId author{login} body path}}}}}}}' \
  -F owner=<OWNER> -F repo=<REPO> -F number=<PR>
```

Identify automated reviewers by `author.login`. Common examples:

- `github-copilot`
- `greptile`
- `opencode` or similar Codex-style bot accounts

### 2) Triage Each Thread

For each unresolved thread:

- Decide whether it is:
  - `must-fix` (correctness, security, data loss, broken UX, flaky tests)
  - `should-fix` (maintainability, clarity, consistency)
  - `nit` (style, minor preference)
  - `defer` (valid but too big, create issue)
- Validate claims by reading relevant code and running targeted checks.

Use parallel subagents when helpful:

- Fan out across threads to propose fixes and risk.
- Have one agent focus on testing/CI failures.
- Have one agent focus on external library correctness (use Context7/Brave).

### 3) Implement Fixes

Workflow:

- Checkout the PR branch locally.
- Make minimal, targeted changes.
- Add or update tests for any behavior change.
- Run the smallest check that proves the fix.
- If it touches UI, run Storybook screenshots and do a VLM review.

Suggested commands:

```bash
yarn lint:check
yarn test
yarn build:all
```

Add Playwright / visual checks if relevant:

```bash
yarn test:e2e
yarn test:visual
```

### 4) Commit + Push (Only If User Asked)

If the user asked you to commit:

- Stage only relevant files.
- Commit with a concise "why" message.
- Push to the PR branch.

### 5) Respond to Threads + Resolve

Reply to each thread with what changed or why you are not changing it.

Guidelines for replies:

- Start with `[AGENT]`.
- Mention the concrete fix and where it landed (file path, commit SHA).
- If deferred, link to an issue and state the planned follow-up.

Resolve threads via GraphQL after replying:

```bash
gh api graphql -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}' -F threadId=<THREAD_ID>
```

### 6) Wait for Checks + New Bot Feedback

Bots may post new threads after pushes.

- Re-run step (0) and (1) after each push.
- Consider the loop complete when:
  - `statusCheckRollup` is all successful
  - no unresolved bot threads remain
  - no new bot threads appear after the most recent push

At completion, tell the human: "PR ready to merge".

## Repo-Specific Notes

- Local dev: `yarn dev` and `yarn start` are wrapped to force `.env/.env.local` into the child process, to avoid multi-bot global env collisions.
- Visual regression: update snapshots with `yarn test:visual:update` only after confirming UI correctness.
