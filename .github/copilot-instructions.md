# Copilot Review Instructions

This file provides Copilot review context. It mirrors AGENTS.md and adds only high level prompt guidance to avoid drift.

## AGENTS.md (source of truth)

# AGENT ORIENTATION

## What this project is

- Discord bot that records voice meetings, transcribes them with OpenAI (gpt-4o-transcribe), generates notes with GPT-5.1, and posts results back to Discord.
- Supports auto-recording, meeting history in DynamoDB, context injection (server/channel/meeting), dictionary terms for prompt context, and a user-driven notes correction flow using LLMs.

## Tech stack

- Runtime: Node.js 22, TypeScript.
- Discord: discord.js v14, discord-api-types, @discordjs/voice for audio capture, @discordjs/opus, prism-media.
- AI: openai SDK; gpt-4o-transcribe for transcription; gpt-5.1 for cleanup/notes/corrections; gpt-5-mini for live gate; DALL-E 3 for images.
- Observability and prompt management: Langfuse for tracing, prompt versioning, and prompt sync scripts.
- Storage: AWS DynamoDB (tables: GuildSubscription, PaymentTransaction, StripeWebhookEvent, InteractionReceipt, ActiveMeeting, AccessLogs, RecordingTranscript, AutoRecordSettings, SessionTable, Installer, OnboardingState, AskConversation, Feedback, ServerContext, ChannelContext, DictionaryTable, UserSpeechSettings, MeetingHistory, MeetingShare), S3 for transcripts/audio.
- Infra: Terraform -> AWS ECS Fargate, ECR, CloudWatch logs; static frontend on S3 + CloudFront with OAC; local Dynamo via docker-compose.
- IaC scanning: Checkov runs in `.github/workflows/ci.yml` on PRs and main pushes. Local: `npm run checkov` (uses `uvx --from checkov checkov`; install uv first: https://docs.astral.sh/uv/).
- Known/suppressed infra choices:
  - Public subnets + public ECS IPs retained temporarily to avoid NAT Gateway cost (see checkov skips on CKV_AWS_130/333 with rationale in `_infra/main.tf`).
  - VPC flow logs enabled to CloudWatch (365d, KMS `app_general`).
  - ECR hardened (immutable tags, scan on push, KMS).
  - CloudWatch logs KMS + 365d, tightened SG egress (443 + DNS), split ECS execution/task roles, DynamoDB tables use PITR + KMS (app_general), default SG locked down.
- Tooling: Jest, ESLint, Prettier, Husky, lint-staged; ts-node/nodemon for dev.

## Key flows (server code in `src/`)

- Entry: `index.ts` -> `setupBot()` and `setupWebServer()`. Independent runtimes: `src/apps/bot/main.ts` and `src/apps/api/main.ts` boot the bot and API separately.
- Bot interactions: `src/bot.ts`
  - Slash commands: `/startmeeting`, `/autorecord`, `/context`, `/dictionary`.
  - Buttons: end meeting, generate image, suggest correction.
  - Auto-record on voice join if configured.
- Web server: `webserver.ts` (health check; optional Discord OAuth scaffolding). API routes are modularized under `src/api/` (billing, guilds) and share services with bot commands (ask/context/autorecord/billing).
- Frontend: `src/frontend/` (Vite + React 19), builds to `build/frontend/`, deployed to S3/CloudFront. Express only handles API/health; static assets served via CDN.
- Public docs site: `apps/docs-site/` (Docusaurus), builds to `build/docs-site/`, deployed to S3/CloudFront at `docs.chronote.gg`.
- Dev/QA commands: `yarn start` (bot via nodemon+ts-node), `yarn dev` (starts local Dynamo + init + bot), `yarn frontend:dev`, `yarn docs:dev`, `yarn build`, `yarn build:web`, `yarn build:all`, `yarn docs:build`, `yarn docs:check`, `yarn test`, `yarn lint`, `yarn prettier`, `yarn terraform:init|plan|apply`, `yarn prompts:push`, `yarn prompts:pull`, `yarn prompts:check`.
- Meeting lifecycle: `meetings.ts`, `commands/startMeeting.ts`, `commands/endMeeting.ts`.
  - Records audio, chat log, attendance; splits audio; transcribes; generates notes; saves MeetingHistory (with transcript, notes versioning).
- Transcription, notes, and image generation: `src/services/transcriptionService.ts`, `src/services/notesService.ts`, `src/services/imageService.ts`.
  - Prompt builders live in `src/services/*PromptService.ts`.
  - Builds context from server/channel/meeting and recent history (`services/contextService.ts`).
- Transcription prompt is Langfuse-managed (`chronote-transcription-prompt`). Guardrails include a loudness gate (noise gate metrics, hard silence threshold, syllable rate, and logprobs), a prompt echo gate, and a low-confidence prompt/no-prompt vote fallback on slow snippets.
  - A finalized audio verification pass can run at meeting end (`transcription.finalPass.enabled`) to auto-apply high-confidence hallucination fixes before notes generation.
  - GPT prompts tuned for cleanup, notes, and optional image generation.
- Dictionary management: `commands/dictionary.ts`, `services/dictionaryService.ts`
  - Terms are injected into transcription and context prompts, definitions are used outside transcription to reduce prompt bloat.
- Notes correction flow: `commands/notesCorrections.ts`
  - â€œSuggest correctionâ€ button â†’ modal (single textarea).
  - Fetches saved notes + transcript from DB, calls GPT-4o with a â€œminimal edits, do not copy transcriptâ€ prompt, shows a compact line diff, requires approval (meeting creator or ManageChannels if auto-record), updates embed + MeetingHistory and bumps version/last editor.
- Context management: `commands/context.ts` writes/reads ServerContext and ChannelContext.
- Meeting history persistence: `commands/saveMeetingHistory.ts`, `db.ts` helpers.
- Web server: `webserver.ts` (health check, optional Discord OAuth scaffolding).

## Configuration & env

- Central config: `src/services/configService.ts`; preferred source (avoid re-exporting secrets from `constants.ts`).
- Required always: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `OPENAI_API_KEY`.
- OAuth (optional): `ENABLE_OAUTH` (default true). If true, also require `DISCORD_CLIENT_SECRET`, `DISCORD_CALLBACK_URL`, `OAUTH_SECRET`. If not using OAuth, set `ENABLE_OAUTH=false` (wired into Terraform env).
- Production OAuth should use the API domain callback (e.g., `https://api.chronote.gg/auth/discord/callback`). When `API_DOMAIN` is set in Terraform, the backend is behind an ALB and the frontend build uses `VITE_API_BASE_URL` from GitHub Actions env vars.
- OpenAI org/project IDs are optional (defaults empty).
- Langfuse prompt sync uses `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. Optional: `LANGFUSE_BASE_URL`, `LANGFUSE_PROMPT_LABEL`, `LANGFUSE_PROMPT_TRANSCRIPTION`.
- Optional Langfuse prompt override for the finalized audio pass: `LANGFUSE_PROMPT_TRANSCRIPTION_FINAL_PASS`.
- Langfuse MCP tooling uses `node scripts/setup-langfuse-mcp-auth.js` to write `.opencode/langfuse.mcp.auth`, `.opencode/langfuse.public`, and `.opencode/langfuse.secret` for OpenCode. Codex and Claude Code still expect `LANGFUSE_MCP_AUTH` in the environment.
- Other env defaults: `PORT` (3001), `NODE_ENV`, Dynamo local toggles via `USE_LOCAL_DYNAMODB`.
- Cloud dev bootstrap: run `./scripts/setup-cloud-dev.sh` to sync uv, install scc into `.bin/`, install lizard into `.venv/bin/`, and install Playwright browsers (no flags needed). Add `.bin` and `.venv/bin` to `PATH` for `yarn code:stats`.
- Mock-friendly env file: copy `scripts/mock.env.example` to `.env` or source it directly (`set -a; source scripts/mock.env.example; set +a`) instead of exporting many vars manually. The file keeps mock mode enabled, disables OAuth, points at local DynamoDB, and supplies dummy tokens.
- Transcript storage: set `TRANSCRIPTS_BUCKET` (required for S3 uploads), optional `TRANSCRIPTS_PREFIX`, `AWS_REGION` (defaults to `us-east-1`).

## Data model highlights (see `src/types/db.ts`)

- MeetingHistory: guildId, channelId_timestamp, meetingId, notes, `transcriptS3Key`, context, attendees, duration, transcribe/generate flags, notesMessageId/channelId, notesVersion, notesLastEditedBy/At, meetingCreatorId, isAutoRecording, `suggestionsHistory`, `notesHistory`.
- DictionaryEntry: guildId, termKey, term, definition, created/updated metadata.
- ServerContext / ChannelContext store prompt context.
- AutoRecordSettings enable record-all or per-channel auto-start.

## Frontend

- Vite + React 19 lives in `src/frontend/`; production build is static assets in `build/frontend/` served via S3/CloudFront (see deploy workflow). Use `yarn frontend:dev` for local HMR.
- Public product docs live in `apps/docs-site/`; run `yarn docs:dev` for local authoring and `yarn docs:check` before merging docs changes.
- Storybook lives in `.storybook/` for component development. Start it with `yarn storybook` (port 6006 by default).
- To capture component screenshots, run `yarn test-storybook` while Storybook is running. Screenshots are written to `test/storybook/screenshots`.
- When making UI changes, use the VLM to review the Storybook screenshots so you can verify the component changes without scanning the full page.
- When making UI changes, review Playwright visual snapshots in `test/e2e/visual.spec.ts-snapshots` with the VLM to understand existing UI flows. It is OK to update snapshots with `yarn test:visual:update` or use the Playwright MCP during UI work.

## Infra (Terraform)

- Variables (tfvars.example): Discord IDs/tokens, OpenAI keys, OAuth secrets, ENABLE_OAUTH (false by default in example), AWS/GitHub tokens.
- ECS task environment passes all relevant vars from Terraform; OpenAI org/project optional; OAuth vars included but can be blank if disabled.
- Future work suggestion: keep cache and Redis Terraform resources in `_infra/cache.tf`, and add new cache infrastructure there.

## Known nuances / gotchas

- Token leaks: donâ€™t reintroduce secret re-exports in `constants.ts`; use `configService`.
- Discord interaction timing: modal/button handlers must reply within 3s; correction flow already uses direct replies.
- Diff output is intentionally minimal (line diff, capped length); LLM output is stripped of code fences to avoid code-block embeds.
- Meeting duration capped at 2h (`MAXIMUM_MEETING_DURATION`).
- Auto-record will end meeting if channel empties.
- Prompt fragments live in `prompts/_fragments` and are composed via `extends` in front matter. `prompts:pull` skips prompts that use `extends` unless `--force` is passed.
- Transcription guardrails include a loudness gate (noise gate metrics, hard silence threshold, syllable rate, and logprobs), a prompt echo gate using similarity checks, and a low-confidence prompt/no-prompt vote fallback on slow snippets.
- **Current outbound network rules (ECS service SG)**: temporarily allowing all egress (UDP/TCP any port) for Discord voice debugging. Previously it was limited to TCP 443 and DNS (53) only. Remember to tighten this once voice is stable and update this note.
- Avoid `in`/`instanceof`/`typeof` hedging for core platform APIs; we target a known Node/SDK set. Prefer simple, direct calls with minimal branching.
- Config UX: treat overrides as implicit (setting a value creates an override), show a clear inherited vs overridden indicator, keep a reset-to-default action, and avoid disabling inputs just to signal default values.
- Config taxonomy: avoid hardcoded group names in UI, derive them from the registry or make them required, and keep advanced and experimental settings collapsed by default to reduce noise.
- Config typing: avoid freeform strings for fixed option sets (for example TTS voice), use enumerated options and shared constants, and avoid hardcoded config key strings in consumers by relying on shared key constants or typed accessors.
- Config access: prefer shared helpers that resolve and transform config values (trim strings, validate enums, etc.) instead of inline snapshot parsing. When you add a helper to replace boilerplate, update existing consumers proactively, keep it KISS, and avoid hedging.
- Portal base URLs are always configured. Do not add fallback behavior for missing `FRONTEND_SITE_URL` or relative portal links; treat missing config as an error.
- Avoid hedging and speculative fallbacks. Follow YAGNI and KISS, do not add code for hypothetical cases unless explicitly required.
- Config constraints: when numeric settings depend on caps, use minKey/maxKey to reference other config entries, clamp inputs in the UI, and enforce bounds in API validation.
- Playwright mock mode: ensure only the mock API (port 3001) and frontend dev server (port 5173) are running. If ports are occupied, stop them first (`Get-NetTCPConnection -LocalPort 3001,5173 | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ }`). Clear `VITE_API_BASE_URL` (for example via `.env.local`) so the frontend uses the mock server.
- Comment hygiene: donâ€™t leave transient or change-log style comments (e.g., â€œSDK v3 exposes transformToStringâ€). Use comments only to clarify non-obvious logic, constraints, or intent.
- Writing style: do not use em dashes in copy/docs/comments; prefer commas, parentheses, or hyphens.
- Documentation accuracy: after changes that affect behavior, config, prompts, infra, or user flows, review and update `AGENTS.md`, `.github/copilot-instructions.md`, `README.md`, and any related `docs/` or prompt files to keep them accurate and high signal. Keep the copilot instructions high level to reduce drift.
- Docs policy: user-facing PRs should include a docs delta in `apps/docs-site/`. Purely technical PRs can use `docs-exempt` with rationale.
- README should stay high signal for users, avoid listing research outcomes like query parameter details. Put rationale or research notes in planning documentation files instead.
- Backwards compatibility: ask the user whether changes need to preserve compatibility for URLs, API contracts, stored data, or behavior. If unsure, ask before implementing and favor simplicity for early-stage tradeoffs.
- Backwards compatibility update (January 6, 2026): prioritize DynamoDB data compatibility; URLs and UI flows can change without preserving prior behavior.
- Workflow sync: when changing GitHub Actions env or steps, review `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, and `.github/workflows/deploy-staging.yml` to keep them aligned.
- ADRs: use the existing ADR format (see `docs/adr-20260106-voice-receiver-resubscribe.md`). New ADRs must live in `docs/` with filename `adr-YYYYMMDD-<slug>.md` and include Status, Date, Owners, Context, Decision, Consequences, Alternatives Considered, and Notes. Keep ADRs short and factual. Update or add ADRs when a design decision changes behavior or data contracts.
- â€œRemember that â€¦â€ shorthand: when the user says â€œremember that <rule>â€, add it to AGENTS.md under the relevant section as a standing rule.
- Do not suppress runtime warnings by monkey-patching globals (e.g., overriding console.error). Fix the underlying issue or accept the warning; never silence it via code hacks.
- Stripe webhook parsing: keep a single `express.raw({ type: "application/json" })` at app-level in `webserver.ts`; do not add per-route raw parsers elsewhere.
- React tests: when a test triggers state updates (e.g., data-fetching effects), wrap renders/updates in `act` (from `react`/RTL helpers) to avoid act warnings instead of silencing console errors.
- Post-push PR SOP: after every commit push to an active PR, run a full checks and review audit (status checks, unresolved AI threads, bot issue comments, mergeability), then wait at least 5 minutes and re-check for late AI reviewer comments before declaring merge-ready.

## Quick start (local)

- `yarn install`
- Copy `.env.example` to `.env`; set required tokens.
- `yarn dev` to start local Dynamo + init tables + bot.

## Worktrees (standard flow)

- Use `scripts/new-worktree.ps1` from the main repo to create a worktree and branch, and copy the main `.env`.
  - Example: `.\scripts\new-worktree.ps1 -Branch feature-chat-tts`
  - If you run the script from a non-main worktree, pass `-SourceEnv ..\meeting-notes-discord-bot\.env`.
  - Default worktree path is `..\meeting-notes-discord-bot-<branch>`.
- Create a dedicated Discord text channel and voice channel for the branch, then use those for testing.
- If `.env` changes on main, re-run the script or copy `.env` into the worktree.

## Checks

- Local full gate: `yarn run check` (lint --fix, prettier --write, then in parallel test, build:all, docs:check, code:stats, prompts:check).
- CI-parity local gate: `yarn run check:ci` (lint:check, prettier:check, markdownlint:check, test, build:all, docs:check, test:e2e, checkov, code:stats, prompts:check, docker:build). Avoid `yarn check` (built-in Yarn integrity command).
- CI runs the same set as `check:ci` (see `.github/workflows/ci.yml`).
- When running checks locally, avoid docker builds unless explicitly requested.
- Visual regression baselines: update with `yarn test:visual:update`.

Why each check exists:

- Lint (ESLint) catches common errors and keeps code quality consistent. Docs: https://eslint.org/docs/latest/use/command-line-interface
- Format (Prettier) enforces a consistent style and removes formatting churn. Docs: https://prettier.io/docs/cli
- Tests and coverage (Jest) protect behavior and enforce coverage thresholds defined in `jest.config.ts`. Current global thresholds: statements 30%, branches 60%, functions 40%, lines 30%. Docs: https://jestjs.io/docs/29.7/configuration
- Build (TypeScript + Vite) validates type safety and ensures the frontend bundles. Docs: https://www.typescriptlang.org/docs/handbook/compiler-options.html and https://vite.dev/guide/
- Docs build (Docusaurus) validates docs compile and link integrity. Command: `yarn docs:check`. Docs: https://docusaurus.io/docs
- E2E (Playwright) validates core user flows against the UI. Docs: https://playwright.dev/docs/running-tests
- Code stats and complexity (scc + lizard) keep size and complexity visible in CI. Lizard uses its default warning thresholds (CCN > 15, length > 1000, nloc > 1000000, parameter_count > 100). Use `.sccignore` for scc exclusions and `whitelizard.txt` to suppress known complexity offenders. Docs: https://github.com/boyter/scc and https://github.com/terryyin/lizard
- Markdown lint (markdownlint-cli2) enforces consistent Markdown style across all repo `.md` files. Config in `.markdownlint-cli2.jsonc`. Command: `yarn markdownlint:check` (or `yarn markdownlint:fix` to auto-fix). Docs: https://github.com/DavidAnson/markdownlint-cli2 and https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md
- IaC scan (Checkov via uvx) catches Terraform misconfigurations. Docs: https://www.checkov.io/2.Basics/CLI%20Command%20Reference.html and https://docs.astral.sh/uv/concepts/tools/
- Prompt sync (Langfuse) keeps repo prompt files aligned with Langfuse. Command: `yarn prompts:check`.

Coverage guidance:

- Prefer adding tests over coverage ignores.
- If a coverage ignore is unavoidable, use c8 ignore directives with a short justification comment.
- After coverage improvements or coverage scope changes, round each threshold down to the nearest 10 and keep it in sync with `jest.config.ts`. Do not lower a threshold below its pre-PR value unless the coverage scope meaningfully expands, in which case reset to the new rounded baseline and call it out in the PR.

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

## Clean Code Guidelines

### Constants Over Magic Numbers

- Replace hard-coded values with named constants
- Use descriptive constant names that explain the value's purpose
- Keep constants at the top of the file or in a dedicated constants file

### Meaningful Names

- Variables, functions, and classes should reveal their purpose
- Names should explain why something exists and how it's used
- Avoid abbreviations unless they're universally understood

### Smart Comments

- Don't comment on what the code does - make the code self-documenting
- Use comments to explain why something is done a certain way
- Document APIs, complex algorithms, and non-obvious side effects

### Single Responsibility

- Each function should do exactly one thing
- Functions should be small and focused
- If a function needs a comment to explain what it does, it should be split

### DRY (Don't Repeat Yourself)

- Extract repeated code into reusable functions
- Share common logic through proper abstraction
- Maintain single sources of truth

### Clean Structure

- Keep related code together
- Organize code in a logical hierarchy
- Use consistent file and folder naming conventions

### Encapsulation

- Hide implementation details
- Expose clear interfaces
- Move nested conditionals into well-named functions

### Code Quality Maintenance

- Refactor continuously
- Fix technical debt early
- Leave code cleaner than you found it

### Testing

- Write tests before fixing bugs
- Keep tests readable and maintainable
- Test edge cases and error conditions

### Version Control

- Write clear commit messages
- Make small, focused commits
- Use meaningful branch names

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

## Prompt context (high level)

- Prompts live in prompts/ and prompts/\_fragments, and are synced via Langfuse.
- Notes should be concise and proportional to meeting length, and follow participant instructions over defaults.
- Speaker order can be unreliable, avoid strong inference from ordering.
- Use server nicknames when provided, else display names, else usernames, keep consistent.
- Notes corrections should be minimal edits and avoid copying transcript text.
- Discord embed markdown supports headings up to ###, avoid #### in notes output.

## Drift guardrails

- Keep this file aligned with AGENTS.md and avoid pasting full prompt content.
- After changes that affect behavior, config, prompts, infra, or user flows, update docs and prompts as required by AGENTS.md.
