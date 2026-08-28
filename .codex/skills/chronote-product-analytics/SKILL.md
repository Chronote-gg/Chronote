---
name: chronote-product-analytics
description: Analyze Chronote product adoption with PostHog and Langfuse, including active users, meetings, feature usage, AI telemetry, and privacy-safe resolution of active Discord guild IDs to live server names.
---

# Chronote Product Analytics

Use PostHog for product behavior and Langfuse for model telemetry. Keep website
visitors, authenticated product users, guilds, and AI generations distinct.

## Product metrics

- Confirm the active PostHog project is `Chronote` before querying.
- Read the live event schema before relying on event or property names.
- Unless the user chooses another definition, count a product-active user as a
  unique person who emitted `meeting_started`, `meeting_completed`, or
  `ask_question_asked`. Report anonymous website visitors separately.
- Use bounded UTC ranges. State whether the current day is partial.
- Report meeting starts and completions separately. Equal totals are evidence
  of aggregate completion, not a proven one-to-one pairing.
- Use the `langfuse-metrics` skill for aggregate model volume, cost, and
  latency. Do not treat healthy telemetry as output-quality evidence.
- For the daily operating view, run its `cost-report` command over the same UTC
  window as PostHog. Supply completed meetings and transcribed minutes as
  denominators, and report fully-unpriced model groups alongside attributed
  cost. This is operational cost accounting, not an OpenAI invoice
  reconciliation.
- Do not retrieve questions, answers, notes, transcripts, or identities when
  aggregate evidence answers the request.

## Resolve active guild names

PostHog intentionally stores `guild_id`, not the mutable guild name. Group the
requested product events by `guild_id` first, including only the counts and
time bounds needed for the question.

Resolve names in this order:

1. Match IDs visible in the signed-in Chronote server picker when the operator
   already has access.
2. For remaining IDs, run
   [`scripts/resolve-production-guilds.mjs`](scripts/resolve-production-guilds.mjs)
   with authorized production AWS access:

   ```text
   node .codex/skills/chronote-product-analytics/scripts/resolve-production-guilds.mjs --guild-id <id> --guild-id <id>
   ```

   The helper reads `meeting-notes-prod/discord-bot-token` from Secrets Manager
   in `us-east-1`, verifies that Discord identifies it as the Chronote bot, and
   prints only the requested IDs and names. Override `--secret-id`, `--region`,
   or `--expected-bot-id` only when the target environment is explicitly
   different.

3. If AWS authentication is unavailable, stop and request the appropriate
   read-only login. Do not substitute an unrelated local bot token, dispatch a
   workflow, expose a secret, or persist guild names into analytics.

Treat an ID absent from the bot guild list as unresolved; it may represent a
removed installation or the wrong environment. Report that distinction rather
than guessing a server name.

This skill is read-only. It does not authorize production configuration,
analytics instrumentation, billing, deployment, or Discord mutations.
