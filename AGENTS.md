# AGENT ORIENTATION

## What this project is

- Discord bot that records voice meetings, transcribes them with OpenAI (gpt-4o-transcribe), generates notes with GPT-5.1, and posts results back to Discord.
- Supports auto-recording, meeting history in DynamoDB, context injection (server/channel/meeting), dictionary terms for prompt context, and a user-driven notes correction flow using LLMs.

## Tech stack

- Runtime: Node.js 24.15.0, TypeScript.
- Discord: discord.js v14, discord-api-types, @discordjs/voice for audio capture, @discordjs/opus, prism-media.
- AI: openai SDK; gpt-4o-transcribe for transcription; gpt-5.1 for cleanup/notes/corrections; gpt-5-mini for live gate; DALL-E 3 for images.
- Observability and prompt management: Langfuse for tracing, prompt versioning, and prompt sync scripts. AMG (Grafana) service account token is auto-rotated via EventBridge + Lambda (see `_infra/grafana.tf` and `_infra/README.md`). Critical alerts (ECS down, ALB 5xx, unhealthy hosts, rotation failures) are sent via SNS email and optionally to a Discord channel via a separate Node.js Lambda (see `_infra/notifications.tf` and `_infra/README.md`).
- Storage: AWS DynamoDB (tables: GuildSubscription, PaymentTransaction, StripeWebhookEvent, InteractionReceipt, ActiveMeeting, MeetingControlCommand, AccessLogs, RecordingTranscript, AutoRecordSettings, ServerContext, ChannelContext, DictionaryTable, MeetingHistory, MeetingUserIndex, PersonalMediaUploadJob, PersonalRecordingSegment, SessionTable, McpOAuthTable, NotionIntegrationTable), S3 for transcripts/audio.
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
  - User context menu app actions: `Start meeting`, `Stop recording`.
  - Buttons: end meeting, generate image, suggest correction.
  - Auto-record on voice join if configured.
- Web server: `webserver.ts` (health check; optional Discord OAuth scaffolding). API routes are modularized under `src/api/` (billing, guilds, MCP) and share services with bot commands (ask/context/autorecord/billing).
- Remote MCP live controls enqueue meeting control commands in DynamoDB so API-only and bot runtimes can be split. Bot workers claim start/stop/live-status/live-transcript commands from `MeetingControlCommandTable`; live meeting owner-specific commands target the active lease owner instance.
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
  - “Suggest correction” button → modal (single textarea).
  - Fetches saved notes + transcript from DB, calls GPT-4o with a “minimal edits, do not copy transcript” prompt, shows a compact line diff, requires approval (meeting creator or ManageChannels if auto-record), updates embed + MeetingHistory and bumps version/last editor.
  - Web UI uses `meetings.suggestNotesCorrection` and `meetings.applyNotesCorrection` to generate a diff and apply changes, mirroring the Discord flow.
- Context management: `commands/context.ts` writes/reads ServerContext and ChannelContext.
- Meeting history persistence: `commands/saveMeetingHistory.ts`, `db.ts` helpers.
- Web server: `webserver.ts` (health check, optional Discord OAuth scaffolding).

## Configuration & env

- Central config: `src/services/configService.ts`; preferred source (avoid re-exporting secrets from `constants.ts`).
- Required always: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `OPENAI_API_KEY`.
- OAuth (optional): `ENABLE_OAUTH` (default true). `SESSION_SECRET` or `OAUTH_SECRET` is always required outside mock mode for session and CSRF signing. If OAuth is true, also require `DISCORD_CLIENT_SECRET` and `DISCORD_CALLBACK_URL`. If not using OAuth, set `ENABLE_OAUTH=false` (wired into Terraform env).
- Production OAuth should use the API domain callback (e.g., `https://api.chronote.gg/auth/discord/callback`). When `API_DOMAIN` is set in Terraform, the backend is behind an ALB and the frontend build uses `VITE_API_BASE_URL` from GitHub Actions env vars.
- Remote MCP (optional): `ENABLE_MCP` defaults true only when Discord OAuth is enabled, requires `OAUTH_SECRET`, and exposes `/mcp` on the API server. Set `MCP_PUBLIC_BASE_URL` to the externally reachable API origin for production so OAuth resource-bound tokens match the public endpoint. Optional overrides: `MCP_ENDPOINT_PATH`, `MCP_ACCESS_TOKEN_TTL_SECONDS`, `MCP_REFRESH_TOKEN_TTL_SECONDS`, `MCP_AUTH_CODE_TTL_SECONDS`.
- Notion export (optional): set `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, and `NOTION_REDIRECT_URI` to enable user OAuth, one-way export, manual sync, server automation, and personal automation from Chronote notes to Notion pages. Notion tokens are encrypted with `NOTION_TOKEN_ENCRYPTION_SECRET` when set, otherwise `OAUTH_SECRET`/`SESSION_SECRET`.
- OpenAI org/project IDs are optional (defaults empty).
- Langfuse prompt sync uses `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. Optional: `LANGFUSE_BASE_URL`, `LANGFUSE_PROMPT_LABEL`, `LANGFUSE_PROMPT_TRANSCRIPTION`. `LANGFUSE_BASE_URL` defaults to `https://us.cloud.langfuse.com` (`services/langfuseDefaults.ts`), shared by the app and the scripts so they cannot resolve to different hosts. An EU or self-hosted project must set it, or its keys reach the US host and every call returns 401.
- Optional Langfuse prompt override for the finalized audio pass: `LANGFUSE_PROMPT_TRANSCRIPTION_FINAL_PASS`.
- Langfuse MCP tooling: run `node scripts/setup-langfuse-mcp-auth.js` to write `.opencode/langfuse.mcp.auth` plus `.opencode/langfuse.public` and `.opencode/langfuse.secret` for OpenCode. The `langfuse_obs` OpenCode MCP uses uvx and reads those files; Codex and Claude Code still expect `LANGFUSE_MCP_AUTH` in the environment.
- Other env defaults: `PORT` (3001), `NODE_ENV`, Dynamo local toggles via `USE_LOCAL_DYNAMODB`.
- Cloud dev bootstrap: run `./scripts/setup-cloud-dev.sh` to sync uv, install scc into `.bin/`, install lizard into `.venv/bin/`, and install Playwright browsers (no flags needed). Add `.bin` and `.venv/bin` to `PATH` for `yarn code:stats`.
- Mock-friendly env file: copy `scripts/mock.env.example` to `.env` or source it directly (`set -a; source scripts/mock.env.example; set +a`) instead of exporting many vars manually. The file keeps mock mode enabled, disables OAuth, points at local DynamoDB, and supplies dummy tokens.
- Transcript storage: set `TRANSCRIPTS_BUCKET` (required for S3 uploads), optional `TRANSCRIPTS_PREFIX`, `AWS_REGION` (defaults to `us-east-1`).

## Data model highlights (see `src/types/db.ts`)

- MeetingHistory: guildId, channelId_timestamp, meetingId, notes, `transcriptS3Key`, context, attendees, duration, transcribe/generate flags, notesMessageId/channelId, notesVersion, notesLastEditedBy/At, ownershipScope/ownerUserId/accessGrants for personal meeting ownership and shares, meetingCreatorId, isAutoRecording, `suggestionsHistory`, `notesHistory`.
- MeetingUserIndex: userId, userTimestamp, guildId, channelId_timestamp, meetingId, timestamp, optional accessReason. This is a pointer index for cross-guild/personal My Meetings views; always re-check MeetingHistory access before returning data.
- PersonalMediaUploadJob: uploadId, ownerUserId, status, mediaKind, sourceS3Key, file metadata, optional desktop source manifest, optional meeting pointers, error/retry metadata, created/updated/completed timestamps, and upload expiry.
- PersonalRecordingSegment: per-segment desktop recording state keyed by uploadId and source/sequence, including source label, S3 key, checksum, duration, status, and timestamps.
- DictionaryEntry: guildId, termKey, term, definition, created/updated metadata.
- ServerContext / ChannelContext store prompt context.
- AutoRecordSettings enable record-all or per-channel auto-start.
- McpOAuthTable stores hashed MCP OAuth clients, authorization codes, tokens, and user consents. Access tokens are resource-bound to the configured MCP endpoint and scopes are enforced per tool. It also stores MCP service account tokens (`SERVICE_ACCOUNT_TOKEN#<hash>` for validation and a `SERVICE_ACCOUNT_TOKENS#<guildId>` mirror for listing), keyed so a lookup by secret is a single point read and the portal never scans.
- MeetingControlCommand stores short-lived queued MCP meeting control requests and results. Pending commands are claimed by bot workers via `StatusCreatedAtIndex`; commands targeting an active meeting owner include `targetOwnerInstanceId`.
- NotionIntegrationTable stores per-user Notion connection metadata and per-user meeting export mappings, plus automation config/export/reservation records keyed under `GUILD#guildId`. Personal automation reuses the same automation records with `guildId = personal:<ownerUserId>`. Notion access and refresh tokens are encrypted before persistence.

## Frontend

- Vite + React 19 lives in `src/frontend/`; production build is static assets in `build/frontend/` served via S3/CloudFront (see deploy workflow). Use `yarn frontend:dev` for local HMR.
- Public product docs live in `apps/docs-site/`; run `yarn docs:dev` for local authoring and `yarn docs:check` before merging docs changes.
- Storybook lives in `.storybook/` for component development. Start it with `yarn storybook` (port 6006 by default, no auto-open). Use `yarn storybook:open` when you want the browser to open automatically.
- To capture component screenshots, run `yarn test-storybook` while Storybook is running. Screenshots are written to `test/storybook/screenshots`.
- When making UI changes, run Storybook and capture screenshots with `yarn test-storybook` before finishing. If the UI change is not covered by a story, add or update a story first.
- Always run Storybook screenshot capture and do a VLM review for any UI change before responding with final UI edits.
- When making UI changes, use the VLM to review the Storybook screenshots so you can verify the component changes without scanning the full page.
- When making UI changes, review Playwright visual snapshots in `test/e2e/visual.spec.ts-snapshots` with the VLM to understand existing UI flows. It is OK to update snapshots with `yarn test:visual:update` or use the Playwright MCP during UI work.
- Scroll regressions: add a Playwright assertion test that proves the intended scroll container actually scrolls (for example, checking `scrollHeight > clientHeight` and that `scrollTop` changes) and run it locally alongside visual snapshots.

## Infra (Terraform)

- Variables (tfvars.example): Discord IDs/tokens, OpenAI keys, OAuth secrets, ENABLE_OAUTH (false by default in example), AWS/GitHub tokens.
- ECS task environment passes all relevant vars from Terraform; OpenAI org/project optional; OAuth vars included but can be blank if disabled.
- Terraform plan/apply is manual via `.github/workflows/terraform-plan.yml` and `.github/workflows/terraform-apply.yml`; merges do not auto-apply Terraform. Apply uses a reviewed saved plan artifact plus GitHub environment approval. The workflows expect environment-scoped AWS credentials and a `TERRAFORM_TFVARS_JSON` secret. Production uses GitHub environment `production` with Terraform workspace `default`; sandbox uses GitHub environment `sandbox` with Terraform workspace `sandbox`. Keep `grafana_api_key` empty after Grafana token rotation is active, and use `grafana_service_account_id` plus the rotated Secrets Manager token.
- **Non-credential Terraform inputs go in GitHub Actions variables, not in the `TERRAFORM_TFVARS_JSON` secret.** Set an environment variable named `TFVAR_<KEY>` and it overrides `<KEY>` from the secret. The secret is write-only, so a flag parked in it cannot be read back, cannot be diffed or reviewed, and cannot be changed without retyping a blob that also holds credentials. That is not a theoretical cost: `ENABLE_ONBOARDING` sat in the secret at `"false"` while `main.tf` declared a `"true"` default, so the onboarding DM was off in production, a plan showed no changes, and nothing in the repo revealed why. A variable default in `main.tf` is dead code for any key the secret sets. Credentials (`GITHUB_TOKEN`, `AWS_TOKEN_KEY`, `LANGFUSE_SECRET_KEY`, `DOCS_ALGOLIA_API_KEY`, `REDIS_AUTH_TOKEN`, `REDIS_URL`, `grafana_api_key`) are refused through the `TFVAR_` path on purpose, because variables are writable by people who cannot write secrets. `REDIS_URL` is on that list because an external cache provider embeds its password in the URL; set it as a `REDIS_URL` environment secret, which the plan and apply workflows overlay onto the tfvars blob the same way they do `REDIS_AUTH_TOKEN`.
- **Changing a Terraform-managed ECS env var needs three steps, and the third is the one people miss.** Terraform apply registers a new task definition revision, but `aws_ecs_service` sets `ignore_changes = [task_definition]`, so the service keeps running the old revision and nothing observable changes. A backend deploy is what moves it: `deploy.yml` resolves the task definition by _family_, which returns the latest ACTIVE revision, so it picks up Terraform's new one, registers a new revision on top and repoints the service. So: set the value, apply, then deploy.
- Production keeps legacy VPC flow log resource names (`vpc_flow_logs_role` and `/vpc/flow/app-vpc`) to avoid replacing live logging resources; non-production environments use scoped names. Production AMG workspace naming is pinned to the existing seed in Terraform code; do not change it without an approved AMG workspace replacement plan.
- Backend deploy workflows must wait for unexpired `ActiveMeetingTable` leases to clear before replacing the ECS task, so merges do not kill in-progress recordings. Keep production and sandbox deploy guards aligned.
- Future work suggestion: keep cache and Redis Terraform resources in `_infra/cache.tf`, and add new cache infrastructure there.
- **An external `REDIS_URL` must use the `rediss://` scheme, not `redis://`.** ioredis decides whether to negotiate TLS from the scheme alone, and managed Redis accepts TLS only, so a `redis://` URL connects in plaintext, has its socket reset, and retries forever instead of failing. That starves every cache-backed request rather than degrading, and it took the portal down on 2026-07-31. Upstash's console displays the string as `redis-cli --tls -u redis://...`, where the TLS comes from the flag and not the scheme, so pasting it verbatim reproduces this. `isUsableRedisUrl` in `src/utils/redisUrl.ts` now refuses a plaintext URL for a remote host and drops to the in-process memory cache, allowing plaintext only for localhost and the docker-compose `redis` host.
- Cache backend is chosen by two Terraform variables, not by code. `REDIS_URL` always wins; `ENABLE_ELASTICACHE` decides whether an in-VPC cluster is provisioned at all; with neither set the app falls back to an in-process memory cache in `src/services/cacheService.ts`. Sandbox runs on the memory fallback. See `_infra/README.md` for the full matrix and the egress caveat for external providers.

## Known nuances / gotchas

- Token leaks: don’t reintroduce secret re-exports in `constants.ts`; use `configService`.
- Discord interaction timing: modal/button handlers must reply within 3s; correction flow already uses direct replies.
- Diff output is intentionally minimal (line diff, capped length); LLM output is stripped of code fences to avoid code-block embeds.
- Meeting duration capped at 2h (`MAXIMUM_MEETING_DURATION`).
- Auto-record will end meeting if channel empties.
- Noise gate can suppress very quiet snippets; forced transcriptions bypass it.
- Attendance entries are stored as Discord mentions (`<@snowflakeId>`), and the web UI resolves them to display names server-side.
- Notes may contain user mentions (`<@snowflakeId>`) and role mentions (`<@&snowflakeId>`). All read surfaces (web portal, share payload, MCP, Notion, Markdown export) must resolve them through `createMeetingMentionReplacer` in `services/meetingMentionService.ts`; do not resolve mentions inline at a call site. Role names are fetched via `listGuildRolesCached` and degrade to raw mentions if Discord is unavailable.
- Mentions inside Discord embeds render but never notify. Notes are posted as embed descriptions, so mentions in notes are display-only. Do not move notes out of embeds without an explicit product decision to start pinging people.
- Any surface that posts notes-derived text as **ordinary message content** (not an embed) must set `allowedMentions: { parse: [] }`, because message content does ping. `/ask` answers and the correction diff already do. Mentions still render as names; they just do not notify.
- Prompt-visible role lists exclude `@everyone` (role id equals guild id) and managed integration roles. `MAX_ROLES_IN_PROMPT` in `notesPromptService.ts` caps the list.
- Generated notes are persisted and posted verbatim, so mention ids must be validated, not trusted to the prompt. Any path that generates notes runs the output through `stripUnknownMentions` (`utils/mentionSanitizer.ts`) against the ids that path actually showed the model. An invented id renders as a broken mention and the guild id renders as `@everyone`. New note-generating paths must add this call; `getNotes` and the personal upload path are the current examples.
- Prompt fragments live in `prompts/_fragments` and are composed via `extends` in front matter. `prompts:pull` skips prompts that use `extends` unless `--force` is passed.
- Transcription guardrails include a loudness gate (noise gate metrics, hard silence threshold, syllable rate, and logprobs), a prompt echo gate using similarity checks, and a low-confidence prompt/no-prompt vote fallback on slow snippets.
- **Current outbound network rules (ECS service SG)**: temporarily allowing all egress (UDP/TCP any port) for Discord voice debugging. Previously it was limited to TCP 443 and DNS (53) only. Remember to tighten this once voice is stable and update this note.
- Avoid `in`/`instanceof`/`typeof` hedging for core platform APIs; we target a known Node/SDK set. Prefer simple, direct calls with minimal branching.
- Config UX: treat overrides as implicit (setting a value creates an override), show a clear inherited vs overridden indicator, keep a reset-to-default action, and avoid disabling inputs just to signal default values.
- Config taxonomy: avoid hardcoded group names in UI, derive them from the registry or make them required, and keep advanced and experimental settings collapsed by default to reduce noise.
- Config typing: avoid freeform strings for fixed option sets (for example TTS voice), use enumerated options and shared constants, and avoid hardcoded config key strings in consumers by relying on shared key constants or typed accessors.
- Config access: prefer shared helpers that resolve and transform config values (trim strings, validate enums, etc.) instead of inline snapshot parsing. When you add a helper to replace boilerplate, update existing consumers proactively, keep it KISS, and avoid hedging.
- Portal base URLs are always configured. Do not add fallback behavior for missing `FRONTEND_SITE_URL` or relative portal links; treat missing config as an error.
- **MCP service accounts do not introduce a second permission model, and must not grow one.** A service account token binds to a Discord bot's user id, and every read still goes through `checkUserMeetingAccess` for that id, so the boundary is the bot's roles and channel overwrites. The token's own `guildId` and optional `channelIds` only ever narrow that result; nothing on a token may widen access. Two guards exist because they are the only ways the model breaks, and both belong in `mcpServiceAccountService`: the bound identity must be a bot (a token bound to a human would inherit their personal meetings and their access in other guilds, which manage-guild permission does not cover), and the bot must not hold Administrator (which short-circuits every channel overwrite in `discordPermissionsService`, leaving no boundary to configure).
- Channel-allowlist enforcement for service accounts lives in `mcpMeetingService`, not at the call sites: `meetingMatchesListFilters` covers both list paths and `assertMeetingChannelAllowed` covers both direct lookups. A new MCP read path must route through one of them, and its out-of-scope error must stay identical to a permission denial so a restricted token cannot probe for meetings it cannot see.
- Desktop recorder hosted API routes are gated by `ENABLE_DESKTOP_API`; keep it false unless running an intentional beta/canary, and restrict access with `DESKTOP_ALLOWED_USER_IDS` or `SUPER_ADMIN_USER_IDS`.
- When launching Chronote Desktop for operator/manual testing, use production endpoints by default: run `yarn desktop:start:prod` from the repo root. Use `yarn desktop:dev:prod` only when an interactive Tauri dev server is needed. Do not use generic `yarn dev` unless explicitly testing a local API/portal flow.
- Avoid hedging and speculative fallbacks. Follow YAGNI and KISS, do not add code for hypothetical cases unless explicitly required.
- Config constraints: when numeric settings depend on caps, use minKey/maxKey to reference other config entries, clamp inputs in the UI, and enforce bounds in API validation.
- My Meetings UX: default the portal home list to All time, keep the initial page bounded, and use an explicit Load more control for older meetings.
- Personal Settings UX: keep account-owned integrations and preferences under `/portal/settings`; keep My Meetings focused on browsing, filtering, upload entry, and meeting detail access.
- Playwright mock mode: ensure only the mock API (port 3001) and frontend dev server (port 5173) are running. If ports are occupied, stop them first (`Get-NetTCPConnection -LocalPort 3001,5173 | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ }`). Clear `VITE_API_BASE_URL` (for example via `.env.local`) so the frontend uses the mock server.
- Comment hygiene: don’t leave transient or change-log style comments (e.g., “SDK v3 exposes transformToString”). Use comments only to clarify non-obvious logic, constraints, or intent.
- Writing style: do not use em dashes in copy/docs/comments; prefer commas, parentheses, or hyphens.
- Planning questions: number clarifying questions when asking the user to choose direction.
- **User data in public outputs (CRITICAL):** This is a public repository. NEVER include real user data in PR descriptions, commit messages, issue comments, code comments, docs, or any other content that is or may become publicly visible. This includes Discord usernames, display names, user/server/channel IDs, meeting content, transcription excerpts, notes content, server names, and any other user-generated or user-identifying information. When referencing real scenarios for context, replace all identifying details with generic placeholders (e.g., "User A", "User B", "Server X", "Channel Y", "#general"). The technical meaning must be preserved while all PII and user content is stripped.
- GitHub prose: prefix any PR comments, PR descriptions, issue text, or other GitHub prose with `[AGENT]`. If the prose starts with a
  Markdown heading, put `[AGENT]` on its own line or add a blank line before the
  heading; never concatenate the prefix directly with a heading like
  `[AGENT]## Summary`.
- PR descriptions should stay concise. Do not publish long "Tests" or "Verification" checklists for checks already enforced by CI; mention validation only when it adds non-obvious signal, such as manual/provider checks, visual-review rationale, skipped checks, or rollout risk.
- Durable instruction capture: when the user corrects a standing behavior or asks future agents to know something, update the appropriate durable surface in the same turn. Use repo `AGENTS.md` for Chronote-specific rules, and global OpenCode or basics-agentic-dogfooding guidance for cross-repo meta-instructions.
- PR review hygiene: before asking the user to merge a PR, reply to and resolve all AI bot review threads (Copilot, Greptile, etc). If we disagree with the suggestion, say so and resolve the thread anyway. Use reactions when helpful. When replying to review comments, reply directly to each thread using the review comment replies API (`POST /repos/OWNER/REPO/pulls/PR/comments/COMMENT_ID/replies`), not by creating a new pending review. Direct replies keep each response in its original thread context.
- PR bot thread audit: when checking for unresolved AI comments, fetch _all_ review threads via the GitHub GraphQL API and paginate until `hasNextPage=false` (don't assume `first: 100` is enough). Also scan PR issue comments for bot follow-ups (Greptile sometimes posts as regular PR comments, which cannot be "resolved" but should still be replied to or reacted to).
- Post-push PR SOP: after every commit push to an active PR, run a full checks and review audit (status checks, unresolved AI threads, bot issue comments, mergeability), then wait at least 5 minutes and re-check for late AI reviewer comments before declaring merge-ready.
- Documentation accuracy: after changes that affect behavior, config, prompts, infra, or user flows, review and update `AGENTS.md`, `.github/copilot-instructions.md`, `README.md`, and any related `docs/` or prompt files to keep them accurate and high signal. Keep the copilot instructions high level to reduce drift.
- Docs policy: user-facing PRs should include a docs delta in `apps/docs-site/`. Purely technical PRs can use `docs-exempt` with rationale.
- README should stay high signal for users, avoid listing research outcomes like query parameter details. Put rationale or research notes in planning documentation files instead.
- Backwards compatibility: ask the user whether changes need to preserve compatibility for URLs, API contracts, stored data, or behavior. If unsure, ask before implementing and favor simplicity for early-stage tradeoffs.
- Backwards compatibility update (January 6, 2026): prioritize DynamoDB data compatibility; URLs and UI flows can change without preserving prior behavior.
- Workflow sync: when changing GitHub Actions env or steps, review `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, and `.github/workflows/deploy-staging.yml` to keep them aligned.
- ADRs: use the existing ADR format (see `docs/adr-20260106-voice-receiver-resubscribe.md`). New ADRs must live in `docs/` with filename `adr-YYYYMMDD-<slug>.md` and include Status, Date, Owners, Context, Decision, Consequences, Alternatives Considered, and Notes. Keep ADRs short and factual. Update or add ADRs when a design decision changes behavior or data contracts.
- “Remember that …” shorthand: when the user says “remember that <rule>”, add it to AGENTS.md under the relevant section as a standing rule.
- Do not suppress runtime warnings by monkey-patching globals (e.g., overriding console.error). Fix the underlying issue or accept the warning; never silence it via code hacks.
- Stripe webhook parsing: keep a single `express.raw({ type: "application/json" })` at app-level in `webserver.ts`; do not add per-route raw parsers elsewhere.
- React tests: when a test triggers state updates (e.g., data-fetching effects), wrap renders/updates in `act` (from `react`/RTL helpers) to avoid act warnings instead of silencing console errors.

## Quick start (local)

- `yarn install`
- Copy `.env.example` to `.env`; set required tokens.
- `yarn dev` to start local Dynamo + init tables + bot. (`yarn dev` loads `.env`/`.env.local` into the child process so per-repo creds win over global environment variables.)

Optional Windows helper (prints loaded env, supports `-Mock` / `-SkipDocker`):

- `powershell -ExecutionPolicy Bypass -File scripts/dev.ps1`
- `powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 -Mock`

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

### Why each check exists

- Lint (ESLint) catches common errors and keeps code quality consistent. Docs: https://eslint.org/docs/latest/use/command-line-interface
- Format (Prettier) enforces a consistent style and removes formatting churn. Docs: https://prettier.io/docs/cli
- Tests and coverage (Jest) protect behavior and enforce coverage thresholds defined in `jest.config.ts`. Current global thresholds: statements 30%, branches 60%, functions 40%, lines 30%. Docs: https://jestjs.io/docs/29.7/configuration
- Build (TypeScript + Vite) validates type safety and ensures the frontend bundles. Docs: https://www.typescriptlang.org/docs/handbook/compiler-options.html and https://vite.dev/guide/
- Docs build (Docusaurus) validates docs compile and link integrity. Command: `yarn docs:check`. Docs: https://docusaurus.io/docs
- E2E (Playwright) validates core user flows against the UI. Docs: https://playwright.dev/docs/running-tests
- Code stats and complexity (scc + lizard) keep size and complexity visible in CI. Lizard uses its default warning thresholds (CCN > 15, length > 1000, nloc > 1000000, parameter_count > 100). Use `.sccignore` for scc exclusions and `whitelizard.txt` to suppress known complexity offenders. Docs: https://github.com/boyter/scc and https://github.com/terryyin/lizard
- Markdown lint (markdownlint-cli2) enforces consistent Markdown style across all repo `.md` files. Config in `.markdownlint-cli2.jsonc`. Command: `yarn markdownlint:check` (or `yarn markdownlint:fix` to auto-fix). Docs: https://github.com/DavidAnson/markdownlint-cli2 and https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md
- IaC scan (Checkov via uvx) catches Terraform misconfigurations. Docs: https://www.checkov.io/2.Basics/CLI%20Command%20Reference.html and https://docs.astral.sh/uv/concepts/tools/
- Prompt sync (Langfuse) keeps repo prompt files aligned with Langfuse. Command: `yarn prompts:check`. It diffs the repo against the live Langfuse label, so a PR that edits anything in `prompts/` fails this check in `ci.yml` until the prompts are promoted. That red is expected on the PR; say so in the description rather than trying to clear it.
- **Prompt promotion is automatic on merge, and agents should not do it by hand.** The `Promote Prompts` job in `deploy.yml` runs after `Deploy Backend` succeeds and does the dry run, the push, and a verifying check. Two properties matter and are easy to break if this is ever changed:
  - **Order.** Code deploys first, prompts second. A prompt is safe against newer code, which simply ignores variables it does not reference, but not against older code. Promoting first is how a role-mention prompt once went live against code that did not supply its roster, producing plain-text role names that looked like a feature bug.
  - **Revision.** CI pushes from the merged commit, so it cannot revert a prompt that someone else promoted. `prompts:push` versions every local prompt that differs from the remote, so pushing from a stale checkout is genuinely dangerous. That is the main reason to leave this to CI.
- Deploy jobs deliberately do **not** gate on `Prompts Check` or `LLM Connections Check`. Both describe external Langfuse state rather than whether the code is good, both are already enforced by `ci.yml` on PRs and on master, and while they gated deploys a single Langfuse outage or an unpromoted prompt would silently skip every deploy job while the run still looked handled. Keep code-quality gates on the deploy path; keep external-state checks off it.
- If a prompt ever needs promoting outside a deploy, check out and pull the merged `master` first, run `yarn prompts:push --dry-run`, and confirm the "would push" list contains exactly the prompts you expect. Any extra name means the checkout is behind: re-sync instead of pushing.

### Evals

- `yarn eval:meeting-notes` runs the notes eval against a Langfuse dataset (`LANGFUSE_EVAL_DATASET`, default `meeting-notes`). Cases carry rendered prompt variables rather than a `MeetingData` object, so `formatParticipantRoster` and `formatRoleRoster` are exported from `notesPromptService.ts` for reuse.
- Mention grading is deterministic (`src/evals/roleMentionGraders.ts`): it verifies every emitted mention id came from the roster, blocks `@everyone`/`@here`, and scores recall against expected ids. Prefer extending these graders over adding a judge model.
- `yarn evals:harvest-downvotes --output <path>` turns downvoted meetings into eval case stubs with `expectedOutput` left blank for a human to curate. Output contains real meeting content: write it outside this public repo. `*.harvested.json` is gitignored as a backstop.
- `yarn evals:upload --dataset <name> --file <cases.json>` seeds a Langfuse dataset, creating it if absent. Items upsert on id (explicit `id`, else `metadata.label`), so re-uploading a file is idempotent; a case with neither gets a generated id and the command warns that re-running will duplicate it. `meeting-notes` and `meeting-summary` are seeded and both evals run. `transcription-eval` is not, and cannot be from the sample file: it points at an audio clip that is not in the repo, and grading needs a human-checked reference transcript, so seeding it is a content task. A runner pointed at a missing dataset now names the upload command instead of throwing from `dataset.get`.
- Build a runner's `expectedOutput` schema with `expectedOutputSchema()` from `src/evals/expectedOutput.ts`, never a bare `z.object(...).optional()`. Langfuse sends `null` for a case that declares none, `.optional()` accepts a missing key but rejects an explicit null, and the result is an aborted experiment rather than a case whose reference-dependent grades are skipped. The helper exists so this cannot be got wrong per runner.
- **Running any eval needs a full app environment, not just Langfuse keys.** The runners import `configService`, which validates the entire config at module load, so `DISCORD_CLIENT_ID`, `OPENAI_API_KEY`, `FRONTEND_SITE_URL`, `OAUTH_SECRET` and friends must be set or the process exits before it reaches Langfuse. `scripts/mock.env.example` covers the non-OpenAI values.
- Do not point `eval:transcription` at the project's existing `Transcription` dataset. It was created outside this repo, holds one item with an empty `expectedOutput`, and its input shape does not match `DatasetInputSchema`. Seed a kebab-case `transcription-eval` instead, matching the other names.
- The two datasets that do exist were created outside this repo and are not eval-ready: `Transcription` (1 item, empty `expectedOutput`) and `hallucination-audit-20260209` (198 items, `expectedOutput` null). Neither matches the runners' input schemas. Treat them as raw corpora, not graded sets.
- `yarn eval:meeting-notes` has been run end to end against live model output (2026-07-30, `meeting-notes`, 2 cases, all six grades 1.000). The graders work on real notes: the multi-assignment case emitted both expected role mentions plus the expected member mention, and the no-assignment case correctly emitted none. Recall over a non-empty expected set cannot pass without the mentions actually being present, so that result is not vacuous.
- Pass `--items` to print each case's generated notes and per-case grades. Aggregate scores tell you a run regressed but not why.

### Coverage guidance

- Prefer adding tests over coverage ignores.
- If a coverage ignore is unavoidable, use c8 ignore directives with a short justification comment.
- After coverage improvements or coverage scope changes, round each threshold down to the nearest 10 and keep it in sync with `jest.config.ts`. Do not lower a threshold below its pre-PR value unless the coverage scope meaningfully expands, in which case reset to the new rounded baseline and call it out in the PR.

## Agent Skills

Agent workflow skills are mirrored by client:

- Codex: `.codex/skills/<name>/SKILL.md`
- Claude Code: `.claude/skills/<name>/SKILL.md`
- OpenCode: `.opencode/skills/<name>/SKILL.md`

When a shared workflow changes, keep all three skill mirrors in sync. Skills are discovered at client startup and cached, so adding or modifying skills may require restarting the client. Run `yarn agent:check` after agent-tooling changes.

- `pr-review-recycle`: agentic loop for processing Copilot/Greptile/Codex PR review threads until checks are green.
- `docs-authoring`: workflow for creating and maintaining public product docs in `apps/docs-site/`.
- `pr-post-push-sop`: post-push checklist for checks, AI review audit, and a 5 minute late-comment wait before merge-ready updates.
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
