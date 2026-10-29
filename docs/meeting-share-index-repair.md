# Historical guild-share index repair

This manual tool discovers missing guild-share pointers for historical personal meetings. It defaults to dry-run, reports aggregate counts, and processes a bounded number of metadata inventory pages. It does not run during startup, requests, scheduled jobs, or deployment.

Task 6 delivers source and synthetic tests only. No live inventory, including dry-run, is authorized by this task. Any future production inventory requires its own approved target and read budget. A complete approved inventory reporting zero missing pointers satisfies repair acceptance without Apply. Missing pointers require separate concrete approval for Apply and a subsequent approved readback.

## Target and authority

Use the private Chronote operations procedure to select credentials, account, table prefix, and authorization. The CLI requires `--expected-account`, `--history-table`, `--index-table`, and `--checkpoint`. It refuses mock/local mode, configured table-name mismatches, an unexpected STS account, non-ACTIVE tables, or table ARNs outside the expected account and `us-east-1`. STS uses the same credential provider as the DynamoDB client. Both physical table IDs bind checkpoints to a table generation, so replacing a table under the same name refuses resume.

Identity checks establish the target, not permission to run the repair. IAM must separately allow STS GetCallerIdentity, DynamoDB DescribeTable on both tables, Scan and GetItem on MeetingHistory, and GetItem on MeetingUserIndex. Apply additionally needs PutItem on MeetingUserIndex. Use read-only credentials for an approved dry-run where possible. No canonical history writes or deletion permission is needed.

Example syntax, with placeholders rather than usable production identifiers:

```text
node -r ts-node/register scripts/repair-meeting-share-index.ts \
  --expected-account <approved-account> \
  --history-table <approved-prefix>MeetingHistoryTable \
  --index-table <approved-prefix>MeetingUserIndexTable \
  --checkpoint <private-directory>/guild-share-dry-run.json \
  --limit 100 --max-pages 1
```

Apply requires explicit `--apply` and a separate checkpoint. A dry-run checkpoint cannot become an Apply checkpoint. This example documents invocation only; it is not an authorization to run it.

## Metadata and authorization

The Scan and strong canonical GetItem use exactly this projection:

```text
guildId, channelId_timestamp, meetingId, timestamp,
ownershipScope, ownerUserId, accessGrants
```

The Scan filter selects rows with grants and either personal ownership or the legacy `personal:` guild prefix. It does not fetch notes, transcript, title, summary, attendance, media keys, or a full MeetingHistory object. It has no GSI dependency. The scan is an inventory hint, not an authorization decision.

For every candidate with guild grants, the service strongly rereads canonical metadata. It skips a deleted row or any changed metadata. For each distinct current guild grant it builds the existing deterministic `GUILD_SHARE#...` pointer through `buildGuildShareIndexRecords`, strongly checks the pointer key, and writes only missing pointers through the existing repository write boundary. Dry-run performs the same reads and zero writes. Existing pointers are left intact.

A grant can change after the canonical reread. This tool cannot atomically fence a grant change against a separate pointer write. A raced pointer remains a discovery hint: the existing library authorization rereads canonical history and checks its current grant policy before exposing any meeting fields. The repair does not extend cached permission lifetimes or promise immediate revocation beyond existing caches. A synthetic library regression verifies that a stale guild-share pointer exposes no meeting data.

## Budgets and receipts

`--limit` defaults to 100 and must be 1 through 100. Each service call issues one Scan only, including an empty filtered page with a continuation key. `--max-pages` defaults to 1 and is a per-invocation budget, between 1 and 10,000. Reaching that budget requires another explicit invocation to continue.

For an inventory page examining at most L rows, there are at most L canonical GetItem calls. Let G be the total number of distinct guild grants on unchanged personal candidates. There are at most G pointer GetItem calls and G single-pointer PutItem calls. Existing pointers reduce writes. Grant count varies per row, so L does not cap G. SDK transport retries may make additional underlying requests. A Scan projection and filter reduce returned data, not DynamoDB read capacity charged for examined rows; AWS may also return fewer rows at its page byte limit.

Stdout emits only mode, invocation page number, and aggregate counters: `examined`, `personalWithGuildGrants`, `missingPointers`, `written`, `skippedChanged`, `failed`. Counters describe a page, not distinct rows across replays. Stderr is a generic stop message. Provider errors, grants, identifiers, request bodies, and cursors are never printed. `skippedChanged` means the current page did not repair that candidate; approved follow-up inventory must assess remaining missing pointers.

## Checkpoints, interruption, and replay

Keep checkpoints outside Git in a private operator directory. They contain only version, verified target identity, mode, completed-page count, completion flag, and a bounded DynamoDB continuation key. The key contains customer identifiers, so the checkpoint is private evidence. It contains no grants, meeting content, or provider payloads. POSIX creation mode is 0600; Windows access inherits directory ACLs, so use a private directory.

An exclusive sibling `.lock` blocks concurrent use of the same checkpoint. Each replacement writes an exclusive same-directory temporary file, flushes and closes it, then renames it over the checkpoint. This provides whole-file replacement; it does not promise power-loss durability of the parent directory entry. A failed replacement preserves the previous progress and requires explicit replay. A hard process termination can leave `.lock` or an unpromoted temporary file. Verify that no repair process remains before removing those private files. Different checkpoint paths do not coordinate with one another; the operator must not run concurrent repairs against the same target.

The initial checkpoint is saved before inventory. Successful pages advance it. A read/write failure stops immediately without advancing the page. An uncertain write never triggers automatic page replay. SIGINT/SIGTERM abort reads and stop before subsequent writes; an in-flight PutItem may still complete. A fresh explicit invocation replays the retained page. Deterministic keys and strong existence reads make successful or uncertain prior writes idempotent. A completed checkpoint issues no further inventory calls. Use a new checkpoint only for a separately approved fresh inventory.

## Activation and acceptance

Before any live use, approve exact account/tables, authority, read/write budgets, private checkpoint location, and whether the operation is inventory or Apply. Confirm the credentials and expected table identities through the tool's preflight. A dry-run receipt alone is not repair or runtime acceptance. Complete the approved inventory, review missing and changed counts, and obtain separate Apply approval if needed. After Apply, an approved fresh inventory and authorized library readback establish the outcome. Preserve sanitized receipts separately from private checkpoint evidence.

No live-provider or production acceptance occurred while implementing this tool.
