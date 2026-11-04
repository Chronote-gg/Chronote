# Send an operator announcement to every server

This operator command posts one approved notice, as an embed from the Chronote bot, into each server Chronote is installed in. It is for incidents and for changes server admins need to hear about. The tool does not write or approve text. The operator writes it, previews exactly where every copy will go, and sends only that confirmed preview.

Preview is the default mode. It reads Discord and DynamoDB and writes nothing except private local files. Send requires the digest of an exact preview and an interactive terminal. No agent, CI job or test runs `send`. The operator runs every send by hand.

## Prerequisites

The delivery table, `AnnouncementDeliveryTable`, records every send and is what makes a rerun safe. It exists only after both of these:

1. The operator applies a reviewed bootstrap change that grants the Terraform roles `dynamodb:CreateTable` for the table and the KMS encryption-context grant for the table name. For Sandbox, the change also adds `AnnouncementDeliveryTable` to the bootstrap `table_suffixes`.
2. The operator sets `enable_announcement_delivery_table` to true and applies Terraform.

Until then, `send` refuses before its first post and `preview` warns `delivery table not found; send will refuse until the Terraform change is applied`.

A deploy carrying the `announcements.operatorNotices.enabled` server setting must also be live before the first send. The embed footer tells admins they can turn these notices off in Chronote server settings, so that setting has to exist.

## Credentials and permissions

Use the supported Node 24 runtime and locked dependencies. Select the AWS account, region and both tables explicitly. Use the AWS SDK credential chain with an explicitly selected profile, such as `AWS_PROFILE` in the invoking shell. Set `DISCORD_BOT_TOKEN` in the environment through the authorized secret route. Never put credentials in command arguments. The command does not load `.env` or the application config. It uses Discord REST only and never opens a gateway session.

The command verifies the caller account through STS before any read, and all AWS clients use the selected region, the credentials STS verified, and `maxAttempts=1`. Send also checks that the bot token belongs to the bot that made the preview.

The selected identity needs only:

- `sts:GetCallerIdentity`.
- `dynamodb:Query` on the config overrides table, to read each server's opt-out and notes channel.
- `dynamodb:DescribeTable`, `dynamodb:Query`, `dynamodb:PutItem` and `dynamodb:UpdateItem` on the delivery table. Writes are conditional.
- KMS use of the general application key (`app_general`) for those two tables.

## Fill a template

Copy a template outside every Git checkout, then replace every `{{...}}` placeholder:

- [`announcements/incident.md`](announcements/incident.md) for an open incident.
- [`announcements/incident-resolved.md`](announcements/incident-resolved.md) once it is fixed.

The front matter `id` is the idempotency key. Use a new id for new text. Each template starts with the house rules in an HTML comment, which never reaches Discord. Preview refuses a file with an unfilled placeholder, `@everyone`, `@here`, or user, role or channel mention syntax, and names each problem. It warns about a 17 to 20 digit number, which is probably a pasted id.

## Preview and review

Choose a new output directory outside all Git checkouts and shared folders. The command refuses an existing path and writes owner-only files, like the [recovery publication command](recovery-discord-publication.md). All names below are placeholders:

```text
yarn ts-node scripts/announce.ts preview --announcement FILE --account-id ACCOUNT --region REGION --config-table CONFIG_TABLE --delivery-table DELIVERY_TABLE --out NEW_PRIVATE_DIRECTORY
```

The command prints any warnings, the preview digest, and the summary line a send of this preview would produce, with `would_send` in place of `sent`. Open `preview.md` privately. It shows the embed as text, the warnings, every owner DM line, and one row per server with its decision, channel source, channel and rejected candidates. `preview.json` is the machine-checked copy. Do not edit it; make a fresh preview after any change.

Each server resolves like this. An opted-out server is skipped. A server with a usable community updates channel targets only that channel. A server without one tries its Chronote notes channel, then its system channel. A Discord read failure skips that server as `discord_error` and the run continues.

Read every warning. `announcement id ID already has N delivery records from an earlier preview` means those servers will not receive this version. Use a new id for new text.

## Owner DMs

When a server has a community updates channel but the bot cannot post there, the notice goes to the server owner by DM instead of a member-visible channel. This is the only DM the bot ever sends, and only to the owner. Members are never DMed. An opted-out server gets neither a post nor a DM. The DM is not redirected to a channel at send time, even if the updates channel has since become postable.

The DM carries the same embed with one line of message content above it:

```text
Chronote could not post this notice in the community updates channel of SERVER_NAME because it is missing: View Channel, Embed Links. Grant these to Chronote in that channel to receive future notices there.
```

The list names only the permissions that are missing. When the owner's DMs are closed, that server is skipped as `owner_dms_closed` and recorded as `failed` with that reason. Send does not DM an owner who no longer owns the server; it skips that server as `discord_error`.

## Canary, then full send

Send the preview to your own server first. Make a preview restricted to it, which fails if Chronote is not installed there:

```text
yarn ts-node scripts/announce.ts preview --announcement FILE --account-id ACCOUNT --region REGION --config-table CONFIG_TABLE --delivery-table DELIVERY_TABLE --out NEW_PRIVATE_DIRECTORY --guild-id YOUR_GUILD
yarn ts-node scripts/announce.ts send --preview NEW_PRIVATE_DIRECTORY/preview.json --expect-preview-sha256 DIGEST
```

Check the post in Discord. Then preview again without `--guild-id`, into another new directory. Your server shows `already_sent`. Review it and send:

```text
yarn ts-node scripts/announce.ts send --preview NEW_PRIVATE_DIRECTORY/preview.json --expect-preview-sha256 DIGEST
```

Send takes its whole scope from the preview, so account, region, table and server flags are invalid. It refuses when standard input is not an interactive terminal, when the digest differs from the file or the flag, when the preview is more than 60 minutes old, and when the delivery table is missing.

Send works one server at a time with at least one second between posts. Before each server it re-reads the opt-out and re-checks the previewed channel. A server that opted out, lost permissions, lost its channel or removed the bot since the preview is skipped with a reason and never redirected. Each server gets a conditional `pending` record, then the post, then `sent`. Ctrl-C stops before the next server and still prints the summary.

## Read the summary

Send prints one line per server, then one summary line:

```text
announcement incident-2026-11-04: sent=0 owner_dm=0 skipped=0 (opted_out=0 no_channel=0 missing_permissions=0 owner_dms_closed=0 discord_error=0 already_sent=0 pending_unknown=0) failed=0 unknown=0
```

`sent` counts every delivery and `owner_dm` is how many of those were owner DMs. `failed` is a definite Discord rejection, including a rate limit that persisted past three attempts, recorded as `failed` with `discord_STATUS`. `unknown` is a post whose outcome is unknown: a server error, timeout, interrupt or dropped connection.

| Exit | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Preview written, or every send settled with no failures or unknown outcomes.   |
| 1    | Failures, unknown outcomes, an interrupt, or an operational error. Read lines. |
| 2    | Invalid arguments or input, or a refused send. Nothing was posted.             |

## Unknown outcomes and pending records

An unknown outcome leaves the record `pending`, because the message may exist. A later preview shows that server as `pending_unknown` and never posts there again. Check those channels by hand. Never mark a pending record failed to force a resend; the original post may have landed late.

A line saying a delivery record update failed means the post happened but its record stayed `pending`. Treat it like `pending_unknown`.

## Retry definite failures

After fixing the cause of `failed` records, make a fresh preview with `--retry-failed`. Failed servers are then resolved again and can receive the notice. `sent` and `pending` records are never retried.

```text
yarn ts-node scripts/announce.ts preview --announcement FILE --account-id ACCOUNT --region REGION --config-table CONFIG_TABLE --delivery-table DELIVERY_TABLE --out NEW_PRIVATE_DIRECTORY --retry-failed
```

Keep preview directories, live ids and send output in the private operations repository, never in this repository.
