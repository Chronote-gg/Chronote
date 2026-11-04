# Operator announcements design

Date: 2026-11-04. Status: approved by the operator, 2026-11-04.

## Intent

When Chronote has an incident, or a change server admins need to hear about, the operator needs one command that posts an approved notice into every installed server, as the Chronote bot, where server admins will see it. During the November voice-leave incident there was no such path: every message was written from scratch and sent by hand to individual customers. Issue 571 asks for an incident communication template. This design is the delivery mechanism for that template.

The tool is a pipe, not an author. The operator writes and approves the text. The tool resolves where each server's copy goes, proves the bot may post there, shows the operator exactly what will happen, sends only after an explicit confirmation of that exact preview, and records every send.

## Goals

- The operator can post one approved announcement, as an embed, into each installed server.
- Target channel per server, in order: the server's community updates channel (Discord's `public_updates_channel_id`, where Discord itself sends admin notices), else the server's configured Chronote notes channel, else the server's system channel.
- A server can opt out with a server setting. Opted-out servers are never posted to.
- A dry run lists every server, its chosen channel or skip reason, and renders the embed, without sending anything.
- Sending requires the exact dry-run preview to be confirmed by its digest. There are no automatic or scheduled sends.
- Every send is recorded durably, and every run ends with one summary line of sent, skipped by reason, and failed.
- Reusable incident and resolved templates ship with the tool.

## Non-goals

- Writing or approving announcement text. That is the operator's.
- DMs to users or server owners. Never.
- Email. The issue 571 email template stays a manual operator task.
- Scheduling, retries on a timer, or any send without the operator at the keyboard.
- A web UI or slash command for sending.
- Editing or deleting announcements after they are posted. A correction is a new announcement.
- Status page integration (issue 570 is separate).

## Anti-goals

These would make it a failure even if it technically works:

- Any agent, CI job, or test causes a real message in a real server.
- A server that opted out, or whose admins locked the bot out of a channel, receives a post anyway.
- A rerun after a partial failure double-posts to servers that already got the notice.
- An announcement pings anyone (`@everyone`, `@here`, roles, or users).
- Public text carries operational figures such as server counts, share of users, costs, ids, or internal names.

## Constraints

- Chronote is live. This lane delivers a PR to READY. No merge, deploy, Terraform apply, or production write by an agent.
- The repository is public. Nothing in code, docs, templates, or the PR may contain real server, channel, or user identifiers or names.
- Follow the existing operator-script pattern in `scripts/publish-recovered-meeting.ts` and `docs/operations/recovery-discord-publication.md`: explicit AWS account, region and table flags; STS account verification; `DISCORD_BOT_TOKEN` from the invoking shell; no `.env` and no full application config; preview then apply against an approved preview digest.
- REST only. The script must not open a second gateway session with the production token.

## Shape

### Command

`scripts/announce.ts`, run with `yarn ts-node`, two modes.

```text
yarn ts-node scripts/announce.ts preview --announcement FILE --account-id ACCOUNT --region REGION --config-table CONFIG_TABLE --delivery-table DELIVERY_TABLE --out NEW_PRIVATE_DIRECTORY [--guild-id GUILD ...]
yarn ts-node scripts/announce.ts send --preview NEW_PRIVATE_DIRECTORY/preview.json --expect-preview-sha256 DIGEST
```

- `preview` is the default mode and the dry run. It reads Discord and DynamoDB only. It writes `preview.json` (stable, machine-checked) and `preview.md` (human-readable: the rendered embed as text, then one row per server with chosen channel or skip reason) into a new private directory, using the same exclusive-create and owner-only permission handling as the recovery publication command. It prints the preview digest and the summary line it expects a send to produce.
- `--guild-id` (repeatable) restricts the run to named servers. This is how the operator does a canary send to their own server first.
- `send` takes the scope from the saved preview only; any other scope flag is invalid. It recomputes the digest and refuses on mismatch. It refuses when standard input is not an interactive terminal, so a send cannot be run by an unattended or agent shell. Before each server it re-reads that server's opt-out setting and re-checks permissions on the previewed channel; if either changed, that server is skipped with a reason and never redirected to a different channel than the operator approved.
- The preview carries a creation time. `send` refuses a preview older than a fixed limit (builder picks a constant, about one hour) so a stale target list is not sent.

### Announcement input

A Markdown file with YAML front matter, or the equivalent JSON.

- Front matter: `id` (required, stable, kebab-case, the idempotency key), `kind` (`info`, `incident`, `resolved`), `title`.
- Body: the embed description, Discord Markdown, passed through as written.
- Optional `fields` (name and value pairs) for structured lines.
- Unfilled template placeholders (`{{...}}`) fail preview with the placeholder names.
- Text containing `@everyone`, `@here`, or user, role, or channel mention syntax fails preview.
- A run of 17 to 20 digits (snowflake shaped) produces a preview warning, as a guard against pasted ids.

### Embed

- Title, description, fields, a colour per kind, a timestamp, and a fixed footer telling admins where to turn these notices off in Chronote's server settings.
- `allowed_mentions: { parse: [] }` on every send.
- Validated against Discord embed limits with the existing `validateLimits` in `src/services/discordEmbedLayout.ts`; an over-limit announcement fails preview.

### Target resolution

For each installed server (`GET /users/@me/guilds`, paginated; the current `listBotGuilds` reads only the first page):

1. If the server's opt-out setting is set, skip `opted_out`.
2. Build candidates in order: community updates channel, configured notes channel (`notes.channelId` at server scope), system channel. Drop missing, deleted, duplicate, and non-text candidates (only guild text and announcement channels qualify).
3. Take the first candidate where the bot has View Channel, Send Messages, and Embed Links, computed from the guild's roles, the bot member's roles, and the channel's permission overwrites, with the Administrator rule. (Bots cannot own guilds, so there is no owner rule.) Extract the existing overwrite computation in `src/services/discordPermissionsService.ts` into a pure function and reuse it, rather than writing a second permission model.
4. If no candidate qualifies, skip `no_channel` when there were none, or `missing_permissions` listing each candidate and its missing permissions.
5. A Discord read failure for a server is a skip with `discord_error` and the status code, never a crash of the whole run.

Decided (operator, 2026-11-04): when the community updates channel exists but the bot cannot post there, resolution falls through to the next candidate rather than skipping the server. The notices are for the people who use Chronote, not only admins. The preview shows the fall-through and why.

### Opt-out setting

A new server-scope boolean config key, `announcements.operatorNotices.enabled`, default true, admin-editable toggle, registered in `src/config/registry.ts` so it appears in the existing server settings card with no new UI. Opt-out means the stored server override is false. The script reads the server-scope override directly from the config overrides table named by `--config-table`; it does not load the application config service. The public admin docs get one line describing the toggle.

### Send records

A new DynamoDB table, `AnnouncementDeliveryTable`: partition key `announcementId`, sort key `guildId`. Attributes: `channelId`, `channelSource` (`public_updates`, `notes`, `system`), `messageId`, `status` (`pending`, `sent`, `failed`), `reason`, `previewSha256`, `createdAt`, `updatedAt`. Point-in-time recovery and the general KMS key like the other tables. Added under `_infra/` (beside the config tables in `_infra/config.tf` or with the others in `_infra/main.tf`, builder's choice) and to `scripts/init-dynamodb.js`. The bot task does not read it, so no ECS task policy change.

Write order per server, which is what makes reruns safe:

1. Conditional put of a `pending` record (fails if any record exists for that announcement and server).
2. Post the message.
3. Update the record to `sent` with the message id, or to `failed` only on a definite rejection (a 4xx, including a 429 that persists past retry). An ambiguous outcome (5xx, timeout, dropped connection) leaves the record `pending`, because the message may exist.

Decided (operator, 2026-11-04): ambiguous outcomes are never marked `failed`, so the retry flag can never double-post. This matches the never-retry-an-uncertain-write rule in `docs/operations/recovery-discord-publication.md`. The cost is more servers to check by hand after a flaky run.

A rerun of the same announcement id skips `already_sent` for `sent` records and `pending_unknown` for `pending` records (a crash between steps 2 and 3; the operator checks those by hand). It does not retry `failed` records unless the operator passes an explicit flag on a fresh preview. The conditional put also stops two concurrent runs double-posting.

`send` refuses before its first post if the table does not exist, with a message saying the Terraform change must be applied first.

### Pacing

Strictly sequential: one server at a time, a fixed minimum interval between posts (builder picks a constant near one second), and Discord's `Retry-After` honoured. The existing transport in `src/services/discordMessageEditor.ts` reads `Retry-After` into its error but does not retry, so the announcement layer does a bounded retry on 429 (builder picks the bound). A 429 that persists past that bound is a `failed` record for that server, and the run continues.

### Summary line

One line at the end of preview and send, for example:

```text
announcement incident-2026-11-04: sent=0 skipped=0 (opted_out=0 no_channel=0 missing_permissions=0 discord_error=0 already_sent=0 pending_unknown=0) failed=0
```

Preview prints the same line with `would_send` in place of `sent`. Per-server detail stays in the private output directory, not the terminal.

### Templates

`docs/operations/announcements/incident.md` and `docs/operations/announcements/incident-resolved.md`, in the announcement file format, with `{{...}}` placeholders. They follow the communication template in the outage review:

- Incident: title naming the symptom, then status, what users see, who is affected, that recordings and notes are safe when true, what is being done, the next update time with timezone, and how a blocked server gets help.
- Resolved: title, what was fixed and when, whether anything is needed from the server, and a reply path.

Each template carries a comment block (stripped before rendering) with the house rules: a next-update time is a clock time with timezone, never "tonight"; no operational figures such as server counts, share of users, costs, ids, or internal names; professional and plain, not self-flagellating; one apology at most.

### Runbook

`docs/operations/operator-announcements.md`: credentials and least-privilege permissions (STS caller identity, config override reads, delivery table conditional writes), filling a template, preview, review, canary send to the operator's own server, full send, reading the summary, and handling `pending_unknown`.

## Testing

All tests use injected Discord and DynamoDB fakes. No test, CI job, or script default touches the real Discord API or AWS.

- Channel resolution: each fallback step, missing and deleted channels, non-text channels, duplicate candidates, opt-out first.
- Permission skipping: missing View, Send, or Embed Links each skip with the right reason; channel overwrite deny over role allow; member overwrite; Administrator bypass. Existing callers of the extracted permission function keep their behaviour.
- Input validation: placeholders, mentions, snowflake warning, embed limits.
- Idempotency: existing `sent` and `pending` records skip; conditional-put race skips; a 4xx writes `failed`; a 5xx or timeout leaves `pending`.
- Send gating: digest mismatch, stale preview, non-interactive input, missing table, a server that opted out or lost permissions between preview and send.
- Guild pagination.
- Summary line counts.

## Rollout

The PR stops at READY. Before the operator's first live send, two things must be live, and the PR body says so:

1. The Terraform change creating the delivery table (plan can be dispatched; apply is the operator's).
2. A deploy containing the opt-out toggle, so the footer's instruction points at a setting that exists.

The first live send is the operator's own command, a canary to the operator's own server with `--guild-id`.

## Left to the builder

- Module layout under `src/services/announcements/`.
- Exact constants (preview age limit, send interval).
- Colour values per kind.
- Front matter parsing approach (an existing dependency if one is present, else a small strict parser).
- Wording of the runbook and the footer, kept short.

## Size

About 1,300 changed lines including roughly 550 of tests, across about 15 files. Smaller alternative considered and rejected: a local JSON-lines ledger instead of a table and a checked-in opt-out list instead of a server setting. It saves the Terraform change, but it is not durable across machines, gives no protection against concurrent runs, and the brief requires the opt-out to live in server settings.
