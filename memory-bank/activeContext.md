# Active Context (Dec 18, 2025)

## What we’re focused on right now

- **Live voice agent**: gate (gpt-5-mini) decides when to speak; responder generates the line; TTS streams into Discord and is mixed into recordings; thinking cue loops while replying.
- **Meeting tagging & recall**: freeform tags, edit buttons during/after, tags shown on meeting summary. `/ask` uses recent meetings (guild default, channel optional) with tag suggestions from history.
- **Billing & auth**: Stripe checkout + billing portal; webhook writes GuildSubscription/PaymentTransaction and handles payment_failed + subscription_deleted; sessions in SessionTable; Discord OAuth optional. API routes live under `src/api/` (billing, guilds) with one app-level Stripe raw parser.
- **Frontend**: Vite + React 19 + Mantine 8 UI; billing/status page at `/billing`; deployed to S3 + CloudFront.
- **Quality bar**: `yarn run check` (lint --fix, prettier --write, tests, backend build, Vite build); `check:ci` is the non-fixing variant.

## Recent notable changes

- Onboarding wizard `/onboard` (context, autorecord prompt, feature tour, upgrade CTA) with installer capture and 24h state TTL.
- Live voice gate fixes: removed fallback, boolean-only gate, correct params, thinking cue spacing.
- Bot speech appended to transcript/recording only on successful playback.
- Tag editing buttons on start/summary embeds; tags shown on summary (not notes).
- Stripe: added SessionTable; webhook now handles payment_failed and subscription_deleted.
- Frontend migration + Mantine 8 UI; billing page shipped.
- Upgrade prompts: surfaced free-tier limits (daily meetings, image gen gated, `/ask` depth); startmeeting shows remaining free meetings.
- SG note: ECS service SG egress still temporarily open for voice debugging; tighten later.

## Immediate next steps

- Improve live responder context (longer window + past meeting snippets) and begin retrieval/RAG.
- Better tag surfacing (common tags per guild) and edit-from-summary UX.
- Tighten SG egress once voice is stable.

## Reminders / guardrails

- Don’t silence warnings by monkey-patching globals; fix root cause.
- Keep secrets in `configService`; avoid re-exporting from `constants.ts`.
- Run `yarn run check` after code changes; report results in handoff.
