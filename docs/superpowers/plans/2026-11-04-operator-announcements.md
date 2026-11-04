# Operator Announcements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator-only script that previews, then on confirmation sends, one approved announcement embed into each installed server's community updates channel (falling back to the notes channel, then the system channel), honouring a per-server opt-out and recording every send.

**Architecture:** Pure core (input parsing, embed rendering, permission math, channel resolution) with no I/O; thin I/O adapters (a REST-only Discord client, a DynamoDB delivery store, a server settings reader); a runner that composes them behind injected dependencies; and a `scripts/announce.ts` CLI in the existing preview-then-apply-by-digest pattern.

**Tech Stack:** TypeScript, Node 24, discord-api-types, `@aws-sdk/client-dynamodb` and `@aws-sdk/util-dynamodb`, zod, Jest (ts-jest), Terraform.

**Spec:** `docs/superpowers/specs/2026-11-04-operator-announcements-design.md`. Read it before starting any task.

## Global Constraints

- Public repository: no real server, channel, user, or message ids or names anywhere (code, tests, docs, commits). Test ids are obviously fake snowflakes such as `100000000000000001`.
- No test, CI job, or default code path calls the real Discord API or AWS. Every network edge is an injected `fetchImpl` or client.
- Every send body is `{ embeds: [embed], allowed_mentions: { parse: [] } }`, plus `content` only for an owner DM. The only DM is to the guild owner, only when the updates channel exists but is unpostable (operator decision, 2026-11-04). Never DM members.
- Required bot permissions on the target channel: View Channel (`1n << 10n`), Send Messages (`1n << 11n`), Embed Links (`1n << 14n`). Administrator (`1n << 3n`) grants all.
- Only channel types `0` (guild text) and `5` (guild announcement) qualify.
- Channel rule: a server with a usable community updates channel (present in the channel list, type 0 or 5) targets only that channel; if the bot cannot post there the decision is `owner_dm` with the missing permissions, never a member-visible fallback. A server without a usable updates channel tries `notes` then `system`.
- Owner DM content line, exactly: `Chronote could not post this notice in the community updates channel of ${escapeMarkdown(serverName)} because it is missing: ${missing.join(", ")}. Grant these to Chronote in that channel to receive future notices there.` with permission display names `View Channel`, `Send Messages`, `Embed Links`. `escapeMarkdown` from `@discordjs/formatters`.
- Closed owner DMs: Discord JSON error `code` 50007, or any 403 from opening or posting the DM, gives `owner_dms_closed`.
- Opt-out config key: `announcements.operatorNotices.enabled`, server scope only, default `true`, admin toggle. Opted out iff the stored server override value is `false` or `"false"`.
- Delivery table logical name `AnnouncementDeliveryTable`, partition key `announcementId` (S), sort key `guildId` (S).
- A post is marked `failed` only on a definite HTTP 4xx (including a 429 that persists past retry). A 5xx, timeout, abort or network error leaves the record `pending` (operator decision, 2026-11-04).
- `send` refuses when `process.stdin.isTTY` is not true, on digest mismatch, on a preview older than 60 minutes, and when the delivery table is missing.
- Minimum interval between posts: 1000 ms. 429 retry bound: 3 attempts, each waiting the server's retry-after (capped at 30 s).
- Every commit message starts with `[AGENT]` and ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before each commit: `yarn lint:check`, `yarn prettier:check` (or `yarn prettier --write` on touched files), `yarn tsc --noEmit -p tsconfig.json`, and the task's Jest files. Do not use `--no-verify`.
- Shell setup (this machine's nvm is mid-migration): prefix PATH with `C:\Users\steve\AppData\Local\Temp\claude\fc048479ae20cc9d\6bd3a63e-3710-4dd4-8628-23f6d9292780\scratchpad\toolbin` and `C:\ProgramData\nvm\v24.22.2` in every shell. Git Bash form: `export PATH="/c/Users/steve/AppData/Local/Temp/claude/fc048479ae20cc9d/6bd3a63e-3710-4dd4-8628-23f6d9292780/scratchpad/toolbin:/c/ProgramData/nvm/v24.22.2:$PATH"`.

## Review Focus

1. An announcement id reused with different text. A rerun must not silently report `already_sent` for a different message; preview warns whenever records already exist for the id. Test in Task 3.
2. The bot was removed from a server, or a channel was deleted, between preview and send. That server becomes a skip with a reason; the run continues. Test in Task 3.
3. Ctrl-C mid-send. The run stops before the next server, leaves records consistent, and still prints the summary. Test in Task 3 with an aborted `AbortSignal`.
4. `--guild-id` naming a server the bot is not in. Preview fails listing those ids rather than quietly targeting fewer servers. Test in Task 3.
5. A community updates channel id that points at a thread, forum, or voice channel, or a deleted channel. It counts as no updates channel and falls through to notes, never to an owner DM. Test in Task 1.

## File Structure

- `src/services/discordPermissionsService.ts` (modify): extract pure `computeChannelPermissions`.
- `src/services/announcements/announcementTypes.ts`: shared types for every task.
- `src/services/announcements/announcementInput.ts`: parse and validate a Markdown or JSON announcement.
- `src/services/announcements/announcementEmbed.ts`: render the embed and check limits.
- `src/services/announcements/announcementTargets.ts`: pure channel resolution for one server.
- `src/services/announcements/announcementDiscordClient.ts`: REST-only Discord adapter.
- `src/services/announcements/announcementDeliveryStore.ts`: DynamoDB delivery records.
- `src/services/announcements/announcementSettingsReader.ts`: opt-out and notes channel from config overrides.
- `src/services/announcements/announcementRunner.ts`: preview build, send loop, summary line.
- `scripts/announce.ts`: CLI.
- `src/config/keys.ts`, `src/config/registry.ts` (modify): the opt-out key.
- `_infra/config.tf` (modify): the delivery table. `scripts/init-dynamodb.js` (modify): local table.
- `docs/operations/operator-announcements.md`, `docs/operations/announcements/incident.md`, `docs/operations/announcements/incident-resolved.md`: runbook and templates.
- Tests under `test/services/announcements/` and `test/scripts/announce.test.ts`.

Tasks 1 and 2 are independent and can run in parallel in separate worktrees. Task 3 starts after both are merged into the lane branch.

---

### Task 1: Pure core (types, input, embed, permissions, target resolution)

**Files:**

- Create: `src/services/announcements/announcementTypes.ts`, `announcementInput.ts`, `announcementEmbed.ts`, `announcementTargets.ts`
- Modify: `src/services/discordPermissionsService.ts` (extract the overwrite math; existing exports keep identical behaviour)
- Test: `test/services/announcements/announcementInput.test.ts`, `announcementEmbed.test.ts`, `announcementTargets.test.ts`, `test/services/discordPermissionsCompute.test.ts`

**Interfaces:**

- Produces (in `announcementTypes.ts`):
  ```ts
  export type AnnouncementKind = "info" | "incident" | "resolved";
  export type AnnouncementField = { name: string; value: string; inline?: boolean };
  export type Announcement = { id: string; kind: AnnouncementKind; title: string; body: string; fields: AnnouncementField[] };
  export type AnnouncementEmbed = { title: string; description: string; color: number; fields?: AnnouncementField[]; footer: { text: string }; timestamp: string };
  export type ChannelSource = "public_updates" | "notes" | "system" | "owner_dm";
  export type RequiredPermissionName = "ViewChannel" | "SendMessages" | "EmbedLinks";
  export type CandidateRejection = { source: ChannelSource; channelId: string; problem: "missing" | "not_text" | "duplicate" | "missing_permissions"; missing?: RequiredPermissionName[] };
  export type GuildSnapshot = { guildId: string; guildName: string; ownerId: string; roles: { id: string; permissions?: string | null }[]; botRoleIds: string[]; publicUpdatesChannelId: string | null; systemChannelId: string | null; notesChannelId: string | null; channels: DiscordChannel[] };
  export type TargetDecision =
    | { kind: "target"; channelId: string; channelSource: Exclude<ChannelSource, "owner_dm">; rejected: CandidateRejection[] }
    | { kind: "owner_dm"; ownerId: string; guildName: string; updatesChannelId: string; missing: RequiredPermissionName[]; rejected: CandidateRejection[] }
    | { kind: "skip"; reason: "opted_out" | "no_channel" | "missing_permissions"; rejected: CandidateRejection[] };
  export class AnnouncementInputError extends Error { constructor(readonly problems: string[]) }
  ```
  `DiscordChannel` is the existing type from `src/repositories/types.ts`.
- Produces: `computeChannelPermissions(input: { guildId: string; memberId: string; roles: { id: string; permissions?: string | null }[]; memberRoleIds: string[]; overwrites: DiscordPermissionOverwrite[] }): bigint`, exported from `discordPermissionsService.ts`. Administrator returns every bit (`(1n << 64n) - 1n`).
- Produces: `parseAnnouncement(content: string, format: "markdown" | "json"): { announcement: Announcement; warnings: string[] }` (throws `AnnouncementInputError`).
- Produces: `renderAnnouncementEmbed(announcement: Announcement, now: Date): AnnouncementEmbed` (throws `AnnouncementInputError` when over limits).
- Produces: `resolveAnnouncementTarget(snapshot: GuildSnapshot, botUserId: string, optedOut: boolean): TargetDecision`.

- [ ] **Step 1: Write failing tests for `computeChannelPermissions`**

  Cases, each asserting with `&` against the bit constants: `@everyone` role only; member role adds a bit; channel `@everyone` overwrite deny removes it; role overwrite allow re-adds after `@everyone` deny; when two role overwrites conflict the allow wins (role overwrites are unioned: all role denies apply, then all role allows); member overwrite deny beats role allow; Administrator role returns all bits even with a deny overwrite. Add one test that the existing `ensureUserCanViewChannel` still returns the same result for a fixture used before the refactor (mock the cached readers as the existing tests do).

- [ ] **Step 2: Run them and confirm they fail**

  Run: `yarn jest test/services/discordPermissionsCompute.test.ts`. Expected: FAIL, `computeChannelPermissions` is not exported.

- [ ] **Step 3: Extract `computeChannelPermissions` and make `ensureUserHasChannelPermissions` call it**

  Move the base-plus-overwrites math out of `ensureUserHasChannelPermissions` unchanged. The async function keeps fetching and its log and 429 handling.

- [ ] **Step 4: Run the new test plus every existing test that imports `discordPermissionsService`** (`grep -rl discordPermissionsService test src`). Expected: PASS.

- [ ] **Step 5: Write failing tests for `parseAnnouncement`**

  - Markdown with front matter `id: incident-2026-11-04`, `kind: incident`, `title: Meetings not starting in some servers` and a body returns those values and `body` equal to the Markdown after the front matter, with HTML comments (`<!-- ... -->`) stripped and surrounding whitespace trimmed.
  - The equivalent JSON returns the same `Announcement`.
  - `id` not matching `/^[a-z0-9]+(-[a-z0-9]+)*$/`, unknown `kind`, empty title, empty body: each is an `AnnouncementInputError` naming the field.
  - A body containing `{{next_update}}` and `{{support_contact}}` throws with problems listing both placeholder names.
  - Each of `@everyone`, `@here`, `<@123>`, `<@!123>`, `<@&123>`, `<#123>` in title, body, or a field throws.
  - A run of 17 to 20 digits not inside a mention returns a warning containing "snowflake"; 16 digits returns none.
  - Unknown front matter keys throw (strict).

- [ ] **Step 6: Run and confirm failure**, then **implement `parseAnnouncement`**. Use the `yaml` package (a devDependency; scripts run under ts-node) for front matter; if lint rejects a devDependency import under `src/`, write a small strict `key: value` parser instead. Validate with zod.

- [ ] **Step 7: Write failing tests for `renderAnnouncementEmbed`**

  Title and description copied; `color` differs per kind; `timestamp` is `now.toISOString()`; footer text is exactly `Chronote operator notice. Server admins can turn these off in Chronote server settings.`; fields omitted when empty; a 4097-character body throws `AnnouncementInputError`; a total over 6000 characters throws. Reuse `validateLimits` from `src/services/discordEmbedLayout.ts` and convert its errors to `AnnouncementInputError`.

- [ ] **Step 8: Implement, run, pass.**

- [ ] **Step 9: Write failing tests for `resolveAnnouncementTarget`**

  Build snapshots with a helper in the test file. The bot has View, Send, and Embed in a role unless the case says otherwise.
  - `optedOut: true` returns skip `opted_out` and never inspects channels.
  - Public updates channel postable returns target `public_updates`.
  - No public updates channel, notes channel postable returns target `notes` with empty `rejected`.
  - Public updates channel denies Embed Links by overwrite, with a postable notes channel present, returns `owner_dm` with the snapshot's `ownerId` and `guildName`, `missing: ["EmbedLinks"]`, and never targets `notes`.
  - `optedOut: true` with an unpostable updates channel returns skip `opted_out`, not `owner_dm`.
  - Public updates id not in `channels` gives `missing`; type 11 (thread), 15 (forum), 2 (voice) give `not_text`; in those cases the server counts as having no usable updates channel and falls through to `notes`. (Review Focus 5.)
  - System channel id equal to the notes channel id gives `duplicate` for the second occurrence.
  - All three null returns skip `no_channel`.
  - No updates channel, notes and system both present but unpostable returns skip `missing_permissions` with two rejections listing missing permissions in the order View, Send, Embed.
  - Administrator role makes an overwrite-denied channel postable.

- [ ] **Step 10: Implement, run all Task 1 tests, pass.**

- [ ] **Step 11: Commit**

  ```bash
  git add src/services/announcements src/services/discordPermissionsService.ts test/services/announcements test/services/discordPermissionsCompute.test.ts
  git commit -m "[AGENT] Announcements: pure input, embed and channel resolution"
  ```

---

### Task 2: I/O adapters, opt-out setting, table

**Files:**

- Create: `src/services/announcements/announcementDiscordClient.ts`, `announcementDeliveryStore.ts`, `announcementSettingsReader.ts`
- Modify: `src/config/keys.ts`, `src/config/registry.ts`, `_infra/config.tf`, `scripts/init-dynamodb.js`, `apps/docs-site/docs/admin/setup-and-access.md` (one line about the toggle), `AGENTS.md` data model list (one line for the table)
- Test: `test/services/announcements/announcementDiscordClient.test.ts`, `announcementDeliveryStore.test.ts`, `announcementSettingsReader.test.ts`, plus extend the existing registry test if one asserts the key list

**Interfaces:**

- Consumes: `DiscordChannel` from `src/repositories/types.ts`; `DiscordMessageHttpError` from `src/services/discordMessageEditor.ts`. Task 1's `AnnouncementEmbed` and `ChannelSource` types: if Task 1 has not merged yet, declare them in `announcementTypes.ts` exactly as Task 1's Interfaces block states and the merge will reconcile identical text.
- Produces:

  ```ts
  export type AnnouncementDiscordClient = {
    getBotUserId(): Promise<string>;
    listBotGuildIds(): Promise<string[]>; // GET /users/@me/guilds?limit=200&after=<last id>, until a page has < 200
    getGuild(guildId: string): Promise<{
      id: string;
      name: string;
      ownerId: string;
      roles: { id: string; permissions?: string | null }[];
      publicUpdatesChannelId: string | null;
      systemChannelId: string | null;
    }>;
    listGuildChannels(guildId: string): Promise<DiscordChannel[]>;
    getMemberRoleIds(guildId: string, userId: string): Promise<string[]>;
    openDmChannel(userId: string): Promise<string>; // POST /users/@me/channels { recipient_id }, returns channel id
    createMessage(
      channelId: string,
      embed: AnnouncementEmbed,
      options?: { content?: string; signal?: AbortSignal },
    ): Promise<{ id: string }>;
  };
  export function createAnnouncementDiscordClient(options: {
    token: string;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  }): AnnouncementDiscordClient;

  export type DeliveryStatus = "pending" | "sent" | "failed";
  export type DeliveryRecord = {
    announcementId: string;
    guildId: string;
    channelId: string;
    channelSource: ChannelSource;
    status: DeliveryStatus;
    messageId?: string;
    reason?: string;
    previewSha256: string;
    createdAt: string;
    updatedAt: string;
  };
  export type AnnouncementDeliveryStore = {
    assertTableExists(): Promise<void>; // throws Error whose message names the Terraform apply
    listForAnnouncement(announcementId: string): Promise<DeliveryRecord[]>; // Query, paginated; ResourceNotFoundException becomes DeliveryTableMissingError
    claimPending(
      record: Omit<
        DeliveryRecord,
        "status" | "messageId" | "reason" | "updatedAt"
      >,
      options: { replaceFailed: boolean },
    ): Promise<"claimed" | "exists">;
    markSent(
      announcementId: string,
      guildId: string,
      messageId: string,
      now: Date,
    ): Promise<void>;
    markFailed(
      announcementId: string,
      guildId: string,
      reason: string,
      now: Date,
    ): Promise<void>;
  };
  export class DeliveryTableMissingError extends Error {}
  export function createAnnouncementDeliveryStore(options: {
    dynamo: DynamoDBClient;
    tableName: string;
  }): AnnouncementDeliveryStore;

  export type GuildAnnouncementSettings = {
    optedOut: boolean;
    notesChannelId: string | null;
  };
  export function createAnnouncementSettingsReader(options: {
    dynamo: DynamoDBClient;
    tableName: string;
  }): { read(guildId: string): Promise<GuildAnnouncementSettings> };
  ```

- [ ] **Step 1: Write failing tests for the Discord client** with a fake `fetchImpl` recording requests.
  - Every request goes to `https://discord.com/api/v10/...` with `Authorization: Bot <token>` and `redirect: "error"`, and a 15 s timeout signal.
  - `listBotGuildIds` makes a second call with `after=` the last id of a full 200-item page and stops on a short page.
  - `createMessage` sends exactly `{ embeds: [embed], allowed_mentions: { parse: [] } }`, and adds `content` only when given.
  - `openDmChannel` POSTs `{ recipient_id }` to `/users/@me/channels` and returns the channel id.
  - A 403 whose JSON body has `code: 50007` throws `DiscordMessageHttpError` with status 403; the error exposes the Discord error code (add an optional `discordCode` property or a sibling error class, keeping existing callers unchanged).
  - A 429 with `Retry-After: 2` calls `sleep(2000)` and retries; three consecutive 429s throw `DiscordMessageHttpError` with status 429. A retry-after of 120 is capped at `sleep(30000)`.
  - 403 throws `DiscordMessageHttpError` status 403 without retry. A fetch rejection propagates unchanged (the runner treats it as ambiguous).
  - Snowflake-shaped ids are validated before building a URL; a bad id throws without calling fetch.

- [ ] **Step 2: Confirm failure, implement, pass.**

- [ ] **Step 3: Write failing tests for the delivery store** with a fake `DynamoDBClient` whose `send` captures commands (assert on `command.input`).
  - `claimPending` issues `PutItem` with `ConditionExpression` `attribute_not_exists(announcementId)` when `replaceFailed` is false, and `attribute_not_exists(announcementId) OR #status = :failed` when true; a `ConditionalCheckFailedException` returns `"exists"`; other errors propagate.
  - `markSent` and `markFailed` use `UpdateItem` conditioned on `#status = :pending` and set `updatedAt`.
  - `listForAnnouncement` follows `LastEvaluatedKey`.
  - `assertTableExists` maps `ResourceNotFoundException` from `DescribeTable` to an error whose message contains `apply the Terraform change`.

- [ ] **Step 4: Confirm failure, implement, pass.**

- [ ] **Step 5: Write failing tests for the settings reader.** One `Query` on `scopeId = server#<guildId>`. Value `false` or `"false"` for `announcements.operatorNotices.enabled` gives `optedOut: true`; absent, `true`, or anything else gives `false`. A snowflake string under `notes.channelId` gives `notesChannelId`; absent or malformed gives `null`. Confirm the stored shape by reading how `setConfigOverrideForScope` writes booleans before writing assertions.

- [ ] **Step 6: Confirm failure, implement, pass.**

- [ ] **Step 7: Add the config key and registry entry.** `CONFIG_KEYS.announcements.operatorNoticesEnabled = "announcements.operatorNotices.enabled"`. Registry entry modelled on `meetings.artifacts.transcriptAccess.enabled`: label `Chronote operator notices`, description `Let Chronote post occasional service notices, such as incident updates, in this server.`, `valueType: "boolean"`, `defaultValue: true`, server scope `scope(true, false, "admin", "toggle")`, `ui: { type: "toggle" }`, a sensible existing category and group. Run the registry and config tests (`grep -rl "registry" test | head`) and update any snapshot or key-list assertion.

- [ ] **Step 8: Add the table.** In `_infra/config.tf`, an `aws_dynamodb_table` `announcement_delivery_table` named `"${local.name_prefix}-AnnouncementDeliveryTable"`, copying `config_overrides_table` (PAY_PER_REQUEST, PITR, `aws_kms_key.app_general`, tags) with keys `announcementId` and `guildId`. Search `_infra/` for lists that enumerate every table (backup selections, outputs, alarms) and add it only where the other tables all appear. No ECS task policy change. Add the local definition to `scripts/init-dynamodb.js` next to `ConfigOverridesTable`. Run `terraform fmt -check _infra` if Terraform is installed; otherwise state that it was not run.

- [ ] **Step 9: Docs lines.** One line in the admin docs page under the server settings it already describes. One line in `AGENTS.md` data model highlights: `AnnouncementDeliveryTable records operator announcement sends per announcement and server (pending, sent, failed) for idempotent reruns; written only by scripts/announce.ts.`

- [ ] **Step 10: Commit**

  ```bash
  git add src/services/announcements src/config _infra/config.tf scripts/init-dynamodb.js apps/docs-site AGENTS.md test/services/announcements
  git commit -m "[AGENT] Announcements: Discord client, delivery store, opt-out setting and table"
  ```

---

### Task 3: Runner, CLI, templates, runbook

**Files:**

- Create: `src/services/announcements/announcementRunner.ts`, `scripts/announce.ts`, `docs/operations/operator-announcements.md`, `docs/operations/announcements/incident.md`, `docs/operations/announcements/incident-resolved.md`
- Test: `test/services/announcements/announcementRunner.test.ts`, `test/scripts/announce.test.ts`, `test/services/announcements/announcementTemplates.test.ts`

**Interfaces:**

- Consumes: everything Tasks 1 and 2 produce; `privateDirectory` and `privateFile` from `scripts/publish-recovered-meeting.ts` (move them to `scripts/privateOutput.ts` and re-export from the old location if importing a script module from a script is awkward); `stablePublicationJson` and the digest approach from `src/services/recoveryDiscordPublication*` for the preview digest.
- Produces:

  ```ts
  export type AnnouncementScope = {
    accountId: string;
    region: string;
    configTable: string;
    deliveryTable: string;
  };
  export type PreviewEntry = {
    guildId: string;
    decision:
      | TargetDecision
      | {
          kind: "skip";
          reason: "already_sent" | "pending_unknown" | "discord_error";
          detail?: string;
        };
  };
  export type AnnouncementPreview = {
    version: 1;
    createdAt: string;
    scope: AnnouncementScope;
    botUserId: string;
    retryFailed: boolean;
    announcement: Announcement;
    embed: AnnouncementEmbed;
    warnings: string[];
    entries: PreviewEntry[];
    sha256: string;
  };
  export type RunnerDeps = {
    discord: AnnouncementDiscordClient;
    store: AnnouncementDeliveryStore;
    settings: { read(guildId: string): Promise<GuildAnnouncementSettings> };
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
  };
  export async function buildAnnouncementPreview(
    deps: RunnerDeps,
    input: {
      scope: AnnouncementScope;
      announcement: Announcement;
      warnings: string[];
      guildIds?: string[];
      retryFailed: boolean;
    },
  ): Promise<AnnouncementPreview>;
  export function previewDigest(
    preview: Omit<AnnouncementPreview, "sha256">,
  ): string;
  export type SendCounts = {
    sent: number;
    ownerDm: number;
    failed: number;
    unknown: number;
    skipped: Record<string, number>;
  };
  export async function sendAnnouncementPreview(
    deps: RunnerDeps,
    preview: AnnouncementPreview,
    options: { signal?: AbortSignal; onEntry?: (line: string) => void },
  ): Promise<SendCounts>;
  export function summaryLine(
    announcementId: string,
    mode: "preview" | "send",
    counts: SendCounts,
  ): string;
  ```

- [ ] **Step 1: Write failing runner tests** with in-memory fakes of the three adapters.
  - Preview: builds a `GuildSnapshot` per server from `getGuild`, `listGuildChannels`, `getMemberRoleIds`, and settings; decisions match `resolveAnnouncementTarget`. Never calls `createMessage`, `claimPending`, `markSent`, or `markFailed`.
  - Preview: existing `sent` records give `already_sent`, `pending` give `pending_unknown`, `failed` give `already_sent` unless `retryFailed`, in which case they are resolved normally.
  - Preview warns when any delivery record already exists for this announcement id: `announcement id <id> already has <n> delivery records from an earlier preview; those servers will not receive this version. Use a new id for new text.` (Review Focus 1.)
  - Preview with a missing delivery table (`DeliveryTableMissingError` from `listForAnnouncement`) treats it as no records and adds the warning `delivery table not found; send will refuse until the Terraform change is applied`.
  - A `getGuild` 403 or 404 gives `discord_error` with the status in `detail` and the run continues.
  - `guildIds` containing an id not in `listBotGuildIds` throws listing the unknown ids. (Review Focus 4.)
  - `previewDigest` is stable under key order and changes when any entry changes.
  - Send: for each `target` entry, in order, re-reads settings and re-checks the previewed channel only (fresh snapshot, but resolution restricted to the previewed channel id); opted out or now unpostable gives a skip and no claim. Then `claimPending` → `createMessage` → `markSent`. `"exists"` from the claim gives `already_sent`.
  - Send: a 4xx `DiscordMessageHttpError` calls `markFailed` with `discord_<status>`; a fetch rejection, 5xx, or abort leaves the record pending and counts `unknown`.
  - Send `owner_dm`: re-reads the opt-out (opted out gives skip, no DM); claims with `channelSource: "owner_dm"` and `channelId` set to the opened DM channel id (open the DM channel before the claim; a 403 there gives `owner_dms_closed` and a `failed` record claimed with the owner id as `channelId`); posts the embed with the exact content line from Global Constraints; a 403 or code 50007 on the post gives `markFailed(..., "owner_dms_closed")` and counts skipped `owner_dms_closed`, not `failed`.
  - Send `owner_dm` is never redirected to a channel even if the updates channel became postable since preview.
  - Send: the bot removed between preview and send (reads 403/404) gives a skip, run continues. (Review Focus 2.)
  - Send: `sleep(1000)` between consecutive posts, not before the first or after the last.
  - Send: an aborted `signal` before entry two stops the loop, returns counts with entry one sent, never claims entry two. (Review Focus 3.)
  - `summaryLine` for preview prints `would_send=` in place of `sent=`, and prints `owner_dm=` right after `sent=`, lists skipped reasons in the fixed order `opted_out no_channel missing_permissions owner_dms_closed discord_error already_sent pending_unknown`, then `failed=`, then `unknown=`. Example expectation: `announcement incident-2026-11-04: sent=2 owner_dm=1 skipped=3 (opted_out=1 no_channel=0 missing_permissions=1 owner_dms_closed=0 discord_error=0 already_sent=1 pending_unknown=0) failed=0 unknown=0`.

- [ ] **Step 2: Confirm failure, implement `announcementRunner.ts`, pass.**

- [ ] **Step 3: Write failing CLI tests** for exported `parseAnnounceArgs(args: string[])` and `runAnnounce(args: string[], deps)` where `deps` injects `connect(scope) => RunnerDeps`, `isInteractive: () => boolean`, `report: (line: string) => void`, and the file system root.
  - Mode defaults to `preview`. Preview requires `--announcement`, `--account-id`, `--region`, `--config-table`, `--delivery-table`, `--out`; accepts repeatable `--guild-id` and boolean `--retry-failed`. Format chosen by extension `.md` or `.json`; anything else is invalid.
  - `send` accepts only `--preview` and `--expect-preview-sha256`; any scope flag is invalid.
  - Duplicate flags and unknown flags are invalid (follow `parseRecoveryDiscordPublicationArgs`).
  - Preview writes `preview.json` and `preview.md` into a new private directory, refuses an existing path, and reports the digest and the summary line.
  - Send refuses when `isInteractive()` is false, when the recomputed digest differs from both the file's `sha256` and the flag, when `createdAt` is more than 60 minutes before `now`, and when `store.assertTableExists()` throws; in each case `createMessage` is never called.
  - Send reports one line per entry through `onEntry` and the summary line last.
  - `main()` reads `DISCORD_BOT_TOKEN` from the environment only, verifies the STS caller account equals `--account-id` before any read, builds AWS clients with the explicit region and `maxAttempts: 1`, and wires `SIGINT` to the abort signal. `main` itself is not unit tested; keep it thin.

- [ ] **Step 4: Confirm failure, implement `scripts/announce.ts`, pass.** `preview.md` holds: the announcement id and kind, the rendered embed as plain text (title, description, fields, footer), warnings, then a table of server id, decision, channel source, channel id, and rejected candidates. It is private output, so ids are fine there.

- [ ] **Step 5: Write the templates.** `incident.md` front matter `id: incident-{{date}}`, `kind: incident`, `title: {{symptom}}`. Body lines, in order: `**Status:** {{status}}`, `**What you may see:** {{what_users_see}}`, `**Who is affected:** {{who_is_affected}}`, `**Your data:** {{data_statement}}`, `**What we are doing:** {{what_we_are_doing}}`, `**Next update:** {{next_update_time_with_timezone}}`, `**If you are blocked now:** {{how_to_get_help}}`. `incident-resolved.md` front matter `id: resolved-{{date}}`, `kind: resolved`, `title: Resolved: {{symptom}}`; body: `**Fixed:** {{what_was_fixed_and_when}}`, `**Anything you need to do:** {{action_needed_or_none}}`, `**Questions:** {{how_to_reach_us}}`. Each starts with an HTML comment block holding these rules verbatim:

  ```text
  House rules for public notices:
  - The next update is a clock time with timezone. "Tonight" is not a time.
  - No operational figures: no server counts, share of users, costs, ids, or internal names.
  - Plain and professional. State what happened and what is being done. One apology at most.
  - Say recordings and notes are safe only when that is verified.
  - BASIC approves the final text and runs the send.
  ```

- [ ] **Step 6: Template test.** `announcementTemplates.test.ts` reads both files, asserts `parseAnnouncement` throws listing exactly the placeholder names above, and that replacing every `{{...}}` with `x` (and `{{date}}` with `2026-11-04`) parses and renders within limits.

- [ ] **Step 7: Write the runbook** `docs/operations/operator-announcements.md`, modelled on `docs/operations/recovery-discord-publication.md`: purpose; prerequisites (Terraform table applied, deploy carrying the toggle live); credentials (`AWS_PROFILE`, `DISCORD_BOT_TOKEN` from the authorized secret route, never in arguments); least-privilege permissions (`sts:GetCallerIdentity`, `dynamodb:Query` on the config table, `dynamodb:DescribeTable`, `Query`, `PutItem`, `UpdateItem` on the delivery table, KMS for `app_general`); fill a template; preview with placeholder commands; review `preview.md`; canary send with `--guild-id` for the operator's own server; full send; reading the summary; handling `pending_unknown` and `unknown` by checking the channel by hand; `--retry-failed`. All names placeholders. No agent runs `send`.

- [ ] **Step 8: Run the full local gate on the lane branch.** `yarn build`, `yarn lint:check`, `yarn prettier:check`, `yarn markdownlint:check`, `yarn jest` (full), and `yarn check:quality` with `QUALITY_RATCHET_HOME=D:\bench\quality-ratchet`. Expected: all exit 0. Read each exit status, not the prose.

- [ ] **Step 9: Commit**

  ```bash
  git add src/services/announcements scripts/announce.ts scripts/privateOutput.ts scripts/publish-recovered-meeting.ts docs/operations test/services/announcements test/scripts/announce.test.ts
  git commit -m "[AGENT] Announcements: preview and send runner, CLI, templates and runbook"
  ```
