# AGENT ORIENTATION

## Private business and operations context

- Product code, tests, public documentation and deployment workflows belong in this repository.
- Business initiatives, customer/outreach research, detailed operational evidence and private runbooks belong in [Chronote-gg/chronote-ops](https://github.com/Chronote-gg/chronote-ops), with local checkout `D:/bench/chronote-ops`.
- For operational work, read that private repository's `AGENTS.md`, `README.md` and the relevant owner note. Keep public issues, PRs, Actions logs and summaries limited to sanitized status when private provider or customer context is involved.
- Dev and Sandbox name the same test environment. Its identity, deployment authority, credential storage route and dated acceptance evidence are owned in chronote-ops. If private evidence is unavailable, report that limit instead of guessing operational state.
- Personal portfolio priorities and time allocation stay in basic-life; keep pointers there without duplicating Chronote initiatives. Internal engineering architecture and test instructions may stay in `docs/` here.

## What this project is

- Discord bot that records voice meetings, transcribes them with OpenAI (gpt-4o-transcribe), generates notes with GPT-6.1 Sol, and posts results back to Discord.
- Supports auto-recording, meeting history in DynamoDB, context injection (server/channel/meeting), dictionary terms for prompt context, and a user-driven notes correction flow using LLMs.

## Rules for every session

- **User data in public outputs (CRITICAL):** This is a public repository. NEVER include real user data in PR descriptions, commit messages, issue comments, code comments, docs, or any other content that is or may become publicly visible. This includes Discord usernames, display names, user/server/channel IDs, meeting content, transcription excerpts, notes content, server names, and any other user-generated or user-identifying information. When referencing real scenarios for context, replace all identifying details with generic placeholders (e.g., "User A", "User B", "Server X", "Channel Y", "#general"). The technical meaning must be preserved while all PII and user content is stripped.
- GitHub prose: prefix any PR comments, PR descriptions, issue text, or other GitHub prose with `[AGENT]`. If the prose starts with a
  Markdown heading, put `[AGENT]` on its own line or add a blank line before the
  heading; never concatenate the prefix directly with a heading like
  `[AGENT]## Summary`.
- PR descriptions should stay concise. Do not publish long "Tests" or "Verification" checklists for checks already enforced by CI; mention validation only when it adds non-obvious signal, such as manual/provider checks, visual-review rationale, skipped checks, or rollout risk.
- **Break-glass deploys are dispatched by BASIC (`BASIC-BIT`) only; agents may prepare the `gh workflow run deploy.yml -f break_glass=true ...` command and the attestation but never run the dispatch.** Terraform Plan/Apply is manual and needs GitHub environment approval. Read `docs/engineering/infrastructure.md` before any deploy or Terraform work.
- Token leaks: don’t reintroduce secret re-exports in `constants.ts`; use `configService`.
- Avoid hedging and speculative fallbacks. Follow YAGNI and KISS, do not add code for hypothetical cases unless explicitly required.
- Avoid `in`/`instanceof`/`typeof` hedging for core platform APIs; we target a known Node/SDK set. Prefer simple, direct calls with minimal branching.
- Comment hygiene: don’t leave transient or change-log style comments (e.g., “SDK v3 exposes transformToString”). Use comments only to clarify non-obvious logic, constraints, or intent.
- Writing style: do not use em dashes in copy/docs/comments; prefer commas, parentheses, or hyphens.
- Planning questions: number clarifying questions when asking the user to choose direction.
- Do not suppress runtime warnings by monkey-patching globals (e.g., overriding console.error). Fix the underlying issue or accept the warning; never silence it via code hacks.
- Backwards compatibility: ask the user whether changes need to preserve compatibility for URLs, API contracts, stored data, or behavior. If unsure, ask before implementing and favor simplicity for early-stage tradeoffs.
- Backwards compatibility update (January 6, 2026): prioritize DynamoDB data compatibility; URLs and UI flows can change without preserving prior behavior.
- Durable instruction capture: when the user corrects a standing behavior or asks future agents to know something, update the appropriate durable surface in the same turn. Use repo `AGENTS.md` for Chronote-specific rules, and global OpenCode or basics-agentic-dogfooding guidance for cross-repo meta-instructions.
- “Remember that …” shorthand: when the user says “remember that <rule>”, add it to AGENTS.md under the relevant section as a standing rule.
- Documentation accuracy: after changes that affect behavior, config, prompts, infra, or user flows, review and update `.github/copilot-instructions.md`, `README.md`, and any related `docs/` or prompt files to keep them accurate and high signal. Keep the copilot instructions high level to reduce drift.
- Docs policy: user-facing PRs should include a docs delta in `apps/docs-site/`. Purely technical PRs can use `docs-exempt` with rationale.
- README should stay high signal for users, avoid listing research outcomes like query parameter details. Put rationale or research notes in planning documentation files instead.
- Workflow sync: when changing GitHub Actions env or steps, review `.github/workflows/ci.yml`, `.github/workflows/ci-core.yml`, `.github/workflows/deploy.yml`, and `.github/workflows/deploy-staging.yml` to keep them aligned.
- ADRs: use the existing ADR format (see `docs/adr-20260106-voice-receiver-resubscribe.md`). New ADRs must live in `docs/` with filename `adr-YYYYMMDD-<slug>.md` and include Status, Date, Owners, Context, Decision, Consequences, Alternatives Considered, and Notes. Keep ADRs short and factual. Update or add ADRs when a design decision changes behavior or data contracts.
- PR review hygiene: before asking the user to merge a PR, reply to and resolve all AI bot review threads (Copilot, Greptile, etc). If we disagree with the suggestion, say so and resolve the thread anyway. Use reactions when helpful. When replying to review comments, reply directly to each thread using the review comment replies API (`POST /repos/OWNER/REPO/pulls/PR/comments/COMMENT_ID/replies`), not by creating a new pending review. Direct replies keep each response in its original thread context.
- PR bot thread audit: when checking for unresolved AI comments, fetch _all_ review threads via the GitHub GraphQL API and paginate until `hasNextPage=false` (don't assume `first: 100` is enough). Also scan PR issue comments for bot follow-ups (Greptile sometimes posts as regular PR comments, which cannot be "resolved" but should still be replied to or reacted to).
- Post-push PR SOP: after every commit push to an active PR, run a full checks and review audit (status checks, unresolved AI threads, bot issue comments, mergeability) once its checks finish, before declaring merge-ready.
- When launching Chronote Desktop for operator/manual testing, use production endpoints by default: run `yarn desktop:start:prod` from the repo root. Use `yarn desktop:dev:prod` only when an interactive Tauri dev server is needed. Do not use generic `yarn dev` unless explicitly testing a local API/portal flow.

## Scope and escalation

- Keep work within the approved outcome and minimize unnecessary machinery. File counts, changed lines, effort estimates and implementation-to-change ratios are planning aids, not automatic approval gates. Continue necessary tests, callers, fixtures and supporting source work without repeated approval for those estimates.
- Escalate substantive changes in outcome, privacy, risk, spending or required authority. Honor explicit human limits and provider limits; preserve existing restrictions on retries, state-changing operations and deployment prerequisites. Diagnose unexpected failures and report real blockers rather than stopping at a fixed failure count.
- A merge that introduces a prerequisite for the deploy path (a new permission, capability row, protocol, or proof the serving worker must supply) lands the prerequisite first or carries a fallback that lets the next deploy complete. If neither is possible, the PR body and the merge-ready message say in one sentence that production is frozen until X, and the question goes to BASIC before merge. PR #524 merged on 2026-11-03 with neither, and every production deploy after it refused with `artifact_preservation_unconfirmed`.

## Reference (read on demand)

Product and architecture facts live in `docs/engineering/`, not in this file. Read the file for the area you are touching and record new facts there.

- `docs/engineering/architecture.md`: tech stack, key flows and entry points, data model.
- `docs/engineering/configuration.md`: environment variables and config rules.
- `docs/engineering/frontend.md`: portal, docs site, and the public-route rule (`scripts/public-routes.json`).
- `docs/engineering/infrastructure.md`: Terraform, deploy workflows and deployment handoff. Read before any Terraform or deploy work; it holds the Plan/Apply and break-glass authority rules.
- `docs/engineering/product-analytics.md`: PostHog capture rules, including what an event may carry.
- `docs/engineering/invariants.md`: per-area rules that must keep holding (mentions, artifact access, MCP service accounts, desktop auth and recording limits, billing, transcript prompts).
- `docs/engineering/checks.md`: why each check exists, prompt promotion and LLM connection sync.
- `docs/engineering/evals.md`: eval runners and datasets.

## Worktrees (standard flow)

- Use `scripts/new-worktree.ps1` from the main repo to create a worktree and branch, and copy the main `.env`.
  - Example: `.\scripts\new-worktree.ps1 -Branch feature-chat-tts`
  - If you run the script from a non-main worktree, pass `-SourceEnv ..\meeting-notes-discord-bot\.env`.
  - Default worktree path is `..\meeting-notes-discord-bot-<branch>`.
- Create a dedicated Discord text channel and voice channel for the branch, then use those for testing.
- If `.env` changes on main, re-run the script or copy `.env` into the worktree.

## Quick start (local)

For dependency installation, native voice builds or CI changes, read [the native voice build prerequisites](README.md#native-voice-build-prerequisites) before changing the pinned Rust build route.

- `yarn install`
- Copy `.env.example` to `.env`; set required tokens.
- `yarn dev` to start local Dynamo + init tables + bot. (`yarn dev` loads `.env`/`.env.local` into the child process so per-repo creds win over global environment variables.)

Optional Windows helper (prints loaded env, supports `-Mock` / `-SkipDocker`):

- `powershell -ExecutionPolicy Bypass -File scripts/dev.ps1`
- `powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 -Mock`

## Checks

- Set up the pinned shared tool through `QUALITY_RATCHET_HOME`, then run `yarn check:quality` before committing and `yarn test:quality` after consumer workflow or launcher changes. Keep engine changes in BASIC-BIT/quality-ratchet. Include tests, fixtures, mocks, stories, and module variants.
- PR exceptions require `quality-exception` plus a reason under `## Quality exception`. The label persists across pushes and never waives operational failures. Agents must obtain explicit user authorization before applying it. Local checks remain strict. See `docs/engineering/code-quality.md`.

- Local full gate: `yarn run check` (lint --fix, prettier --write, then in parallel test, build:all, docs:check, code:stats, prompts:check).
- CI-parity local gate: `yarn run check:ci` (lint:check, prettier:check, markdownlint:check, test, build:all, docs:check, test:e2e, checkov, code:stats, prompts:check, docker:build). Avoid `yarn check` (built-in Yarn integrity command).
- CI runs the same set as `check:ci` (see `.github/workflows/ci.yml` and `.github/workflows/ci-core.yml`).
- When running checks locally, avoid docker builds unless explicitly requested.
- Windows Visual Regression and native desktop smoke jobs use Node.js 24.22.1 or later within 24.x for the [confirmed upstream Windows TCP crash](https://github.com/nodejs/node/issues/63620). Do not repin this job to 24.15.0.
- Visual regression baselines: update with `yarn test:visual:update`.
- **Every Windows job is skipped while a pull request is a draft, and `ready_for_review` is what brings them back.** Windows runners bill at twice the Linux rate on Blacksmith, and the four Windows jobs were 80% of the October 2026 bill, so a draft iterating over many pushes is the expensive case. Visual Regression, Desktop Check and both `desktop-package.yml` jobs therefore carry a `github.event.pull_request.draft == false` guard. The guard only works because `ci.yml` and `desktop-package.yml` list `ready_for_review` in their `pull_request` `types`; listing types at all drops the `opened`/`synchronize`/`reopened` defaults, so all four have to stay listed. `test/scripts/windowsJobDraftGating.test.ts` pins both the trigger lists and the guards, because deleting either is silent otherwise. Adding a new Windows job means adding the same guard and keeping the trigger list intact.
- **Marking a PR ready starts those Windows jobs, so do not merge until they report.** None of them is a required status check (the only one is `Code quality ratchet`, in the Main Protection ruleset), and GitHub counts a job skipped by an `if` as a pass. So in the minutes between `gh pr ready` and the new run registering, a PR whose Windows jobs all skipped as a draft shows an entirely green merge box. `pr-post-push-sop` covers the wait after a push; mark-ready is not a push and needs the same wait. Never enable auto-merge on a draft PR for this reason.
- **Do not move a Windows job to a Linux runner to save money.** `scripts/desktop-check.js` can only run the desktop Rust tests on Windows, and `cargo test` there is the only desktop Rust coverage in CI. It used to `process.exit(0)` off Windows, so a Linux move would have reported green while testing nothing, which is the defect fixed on 2026-08-12. It now refuses when `GITHUB_ACTIONS` is set, covered by `test/scripts/desktopCheck.test.ts`. The signal is `GITHUB_ACTIONS` rather than `CI` because devcontainers and agent sandboxes set `CI` and legitimately run `yarn check:ci` on Linux, where skipping is still the right answer. Visual Regression is likewise portable in principle but every committed baseline is keyed `-chromium-win32`, so a Linux move invalidates all of them. The cheaper lever is the runner vendor, not the operating system: this repository is public, so GitHub-hosted `windows-latest` is free while Blacksmith Windows is paid.
- Upgrade billing defaults to Monthly unless the arrival link requests Annual. Annual savings use matching monthly/yearly prices in the same currency; never hardcode a discount or substitute a monthly price for an unavailable annual plan. Screenshot coverage includes both selected billing periods.
- Review baseline changes before committing. The PR Visual Regression check fails on visual test failures; upgrade and post-install welcome snapshots cover desktop, mobile and wide screens. Branch protection separately controls whether that check is required for merge.

### Coverage guidance

- Prefer adding tests over coverage ignores.
- If a coverage ignore is unavoidable, use `istanbul ignore` directives with a short justification comment. Coverage runs through the istanbul provider, so a `c8 ignore` comment is accepted by the compiler and then counts for nothing.
- After coverage improvements or coverage scope changes, round each threshold down to the nearest 10 and keep it in sync with `jest.config.ts`. Do not lower a threshold below its pre-PR value unless the coverage scope meaningfully expands, in which case reset to the new rounded baseline and call it out in the PR.

## Dependency maintenance

- The weekly maintenance job covers Chronote and chronote-ops, consolidates dependency PRs, checks compatible upgrades and leaves merging to a human.
- Stripe 23 uses API `2026-09-30.endive`; billing-cycle anchor requests use `{ type: "now" }`. Langfuse 6 records trace input/output on the root observation.
- Dependabot proposes one cross-ecosystem version-update PR each Monday at 09:00 UTC, including desktop npm and Rust dependencies. Security updates are grouped within each ecosystem and may arrive outside that schedule.
- Consolidate outstanding dependency PRs on current master, retain intentional compatibility ignores and security resolutions, run the normal quality gates, and close superseded PRs only after the replacement is published with their links.
- Audit both npm lockfiles and the desktop Cargo lockfile during maintenance; direct version bumps can leave stale security resolutions in place. Refresh fixed-version floors, verify compatibility, and report unresolved advisories rather than dismissing them. See `docs/engineering/dependency-security.md`.

## Agent Skills

Agent workflow skills are mirrored by client:

- Codex: `.codex/skills/<name>/SKILL.md`
- Claude Code: `.claude/skills/<name>/SKILL.md`
- OpenCode: `.opencode/skills/<name>/SKILL.md`

When a shared workflow changes, keep all three skill mirrors in sync. Skills are discovered at client startup and cached, so adding or modifying skills may require restarting the client. Run `yarn agent:check` after agent-tooling changes.

- `pr-review-recycle`: agentic loop for processing Copilot/Greptile/Codex PR review threads until checks are green.
- `docs-authoring`: workflow for creating and maintaining public product docs in `apps/docs-site/`.
- `pr-post-push-sop`: post-push checklist for checks and AI review audit before merge-ready updates.
- `investigate-and-plan`: investigation and planning workflow for errors, incidents, product ideas, issues, and PRs.
- `mcp-setup-and-debug`: MCP setup and debugging workflow for OpenCode, Codex CLI, and Claude Code.

## Non-idiomatic typing

If you find yourself using keywords like `tyepof`, `as`, etc. you should then pause and think about how you can improve that code. This might involve a web search to go search online for the idiomatic way of using the library/framework/etc. Look for a way that leverages typescript best practices, such as type narrowing, to write clean maintainable code

## Online Research

Use your web search tool and/or the Context7 MCP tools to pare down uncertainty of developing or debugging work, Especially anything relating to an external library.

For context 7 library IDs you should save off the resolved library ID of packages that we use as you find them as you look them up as necessary during work.

Known Context7 IDs:

- React (react.dev): /reactjs/react.dev
- Discord.js 14.25.1 docs: /websites/discord_js_packages_discord_js_14_25_1
- OpenAI Node SDK: /openai/openai-node
- Express: /expressjs/express
- AWS SDK for JavaScript v3: /aws/aws-sdk-js-v3
- TanStack Query v5 (React Query): /websites/tanstack_query_v5
- tRPC: /trpc/trpc
- TanStack Router: /tanstack/router
- Zod v4 docs: /websites/zod_dev_v4
- Zustand: /pmndrs/zustand
- Mantine: /mantinedev/mantine
- Playwright: /microsoft/playwright.dev
- Langfuse JS/TS SDKs: /langfuse/langfuse-js
- Stripe Node SDK: /stripe/stripe-node
- Vite: /vitejs/vite

# Testing Strategy

Look for an appropriate spread of testing across our various different layers to determine the appropriate layer to add any new or modified features to. There are going to be lots of cases, especially in the back-end right now, where we don't have an appropriate level of unit testing and end-to-end integration testing, Playwright snapshot tests, etc., That we should consider adding if we don't already have for any given change. Really any file we modify, we should be able to back it up with some sort of automated testing. Keep in mind that when I make that consideration, I am also thinking about coverage. I'm thinking about making sure builds pass, making sure that a lot of our checks are in place to make sure that the code will truly work in practice, you know running the Docker build, running the TypeScript build, as well as complexity checks. We currently have a lot of ignoring in our complexity checks which we define for SCC and Lizard. We should strive if we make a change in a place that has complexity ignored, or has low coverage of tests that we should go in as part of that work to consider how we can at a minimum not make the problem worse but hopefully also rectify the deficiency while still primarily focusing on the goal at hand.

## Code Quality Guidelines

### Prefer Existing Solutions

- Avoid reinventing common solutions for parsing, formatting, routing, auth, or data handling. Do quick research for a well supported library or platform feature first.
- If an AI output behavior needs to change, prefer prompt guidance or model constraints before adding post-processing logic.
- Introduce custom logic only when there is a clear gap, document the reason, and keep it small and configurable.

### LLM Output and Text Parsing

- Prefer prompt changes, response format constraints, or model guidance over new parsing heuristics in code.
- Avoid custom NLP rules such as hard-coded abbreviation lists. If parsing is required, research and use a well supported library or standards based approach.
- If custom parsing is unavoidable, keep it minimal, configurable, and documented with tests that cover known edge cases.

### Verify Information

Always verify information before presenting it. Do not make assumptions or speculate without clear evidence.

### No Apologies

Never use apologies.
