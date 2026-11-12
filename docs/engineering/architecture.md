# Architecture reference

## Tech stack

- Runtime: Node.js 24.22.2, TypeScript.
- Discord: discord.js v14, discord-api-types, @discordjs/voice for audio capture, @discordjs/opus, prism-media.
- AI: openai SDK; gpt-4o-transcribe for transcription; gpt-6.1-sol for notes; gpt-5.2 for summaries, cleanup, corrections and image prompts; gpt-5-mini for live gate; DALL-E 3 for images.
- Observability and prompt management: Langfuse for tracing, prompt versioning, and prompt sync scripts. AMG (Grafana) service account token is auto-rotated via EventBridge + Lambda (see `_infra/grafana.tf` and `_infra/README.md`). Critical alerts (ECS down, ALB 5xx, unhealthy hosts, rotation failures, OpenAI quota or rate-limit rejections, processing retry worker failures) are sent via SNS email and optionally to a Discord channel via a separate Node.js Lambda (see `_infra/notifications.tf` and `_infra/README.md`).
- Storage: AWS DynamoDB (tables: GuildSubscription, PaymentTransaction, StripeWebhookEvent, InteractionReceipt, ActiveMeeting, DeploymentControl, MeetingControlCommand, AccessLogs, RecordingTranscript, AutoRecordSettings, ServerContext, ChannelContext, DictionaryTable, MeetingHistory, MeetingUserIndex, PersonalMediaUploadJob, PersonalRecordingSegment, SessionTable, McpOAuthTable, NotionIntegrationTable), S3 for transcripts/audio.
- Infra: Terraform -> AWS ECS Fargate, ECR, CloudWatch logs; static frontend on S3 + CloudFront with OAC; local Dynamo via docker-compose.
- IaC scanning: Checkov runs in `.github/workflows/ci-core.yml`, called by PR CI and production deploys. Local: `npm run checkov` (uses `uvx --from checkov checkov`; install uv first: https://docs.astral.sh/uv/).
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
- Meeting lifecycle: `meetings.ts`, `commands/startMeeting.ts`, `commands/endMeeting.ts`, with the lifecycle services below. Records audio, chat log, attendance; splits audio; transcribes; generates notes; saves MeetingHistory (with transcript, notes versioning). See `docs/deployment.md` and `docs/adr-20261111-lifecycle-simplification.md`.
  - Start (`services/meetingStart.ts`) writes the per-server lease, the initial MeetingHistory row (`lifecycleVersion: 2`) and the auto-record suppression check in one transaction, and has 30 seconds to reach receiving audio.
  - The lease (`services/meetingLease.ts`, ActiveMeeting table) is the only lock on recording and covers capture only. Capture uploads checkpoint pieces to S3 as it goes.
  - Close (`services/meetingClose.ts`) is one sequence for every way a capture ends: confirm the lease, leave voice, flush, write `processing` with the end reason, duration, completion policy and (on an eligible worker) the finish claim, then always free the server. The server can start again at once.
  - Finish (`services/meetingFinish.ts`, with its loaders in `services/meetingFinishInput.ts`, delivery in `services/meetingDelivery.ts` and the loop in `services/meetingFinisher.ts`) is the one pipeline that saves and delivers a meeting, from the closing worker's memory or rebuilt from the history row and S3 checkpoint by any eligible worker. The finisher loop claims rows through `finish.*` on MeetingHistory, retries with backoff, and marks rows still open 24 hours after capture began as failed.
  - Workers register in DeploymentControl under `WORKERS` (`services/workerRegistry.ts`, `services/workerEligibility.ts`). Only eligible workers take new meetings, general commands and background jobs. Task protection (`services/taskProtection.ts`) covers live captures only. Timing constants live in `services/lifecycleTiming.ts`.
- Transcription, notes, and image generation: `src/services/transcriptionService.ts`, `src/services/notesService.ts`, `src/services/imageService.ts`.
  - Prompt builders live in `src/services/*PromptService.ts`.
  - Builds context from server/channel/meeting and recent history (`services/contextService.ts`).
- Transcription prompt is Langfuse-managed (`chronote-transcription-prompt`). Guardrails include a loudness gate (noise gate metrics, hard silence threshold, syllable rate, and logprobs), a prompt echo gate, and a low-confidence prompt/no-prompt vote fallback on slow snippets.
  - Snippet ASR attempts belong to `services/transcriptionRequest.ts`, with at most four attempts per candidate. Keep successful prompted work when a no-prompt vote retries; use attempt-aware accounting and operation-local exhausted-error provenance for the breaker. See `docs/audio-transcription.md`.
  - A finalized audio verification pass can run at meeting end (`transcription.finalPass.enabled`) to auto-apply high-confidence hallucination fixes before notes generation.
  - GPT prompts tuned for cleanup, notes, and optional image generation. Notes guidance covers explicit assignments and volunteered follow-ups, stated owners and deadlines, and qualified or completed status. The prompt instructs a silent completeness check within the same generation call.
- Dictionary management: `commands/dictionary.ts`, `services/dictionaryService.ts`
  - Terms are injected into transcription and context prompts, definitions are used outside transcription to reduce prompt bloat.
- Notes correction flow: `commands/notesCorrections.ts`
  - “Suggest correction” button → modal (single textarea).
  - Fetches saved notes + transcript from DB, uses the notes-correction model with a “minimal edits, do not copy transcript” prompt, shows a compact line diff, requires approval (meeting creator or ManageChannels if auto-record), saves canonical MeetingHistory plus durable update intent through the shared action and bumps version/last editor. The worker verifies later Discord delivery separately, preserving existing approval and Notion rules.
  - Web UI uses `meetings.suggestNotesCorrection` and `meetings.applyNotesCorrection` to generate a diff and apply changes, mirroring the Discord flow.
- Context management: `commands/context.ts` writes/reads ServerContext and ChannelContext.
- Meeting history persistence: start writes the initial row through `repositories/meetingHistoryTransitions.ts`; close's capture-end write and the finish pipeline's terminal save go through `repositories/meetingFinishRepository.ts`; other reads and updates use `db.ts` helpers.
  - Optional `processing` metadata records transcription, notes, and summary outcomes independently of lifecycle status. Missing outcomes are unknown. Never infer transcription failure from an unrelated upload error or insert processing notices into stored notes.
- Processing retry: `services/processingRetryEligibility.ts` decides eligibility for the portal, `meetings.retryProcessing` and `scripts/retry-meeting-processing.ts`; jobs live on the MeetingHistory row (`processingRetry`, `ProcessingRetryDueIndex`), run on eligible workers, and save through `updateMeeting`'s `regeneration` mutation. Gated by `meetings.processingRetry.enabled`, which stays off until the index is ACTIVE. The index and worker alarm ship through the `processing-retry` Terraform Plan/Apply scope in Sandbox and Production, which refuses while `UpdateDeliveryDueIndex` is missing. See `docs/adr-20261028-meeting-processing-retry.md`.
  - Users who cannot edit the meeting's notes see no retry control or job state. Retries never replay the finalized-audio pass but keep cleanup, and never replace notes a person edited. Operator runs exit 1 when retry is unavailable under `--apply`, a queueable meeting fails to queue, the run throws, or the analytics flush fails; skipped meetings, including those needing replace confirmation, are reported but do not fail the run.
- Web server: `webserver.ts` (health check, optional Discord OAuth scaffolding).

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
- AnnouncementDeliveryTable records operator announcement sends per announcement and server (pending, sent, failed) for idempotent reruns; written only by scripts/announce.ts.
