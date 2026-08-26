# Progress (Dec 18, 2025)

## What works

- **Core bot**: join/leave, record/mix audio, chat log capture, meeting lifecycle with tier-based duration cap.
- **Transcription & notes**: gpt-4o-transcribe for ASR; gpt-5.1 for cleanup/notes; image gen via DALL-E 3; resilience via cockatiel/bottleneck.
- **Live voice**: gate (gpt-5-mini) decides to speak; responder generates text; TTS plays into voice channel and is mixed into saved recording; thinking cue loops while generating; bot utterances appended on successful playback.
- **Tagging**: freeform tags on meetings; edit buttons on start/summary embeds; tags displayed on summary; tag suggestions from history.
- **Recall**: `/ask` uses recent meetings (guild default, optional channel) with configurable meeting count.
- **Billing**: Stripe checkout + billing portal; webhook writes GuildSubscription/PaymentTransaction; handles payment_failed and subscription_deleted; guild-scoped billing only; sessions in Dynamo-backed Express sessions; single app-level raw middleware for the webhook.
- **Frontend**: Vite + React 19 + Mantine 8 UI; TanStack Router/Query + tRPC + Zustand; marketing at `/` and authenticated portal under `/portal/*`; static deploy to S3 + CloudFront (SPA fallback, OAC).
- **Infra**: Terraform provisions ECS/Fargate bot, Dynamo tables (incl. SessionTable with TTL), transcripts bucket, frontend bucket + CloudFront; GitHub Actions deploy backend/frontend; Checkov in CI.
- **Quality gates**: `yarn run check` (fixing) and `yarn run check:ci` (non-fixing); Jest unit tests (tags, embed pagination, transcribe, frontend smoke); lint/prettier enforced.
- **Onboarding**: `/onboard` wizard (context, autorecord prompt, feature tour, upgrade CTA); installer captured; state TTL 24h; DM installer/owner on join.

## Recent milestones

- Live voice gate reliability fixes; removed fallback; corrected params; thinking cue spacing improved.
- Bot speech recorded/logged only after successful playback.
- Tag UX: edit buttons during/after; tags shown on summary; history-based suggestions; edit posted summaries.
- Stripe webhook now handles payment_failed and subscription_deleted; SessionTable added; config/env updated; billing is guild-scoped and API routes modularized under `src/api/`.
- Frontend migrated to Vite + React 19 + Mantine 8; portal scaffolded with TanStack Router/Query + tRPC + Zustand; deploy workflow syncs to S3/CloudFront.
- Upgrade prompts added for free-tier limits (daily meetings, image gen, `/ask` depth); startmeeting shows remaining free meetings.
- Docs refreshed (README, AGENTS); rule to wrap React tests with act instead of silencing console.

## Known issues / watch list

- ECS service SG egress temporarily open for voice debugging; must tighten when stable.
- Live voice: no overlap avoidance (bot can talk over people by design); revisit UX later.
- Need richer responder context/RAG over meeting history; consider PCM mixer to avoid interlaced voices.

## Next planned work

- Improve responder context (running window + selected past meetings) and start light retrieval.
- Enhance tag surfacing and cite tags/meetings in recall answers.
- Add richer Stripe/OAuth onboarding UX to frontend; tighten SG egress post-voice stabilization.
- Backfill summarySentence/summaryLabel for legacy meetings.

## Testing status

- Unit tests passing (tags, embed pagination, transcribe, frontend smoke).
- `yarn run check` green as of Dec 18, 2025.\*\*\*
