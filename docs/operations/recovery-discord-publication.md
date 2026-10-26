# Publish recovered notes into existing Discord posts

This operator command previews and publishes an approved stored meeting version into its recorded Discord posts. It preserves links, controls, attachments, warnings and the stored notes version. Preview is the default and performs provider reads only. Apply requires separate approval of its exact private preview digest.

## Prepare source and credentials

Use the supported Node 24 runtime and locked dependencies. Validate the installed stored recovery: the exact history key, approved notes version and raw notes hash, manifest identity and language, transcript pointer/hash and recovery artifact folder must agree. The supported legacy `operatorRecovery` manifest must match its installed history receipt. A free-standing manifest does not prove approval. Differing summary/title values require separate approval evidence and are currently blocked.

Select the AWS account, region, history table and artifact bucket explicitly. Use the existing AWS SDK credential chain with an explicitly selected profile, such as `AWS_PROFILE` in the invoking shell. Set `DISCORD_BOT_TOKEN` through the environment's authorized secret route. The command does not load `.env`, retrieve secrets or use full application configuration. Never put credentials in command arguments or evidence.

The selected identity needs `sts:GetCallerIdentity`, `dynamodb:GetItem` on the selected history table, and `s3:GetObject` on the selected manifest/recovery objects. Apply/reconcile also need the narrowly scoped conditional DynamoDB writes used by the shared publication repository. Apply also needs conditional `s3:PutObject` for publication previews, receipts and meeting-version claims. Reconciliation can update receipts/claims, but never Discord messages. Include the relevant KMS decrypt/encrypt permissions for encrypted resources. The bot must be able to read the saved channel and edit its own messages.

The runtime verifies the actual AWS caller account through STS. DynamoDB, S3 and STS share the resolved credentials, selected region and `maxAttempts=1`. S3 requests specify the expected bucket owner. The command verifies bot identity, channel guild and each post's author.

## Preview and review

Choose a new output directory outside all Git checkouts and public/shared folders. Its parent must exist. The command refuses to reuse an existing path. On Windows it installs and verifies an owner-only inheritable ACL before writing content. POSIX directories use mode 0700 and files mode 0600. File creation is exclusive.

All names below are placeholders:

```text
yarn ts-node scripts/publish-recovered-meeting.ts preview --account-id ACCOUNT --region REGION --table TABLE --bucket BUCKET --guild-id GUILD --meeting-key HISTORY_KEY --recovery-manifest-key MANIFEST_KEY --out NEW_PRIVATE_DIRECTORY
```

Omitting `preview` selects the same mode. Inspect `preview.md` and `preview.json` privately. They contain target links, before-images, exact proposed embeds, unchanged targets and blockers. Review language, version, uncertainty notices, pagination and every target. The displayed SHA-256 covers the stable serialized preview except its digest field. It is not the ordinary byte hash of `preview.json`. Do not edit the preview and approve a recalculated digest. Obtain a fresh preview after an intended source change.

The command reads only saved message IDs. It blocks missing posts, wrong server/channel/bot, webhooks, duplicate IDs, mixed summary/notes posts, unsupported component-v2 messages, unfamiliar footers/layouts, changed slot counts and Discord limits including unrelated embeds. It never searches for replacements or creates messages. The private preview explains blockers. Resolve the source or obtain a separately reviewed layout change before continuing.

## Apply the approved preview

After approval of the exact private preview:

```text
yarn ts-node scripts/publish-recovered-meeting.ts apply --preview PRIVATE_DIRECTORY/preview.json --expect-preview-sha256 APPROVED_PREVIEW_DIGEST
```

Apply/reconcile obtain the full scope from the saved preview. Additional account, region, guild, table, bucket or meeting overrides are invalid. The bot identity must match. Apply rechecks all targets and the stored version before its first write, then repeats checks immediately before remaining edits.

Apply stores an immutable preview and durable receipt under the manifest's recovery directory. Apply/reconcile acquire the shared per-meeting DynamoDB publication barrier before provider work, so initial publication, approved repair and automatic updates cannot independently own the same meeting. The conditional S3 claim and immutable receipt still identify this tool's approved run; the S3 claim alone is not the common barrier. Each message intent is durable before PATCH. The body contains only embeds and `allowed_mentions: { parse: [] }`. The command never POSTs or DELETEs, modifies stored meeting content/version, synchronizes Notion, calls an LLM or announces recovery.

Apply reads every edited post back. Success requires matching targets, preserved message fields and a final stored-version check. Each returned receipt gets a fresh private `apply-RUN_DIRECTORY/receipt.json` copy beside the preview. Keep it with the reviewed before-images. The authoritative durable receipt remains in S3 if a local copy fails.

## Reconcile interrupted or uncertain work

```text
yarn ts-node scripts/publish-recovered-meeting.ts reconcile --preview PRIVATE_DIRECTORY/preview.json --expect-preview-sha256 APPROVED_PREVIEW_DIGEST
```

Reconciliation reads Discord and may record observations in S3. It never edits messages. A timed-out PATCH that now matches can be verified. A mismatch or unreadable result stays uncertain, even if it resembles the before-image. Never automatically retry an uncertain PATCH; it may complete late.

Stop the exact previous process and independently establish that it exited before using this optional assertion:

```text
yarn ts-node scripts/publish-recovered-meeting.ts reconcile --preview PRIVATE_DIRECTORY/preview.json --expect-preview-sha256 APPROVED_PREVIEW_DIGEST --confirm-run-stopped EXACT_PRIOR_RUN_ID
```

The assertion applies only to reconcile and must match the receipt's exact run. It can close an abandoned running claim only when no submitted/uncertain requests remain. Elapsed time does not prove process termination. The assertion does not authorize retrying uncertainty. A verified rerun is read-only. A definitively failed or never-submitted target can be considered for a fresh reviewed preview after the prior run is terminal. Each returned reconciliation receipt gets a fresh private `reconcile-RUN_DIRECTORY/receipt.json` copy.

## Interpret results and rollback

| Exit | Meaning                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| 0    | Preview is ready, or apply/reconciliation is verified.                                                     |
| 1    | Blocked, running, failed, partial, uncertain, superseded or operational failure. Inspect private evidence. |
| 2    | Invalid arguments, saved preview/digest or stopped-run assertion.                                          |

Console output contains metadata only, never bodies, credentials or raw provider errors. On unexpected failure, inspect durable claim/receipt evidence through the approved private operations route before retrying. A local file failure can follow a successful provider write. Exit status alone does not establish the provider outcome.

Discord writes and DynamoDB reads cannot form one transaction. The last check-to-write race with a portal editor remains. Claims serialize this tool, not ordinary edits. Verification proves the reviewed version at that observation time. A newer version stops publication and may leave some posts verified and others untouched.

There is no automatic rollback. Before-images support a separate reviewed rollback decision with fresh current-state checks. Blind restoration can overwrite a newer edit. Production dry-runs/applies need separate operational authorization. Synthetic tests and merged source do not prove hosted publication. Keep live fixtures, IDs, payloads, receipts and acceptance evidence in the private operations repository.

## Routine later edits

Use the supported canonical action for intentional notes edits, imports, approved corrections and renames. These save durable update intent without requiring this exceptional recovery preview. Raw database changes do not automatically publish. A stored-only recovery hold stays held until an explicitly authorized publication action establishes eligibility. See [later intentional updates](../discord-delivery-outcomes.md#later-intentional-updates) for retry limits and index-before-code rollout.

## Mixed runtime canonical writer admission

Processing edits require a positive capability bound to the current recording
execution or personal processing claim. Feature-aware runtimes advertise
canonical writer capability version 1. Before acknowledging an edit, the
producer verifies that every current serving member advertises that capability
for its exact runtime identity. One transaction checks the serving generation
and complete membership, each runtime capability, the history ownership snapshot,
and the exact personal job claim when applicable, while saving content and
delivery intent together.

A retained pre-feature serving peer blocks processing edits until the rolling
upgrade replaces it. Missing, unknown, mismatched, or oversized capability
evidence returns the existing save conflict, so the user can retry after the
upgrade. Completed legacy rows remain editable when no original canonical
writer can still finalize them. Original owner and delivery holds remain in
place while work settles.

These rules qualify any generic old-image rollback advice. Once canonical
feature work has been admitted, use a feature-aware rollback target. Promoting a
pre-feature image is an incompatible downgrade and is not covered by the normal
compatible rollout guarantee. It requires separately verified safe quiescence
and ownership resolution, including cleanup of any owned acceptance fixtures
and fresh recording/job guards proving no feature work is at risk. Otherwise,
hold the rollback and preserve the workers and their outstanding work.
