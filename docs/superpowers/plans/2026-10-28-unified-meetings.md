# Unified meetings implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved single Meetings page without losing accessible recordings, weakening permissions or breaking saved links.

**Architecture:** Extend the shared discovery service behind `meetings.myList`, using canonical read-time authorization and existing DynamoDB tables. Route both library entries into one URL-driven page, visible source navigation and the existing meeting-detail drawer. Add guild-share discovery pointers and a separately authorized historical metadata repair.

**Tech stack:** Existing Node.js 24.22.1, TypeScript, React 19, Mantine, TanStack Router, tRPC/Zod, AWS SDK, Jest, Storybook and Playwright. No new dependencies or infrastructure resources.

**Spec:** [Approved unified meetings design](../specs/2026-10-28-unified-meetings-design.md). Approved by BASIC on October 28, 2026 after independent builder review. This plan needs review before implementation; it authorizes no live repair, deployment or billing action.

## Delivery and boundaries

The approved prototype decides the layout. The spec carries the inspected [Grain Meetings reference](https://mobbin.com/flows/a880e9c0-e3cb-4652-8fe2-f6e2c2610716), which supports one recognizable destination and scoped empty states. It does not establish permissions, persistence or commercial results.

Work in dependency order. Each task ends with a focused test run and a scoped commit. Preserve the throwaway prototype and its live preview while building the real page. Before implementation, use the worktree skill to reconcile the design commits with current master in an isolated checkout; do not copy unrelated migration work or reset another owner's checkout.

Source implementation can be reviewed independently of historical production pointer repair. Source merge alone does not establish complete discovery for older guild shares. Production inventory/repair and deployment retain their existing approval requirements, and Claude remains the deployment owner.

## Global constraints

- One Meetings destination. Default all accessible, all time, non-archived; attendance unchecked.
- Visible server icons/names on the left, mobile two-column source group, checkbox "Only meetings I attended."
- Preserve upload, personal settings, Ask, billing, server settings, existing filters and detail actions.
- Personal recordings includes accessible owned and shared personal records. A server source contains that server's recordings, not personal records merely shared with it.
- Attendance uses participant IDs or legacy attendee mentions, not ownership, creator/trigger IDs or share recipients alone.
- Authorize each canonical record before projecting client-visible data. Preserve attendee override and personal-grant policy; restricted MCP tokens never gain attendee bypass.
- Unknown permissions or unfinished discovery cannot become a successful empty-library response.
- Keep existing MCP defaults, restrictions and legacy cursor compatibility. The portal explicitly requests accessible mode and its stricter attendance filter.
- Search is "Search loaded meetings." Do not add exhaustive full-history text search or exact per-source total scans.
- Counts describe loaded authorized rows; omit prototype source total badges.
- No new analytics properties/events. No Terraform, new DynamoDB table/GSI, paid provider requests, production inventory/write or live replay.
- Use existing artifact/action authorization, mention resolution and existing permission-cache lifetime. No immediate-revocation guarantee beyond those caches.
- Production stories and route snapshots, actual scroll assertions and VLM review are required before UI completion. Preserve `react-docgen-typescript`.

## Review focus

1. A stale guild-share pointer or concurrent revocation must never disclose a personal recording. Pin in Tasks 1, 2 and 6.
2. Owner/share index entries must not imply attendance; former-member attendee rights must not be lost. Pin in Task 2.
3. Denied rows, equal timestamps and empty intermediate pages must not skip accessible older results or trigger onboarding. Pin in Tasks 1, 2 and 5.
4. Account/source changes and delayed responses must not display another user's or source's cached rows. Pin in Tasks 4 and 5.
5. Legacy links and ordinary portal scrolling must work outside screenshot mode, including mobile and retained-access servers. Pin in Tasks 3, 5 and 7.

## File ownership

| Task | Files and responsibility                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `src/types/meetingBrowse.ts`, `src/types/db.ts`, `src/db.ts`, both meeting repositories, `meetingUserIndexService.ts`, `utils/meetingUserIndex.ts`: source contracts, guild-share pointers and bounded storage pages                |
| 2    | `mcpMeetingService.ts`, new `meetingBrowseCursor.ts`, `trpc/routers/meetings.ts`: shared discovery, access, attendance and continuation                                                                                             |
| 3    | New frontend `meetingBrowseSearch.ts`, `router.tsx`, `utils/portalLinks.ts`, shared `utils/portalLinks.ts`, `PortalServerLayout.tsx`: canonical URL and legacy adapters                                                             |
| 4    | `SiteNavbar.tsx`, new `MeetingSources.tsx` and CSS, `PortalLayout.tsx`, `GuildContext.tsx`: visible source selection and management context                                                                                         |
| 5    | `MyMeetings.tsx`, new `UnifiedMeetingsPage.tsx` and stories, a route-scoped browse provider, existing auth/query client and library components: one connected page, session cache isolation and removal of superseded list behavior |
| 6    | New `meetingShareIndexRepairService.ts`, `scripts/repair-meeting-share-index.ts`, DB metadata-only reads and repair tests: bounded dry-run/apply tool, not a live run                                                               |
| 7    | Production stories, `test/e2e/unifiedMeetings.spec.ts`, `unifiedMeetings.visual.spec.ts`, fixtures, public docs: responsive acceptance and documentation                                                                            |

Repository-relative filenames in the task details below are the authoritative paths. Do not introduce a second permission implementation, duplicate drawer, new global UI store or new query cache.

## Task 1: Add safe discovery pointers and paged storage reads

**Modify:** `src/types/db.ts`, `src/utils/meetingUserIndex.ts`, `src/services/meetingUserIndexService.ts`, `src/repositories/meetingUserIndexRepository.ts`, `src/repositories/meetingHistoryRepository.ts`, `src/db.ts`.

**Create:** `src/types/meetingBrowse.ts`, `test/dbMeetingUserIndexPage.test.ts`.

**Tests:** `src/utils/__tests__/meetingUserIndex.test.ts`, `src/services/__tests__/meetingUserIndexService.test.ts`, `test/dbMeetingHistoryRange.test.ts`, new DB page test.

**Interfaces produced:** Export the types below from `src/types/meetingBrowse.ts` and the functions from `src/utils/meetingUserIndex.ts`.

```ts
type MeetingBrowseScope =
  { kind: "all" } | { kind: "personal" } | { kind: "guild"; serverId: string };
type MeetingBrowseFilters = {
  scope: MeetingBrowseScope;
  attendedOnly: boolean;
  channelId?: string;
};
type GuildShareIndexMetadata = Pick<
  MeetingHistory,
  | "guildId"
  | "channelId_timestamp"
  | "meetingId"
  | "timestamp"
  | "ownershipScope"
  | "ownerUserId"
  | "accessGrants"
>;
function buildGuildShareIndexPrincipal(guildId: string): string;
function buildGuildShareIndexRecords(
  meeting: GuildShareIndexMetadata,
): MeetingUserIndexRecord[];
function isRecordedMeetingAttendee(
  meeting: Pick<MeetingHistory, "participants" | "attendees">,
  userId: string,
): boolean;
```

Add `accessReason: "guild_share"` to index records. Preserve existing raw-user keys. Reserve `GUILD_SHARE#${encodeURIComponent(guildId)}` for guild-recipient partitions, and reject this reserved namespace in raw-user index reads/writes. Ordinary non-snowflake fixture IDs remain supported. Reuse the existing timestamp/guild/record sort key and add one pointer per active personal guild grant, not one copy per guild member.

Add repository methods `listByGuildTimestampPage` and `listByPrincipalTimestampPage`. Each accepts `{ startTimestamp, endTimestamp, limit, cursor, signal }` plus its guild/principal argument and returns `{ items: Array<{ record, cursorAfter }>, nextCursor }`. Each item carries the exclusive storage checkpoint immediately after that raw record, so the collector can resume after a consumed prefix without skipping the unused tail of a fetched page. New page methods return raw candidates, including cancelled records for the collector to discard after advancing progress; existing array methods keep their filtering behavior. The DB implementation performs one Query call with `Limit` and `ExclusiveStartKey`; `nextCursor` represents `LastEvaluatedKey`, even when filtering yields zero items. Keep the old array-returning repository methods for existing callers. Mirror page semantics in mock repositories.

- [ ] Write failing tests for namespace collision rejection; owner/direct-user pointers unchanged; one guild pointer per distinct grant; grant replacement removes old guild pointers; index write rejection remains observable; attendee matching excludes owner/trigger/share-only IDs.
- [ ] Add storage tests proving a one-call page preserves continuation on empty results, applies the requested limit and resumes without dropping equal-timestamp records. Mock AWS boundaries, not the page function.
- [ ] Run `yarn jest --runInBand --coverage=false --runTestsByPath src/utils/__tests__/meetingUserIndex.test.ts src/services/__tests__/meetingUserIndexService.test.ts test/dbMeetingHistoryRange.test.ts test/dbMeetingUserIndexPage.test.ts`. Confirm the new assertions fail for the missing behavior.
- [ ] Implement the interfaces and page adapters above. Keep grant mutation's existing replace-index path as the single pointer lifecycle. Do not mask a failed pointer write as complete discovery. Add a synthetic revoke/write race proving any remaining stale pointer is denied by canonical access in Task 2.
- [ ] Re-run the focused command and commit only this task's files after it passes.

## Task 2: Make shared discovery complete, authorized and resumable

**Modify:** `src/services/mcpMeetingService.ts`, `src/trpc/routers/meetings.ts`, `src/db.ts` for short-lived cursor-state reads/writes in the existing SessionTable.

**Create:** `src/services/meetingBrowseCursor.ts`, `src/services/__tests__/meetingBrowseCursor.test.ts`.

**Tests:** `src/services/__tests__/mcpMeetingService.test.ts`, `test/services/mcpMeetingService.test.ts`, `src/services/__tests__/meetingAccessService.test.ts`, `test/trpc/meetingsRouter.test.ts`.

**Consumes:** Task 1 scope/filter types, pointer keys, attendee predicate and paged repository reads; existing `checkUserMeetingAccess`, `ensureMcpMeetingAccess`, artifact gates and mention-aware summary projection.

**Produces:** Extend `ListMcpMyMeetingsInput` and `meetings.myList` with optional `browse: MeetingBrowseFilters`. Portal calls supply `mode: "accessible"`, `range: "all"`, `limit: 25` and `browse`. Requests without `browse` retain existing MCP attended/range defaults and restriction semantics. Keep existing `meetings`, `range`, `mode`, `hasMore`, `nextCursor` response fields and add `discoveryComplete: boolean`. Export `MeetingBrowsePage = Awaited<ReturnType<typeof listMcpMyMeetings>>` for type-only consumers.

Use one internal paged candidate collector for new portal browsing and legacy discovery; preserve their different attendance/default contracts at the boundary. Collect user-index records, permitted guild histories and membership-verified guild-share pointers as appropriate to scope. Resolve canonical records before authorizing or displaying them. Personal records bypass synthetic guild membership, while actual guild records preserve attendee override and restricted-token checks. A selected previous-server scope can collect authorized indexed history even without current membership.

**Continuation contract:** Export asynchronous `encodeMeetingBrowseCursor(payload: MeetingBrowseCursorPayload): Promise<string>` and `decodeMeetingBrowseCursor(token: string, actorId: string, filters: MeetingBrowseFilters, now?: number): Promise<MeetingBrowseCursorPayload>` from the new codec. The payload contains version 2, actor ID, normalized-filter fingerprint, fixed start/end timestamps, expiry, per-source exclusive checkpoints/exhaustion, emitted timestamp/identity watermark and pending lookup keys. Define and validate this type in the codec; source kind is guild, user or guild_share. It never contains notes/transcripts.

Keep the full progress payload server-side in the existing SessionTable under an immutable `MEETING_BROWSE_CURSOR#<random UUID>` record, with the existing `expiresAt` TTL and a one-hour logical expiry checked on reads. Add dedicated `putMeetingBrowseCursorState`/`getMeetingBrowseCursorState` helpers in `db.ts`, without mixing cursor data into actual login sessions or dictionary records. Persist new snapshots, rather than mutating a token's progress, so retries and browser Back remain safe. This avoids putting large per-source progress into a GET URL.

Return only a compact version-2 signed reference using the existing `signConsentToken`/`readConsentToken` helper and a domain-specific key derived from `config.server.sessionSecret`. The reference contains its random ID, purpose, actor/filter binding and expiry, not internal source/record keys; those remain in the existing encrypted SessionTable. No new encryption codec or Notion dependency is needed. Check actor, purpose, expiry and every normalized server-side filter against the stored snapshot; missing/expired state returns a recoverable invalid-cursor error. Re-authorize buffered records after lookup. Keep version-1 legacy cursors working for existing clients; never accept one as new portal browse state. These ordinary ephemeral application records require no new table, GSI, IAM grant or environment secret.

Pin a request work budget of 1,000 examined candidates, storage page limit 100 and at most four concurrent storage reads. Exhausting the work budget returns a continuation, potentially with zero rows, and `discoveryComplete: false`. Sort by timestamp descending then canonical guild/record identity descending. Merge only resolved source frontiers. Advance each source to its last consumed item checkpoint, not its fetched page end while unused rows remain. For a timestamp tie spanning storage pages, finish that timestamp's candidate comparison before advancing the visible watermark; carry bounded best-page keys and source progress, not unchecked rows. A resumed buffered key is fetched and authorized again. If a tie exceeds a request budget, return continuation rather than emitting a falsely ordered page or dropping the remainder. Source/index dependency errors fail the page explicitly instead of becoming exhausted sources. If the best page is emitted before an oversized tie is exhausted for later pages, retain its emitted identity watermark and rescan that tie for the next bounded best page; do not discard lower-ranked records when bounding the cursor buffer.

- [ ] Pin the sparse-page regression with these assertions after arranging 1,001 denied records followed by one allowed record, using the existing service test fixtures:

  ```ts
  expect(first.meetings).toEqual([]);
  expect(first.nextCursor).not.toBeNull();
  expect(first.discoveryComplete).toBe(false);
  expect(second.meetings.map((row) => row.meetingId)).toEqual([
    "allowed-older",
  ]);
  ```

- [ ] Add failing cases for accessible non-attended guild rows, denied channels, attendee override on/off, retained former-member entitlement, unknown Discord permissions, owner without real-guild membership, active/revoked user and guild shares and stale/deleted index pointers. Assert no forbidden title/summary/artifact field is returned.
- [ ] Assert the portal's attendance intersection rejects creator/owner/trigger/share-only matches and accepts participant IDs/legacy attendee mentions. Keep legacy MCP attended tests unchanged, including restricted-token denial.
- [ ] Add paging cases with 1,001 denied candidates before an allowed row, a timestamp tie crossing multiple storage pages, an unused storage-page tail after the visible page fills, an empty intermediate page, overlapping sources, filter/user cursor mismatch, tampering, missing/expired cursor state, actor/filter mismatch, compact token length with 100 source checkpoints, retrying an immutable snapshot, and revocation of a buffered result. Assert bounded calls, no duplicates/skips and no false exhaustion.
- [ ] Add router cases rejecting incompatible `browse`/mode/server filter combinations and confirming actor identity comes from `ctx.user`. Assert artifact-off flags and detail/action checks remain separate from list access.
- [ ] Run `yarn jest --runInBand --coverage=false --runTestsByPath src/services/__tests__/mcpMeetingService.test.ts test/services/mcpMeetingService.test.ts src/services/__tests__/meetingAccessService.test.ts src/services/__tests__/meetingBrowseCursor.test.ts test/trpc/meetingsRouter.test.ts`; verify the new tests fail, implement the shared collector/adapter and cursor contract, then rerun until they pass.
- [ ] Commit this task's files. Do not remove legacy API defaults or widen MCP tool input schemas as part of the portal change.

## Task 3: Define canonical URL state and preserve old links

**Create:** `src/frontend/utils/meetingBrowseSearch.ts`, `src/frontend/utils/__tests__/meetingBrowseSearch.test.ts`.

**Modify:** `src/frontend/router.tsx`, `src/frontend/utils/portalLinks.ts`, `src/utils/portalLinks.ts`, `src/frontend/layouts/PortalServerLayout.tsx`, `src/frontend/pages/Library.tsx`.

**Tests:** `src/frontend/utils/__tests__/portalLinks.test.ts`, `test/utils/portalLinks.test.ts`, new search test, `test/frontend/pages.meetingDetail.test.tsx`.

**Interfaces produced:** Add `buildPortalMeetingsUrl({ baseUrl, scope, meetingServerId?, meetingId?, eventId?, fullScreen? }): string` alongside the existing direct-detail builder in `src/utils/portalLinks.ts`. The `scope` type comes from Task 1; the other fields are strings except fullScreen. Extend frontend `buildMeetingLinkForLocation` to include `meetingServerId` for unified drawer URLs while retaining its legacy inference on old server paths. Export Zod-backed `meetingBrowseSearchSchema`, inferred `MeetingBrowseSearch`, and `selectMeetingSource(search: MeetingBrowseSearch, scope: MeetingBrowseScope): MeetingBrowseSearch`. Search fields are `scope: "all" | "personal" | "guild"`, optional `serverId`, `attended`, `range`, `startDate`, `endDate`, `archive`, `tags`, `channelId`, `q`, `meetingServerId`, `meetingId`, `eventId`, `fullScreen`. Use existing optional-string/boolean parameter conventions. A drawer requires both meeting IDs. A guild scope requires a serverId; other scopes remove it. Range values are `all | today | 7 | 30 | custom`; archive values are `active | archived | all`. Defaults are all, false, all time and active archive state. Map these UI range values to the existing API range/date inputs in the browse hook.

- [ ] Write failing tests for canonical defaults, guild source validation, encoded composite meeting IDs, malformed drawer pairs and preserving meeting/event/fullscreen state. Source selection clears query/attendance/channel/tag filters, drawer and pagination, while preserving date and archive choices. Browser Back restores the prior serialized state.
- [ ] Test old Library URL conversion with replace navigation, including an empty current guild list and a retained-access server. Perform legacy redirect before `PortalServerLayout`'s membership-menu redirect can swallow it. Leave Ask's existing server-layout drawer behavior intact.
- [ ] Run `yarn jest --runInBand --coverage=false --runTestsByPath src/frontend/utils/__tests__/meetingBrowseSearch.test.ts src/frontend/utils/__tests__/portalLinks.test.ts test/utils/portalLinks.test.ts test/frontend/pages.meetingDetail.test.tsx`; confirm red, then implement URL validation and adapters.
- [ ] Extend the shared link builder with a unified-list destination while retaining parsing of direct detail and old Library links. Keep public share routes unchanged. Confirm login return URLs preserve intended destination; an authentication redirect must not reset it to All meetings.
- [ ] Re-run the focused tests and commit. Keep `Library.tsx` as a compatibility redirect, not a second list.

## Task 4: Put the source choices in the production sidebar

**Create:** `src/frontend/components/MeetingSources.tsx`, `MeetingSources.module.css`, `MeetingSources.stories.tsx`, `MeetingSources.test.tsx` in the same directory.

**Modify:** `src/frontend/components/SiteNavbar.tsx`, its stories/tests, `src/frontend/layouts/PortalLayout.tsx`, `src/frontend/contexts/GuildContext.tsx` only where needed for context synchronization.

**Consumes:** Task 3 URL state and selection function, existing authenticated `GuildContext` source metadata and `canManage` flags. Task 5 supplies previous-server metadata from already-authorized loaded rows.

**Produces:** `MeetingSources({ sources, scope, onSelect })`, with `sources: Array<{ id: string; name: string; icon?: string | null; retainedAccess?: boolean }>` and `onSelect(scope: MeetingBrowseScope): void`. All/personal choices are intrinsic, not fake Discord IDs. Use the existing icon CDN conventions, initials on missing/error images, button/link semantics and visible focus/selected state.

- [ ] Add failing component tests for one Meetings destination, visible all/personal/server choices, no Library destination or dropdown, accessible keyboard selection, long names and icon failure. Assert selected state comes from URL, not stale local storage.
- [ ] Cover a member without Manage Server, a manager, previous-server metadata, All and Personal. Assert Ask targets only the selected real server; billing/settings are unavailable without matching management rights; upload and personal settings remain reachable. Check that changing selection cannot retain a previous server's management actions.
- [ ] Run `yarn jest --runInBand --coverage=false --runTestsByPath src/frontend/components/MeetingSources.test.tsx src/frontend/components/SiteNavbar.test.tsx test/frontend/guildContext.test.tsx`; confirm red and implement using the existing portal shell.
- [ ] Match the approved sidebar layout without copying the prototype's fake top bar/profile or removing production destinations. Mobile shows a two-column source group above the list. Bound long source lists with an independently scrolling, keyboard-reachable container. Leave the current guild membership list intact; previous-server rows are supplementary display context, not membership grants.
- [ ] Re-run tests, add production stories for member/manager/missing icon/long sources, and commit.

## Task 5: Connect the unified list, onboarding and existing detail drawer

**Create:** `src/frontend/pages/UnifiedMeetingsPage.tsx`, `UnifiedMeetingsPage.stories.tsx`, `src/frontend/pages/hooks/useMeetingBrowse.ts`, `src/frontend/contexts/MeetingBrowseContext.tsx`, `src/frontend/pages/__tests__/UnifiedMeetingsPage.test.tsx`.

**Modify:** `src/frontend/contexts/AuthContext.tsx`, `src/frontend/contexts/GuildContext.tsx`, `src/frontend/queryClient.ts`, `src/frontend/pages/MyMeetings.tsx`, `src/frontend/pages/library/LibraryPage.tsx`, `src/frontend/pages/library/hooks/useLibraryMeetings.ts`, `src/frontend/pages/library/components/FirstMeetingEmptyState.tsx`, `src/frontend/hooks/useInvalidateMeetingLists.ts`, `src/frontend/layouts/PortalLayout.tsx`, `src/frontend/pages/Join.tsx`, its stories, `src/frontend/pages/MeetingDetail.tsx`, `src/frontend/storybook/UpgradePreview.tsx`, `src/utils/firstMeetingGuide.ts`, `test/utils/firstMeetingGuide.test.ts` and active link callers identified below.

**Consumes:** Tasks 2-4; existing `MeetingList`, `MeetingDetailDrawer`, `useMeetingDetail`, `SampleSummary`, auth context and action-specific backend checks.

**Produces:** A route-scoped `MeetingBrowseProvider({ children, search, enabled })` in PortalLayout, using Task 3 search state and disabled outside the Meetings destination, owns one `useMeetingBrowse(search: MeetingBrowseSearch)` invocation and exposes it through `useMeetingBrowseContext()` to both the sidebar and page. It returns authorized loaded rows, `isLoading`, `error`, `hasMore`, `discoveryComplete`, `loadMore`, `refresh` and authorized previous-server source metadata. The page uses explicit accessible/all/25 defaults. Use normalized filters as the tRPC query input, with no previous-source placeholder rows. Reuse the existing QueryClient, not a second cache. Add `resetMeetingSessionQueries(): Promise<void>` in `queryClient.ts`: on a confirmed actor change/logout, cancel and remove cached data queries while preserving the `auth.me` identity query. Expose `protectedQueriesReady` from AuthContext and gate portal queries/content until the reset for the current actor completes. Gate on the actor transition immediately, not only after an effect has rendered stale data; an unauthenticated portal still renders the existing sign-in invitation. Clear GuildContext's prior actor metadata/selection as well. Do not trust a client-supplied user ID as authorization or add it to the API solely to alter a cache key. Test the delayed-response race before implementation is considered complete.

- [ ] Pin default attendance before wiring the API:

  ```ts
  expect(
    screen.getByRole("checkbox", {
      name: "Only meetings I attended",
    }),
  ).not.toBeChecked();
  ```

- [ ] Add failing tests for mixed guild/personal/shared results, default unchecked "Only meetings I attended", sidebar source changes, URL Back/Forward and date/archive/tag/channel filters. Search uses "Search loaded meetings" and a loaded count when more remain.
- [ ] Test eight states: initial loading, unfiltered complete-empty All, complete-empty guild, complete-empty personal, filtered empty, empty page with continuation, permission/source error and missing source with retained accessible rows. Only a complete authorized unfiltered result can show first-meeting guidance. Hidden records must not affect copy/counts. Never flash onboarding before source/list readiness.
- [ ] Use deferred query promises to prove rapid source changes cannot append old rows. Test logout/account switch, refetch access denial and a stale drawer response. Reset pagination on all server-side filter changes. A source change clears search/attendance/channel/tags and drawer, preserving date/archive; Clear filters restores default filters without silently changing the selected source.
- [ ] Test opening a row from All using that row's server/record pair, not persisted selectedGuildId. Check refreshable URL, fullscreen, close-to-preserved-list and scroll restoration. Reuse existing detail actions and cover disabled artifacts, correction/import, archive and Notion invalidation. An already-open record denied on refetch clears its sensitive detail state.
- [ ] Run `yarn jest --runInBand --coverage=false --runTestsByPath src/frontend/pages/__tests__/UnifiedMeetingsPage.test.tsx src/frontend/pages/__tests__/MyMeetings.test.tsx src/frontend/features/library/__tests__/LibraryPage.test.tsx src/frontend/pages/library/components/MeetingDetailDrawer.test.tsx src/frontend/pages/library/hooks/useMeetingDetail.test.tsx test/frontend/authContext.test.tsx test/frontend/guildContext.test.tsx`; confirm red, then implement the page/hook and migrate both old entry paths to it.
- [ ] Extend `useInvalidateMeetingLists(serverId)` to invalidate all `meetings.myList` filter variants on save/correction/import/archive even when serverId is null, plus the existing scoped legacy lists when non-null. Add `src/frontend/hooks/useInvalidateMeetingLists.test.tsx` to pin global and server invalidation and include it in this task's focused run.
- [ ] Extend `FirstMeetingEmptyState` minimally to accept selected-server copy and an optional manager-only setup link. Reuse its embedded example notes. All-source onboarding selects a source or opens upload; personal empty goes to the existing upload flow. Existing command/DM behavior is unchanged.
- [ ] Run `rg -n 'MyMeetings|LibraryPage|useLibraryMeetings|/library|buildMeetingLinkForLocation' src test apps/docs-site` and migrate callers. Include Join/installer links, server cards, upload return URLs and Ask-to-meeting links. Remove superseded frontend list/filter implementations after callers move; preserve `pages/library/types.ts` and detail components still in use. Update old page tests to prove redirects rather than keeping obsolete UI alive.
- [ ] Re-run the focused suite plus link/sidebar tests. Commit the connected page, affected callers and regression tests together.

## Task 6: Build the historical guild-share pointer repair, without running it live

**Create:** `src/services/meetingShareIndexRepairService.ts`, `scripts/repair-meeting-share-index.ts`, `test/services/meetingShareIndexRepairService.test.ts`, `test/scripts/repairMeetingShareIndex.test.ts`, `docs/meeting-share-index-repair.md`.

**Modify:** `src/db.ts`, `src/repositories/meetingHistoryRepository.ts` for explicit metadata-only inventory and strong projected lookup methods. Reuse Task 1 pointer generation and repository writes.

**Produces:** `repairMeetingShareIndexPage({ mode, cursor, limit, signal }, dependencies)` returns `{ nextCursor, examined, personalWithGuildGrants, missingPointers, written, skippedChanged, failed }`. `mode` is `"dry-run" | "apply"`; cursor progress is bounded to one storage inventory page. No full MeetingHistory object or text content belongs in this interface. Use Task 1's `GuildShareIndexMetadata` for inventory/canonical metadata and `buildGuildShareIndexRecords` for repair writes. Do not synthesize a full MeetingHistory with placeholder content.

- [ ] Write synthetic tests for empty filtered pages with continuation, multiple grants, existing pointers, deterministic duplicate replay, write failure, interruption/resume and a grant revoked between inventory and canonical reread. Assert strong projected reads before writes, no content projection and no unauthorized access through a raced stale pointer. Check pointer writes through the actual repository boundary with mocked AWS, not only an array helper.
- [ ] Add CLI tests for default dry-run, explicit `--apply`, required expected account/table identity, page limit 100, max-pages budget, atomic checkpoint file replacement and refusal to resume a checkpoint from a different target or mode. Dry-run performs no writes. Do not store grants, customer identifiers or request bodies in console output; keep only bounded private checkpoint progress and aggregate receipts. An uncertain write stops; an explicit resumed invocation is idempotent.
- [ ] Run `yarn jest --runInBand --coverage=false --runTestsByPath test/services/meetingShareIndexRepairService.test.ts test/scripts/repairMeetingShareIndex.test.ts`; confirm red, implement the single-page service and thin CLI, rerun until green.
- [ ] Document exact projection, target/authority checks, checkpoints, read/write budgets and activation criteria. Zero missing pointers in an approved inventory satisfies acceptance without Apply. Otherwise, production repair needs a separate concrete approval and readback. Do not put this tool into startup, a request handler, scheduled jobs or default deployment.
- [ ] Commit code, synthetic tests and the engineering runbook. No production inventory or pointer mutation occurs in this task.

## Task 7: Lock the real page with screenshots, scrolling and user docs

**Create:** `test/e2e/unifiedMeetings.spec.ts`, `test/e2e/unifiedMeetings.visual.spec.ts`, `test/e2e/unifiedMeetingsMocks.ts`.

**Modify:** production stories from Tasks 4-5, `test/e2e/mockData.ts`, `test/e2e/fixtures.ts`, `test/e2e/visual.spec.ts`, `test/e2e/firstMeeting.visual.spec.ts`, `test/e2e/library.spec.ts`, `test/e2e/pages/LibraryPage.ts`, `test/e2e/pages/PortalNav.ts`, `test/e2e/pages/testIds.ts`, `test/e2e/scrollAssertions.ts`, `apps/docs-site/docs/getting-started/overview.md`, `apps/docs-site/docs/whats-new/index.md`; update `.storybook/test-runner.ts` only for the new production story IDs requiring scroll checks.

**Consumes:** The actual routed page, not the prototype. Import `Locator` as a type from `@playwright/test` for the targeted scroll assertion. Existing mock backend/API fixtures, fixed-clock visual utilities and reusable detail/onboarding components. Existing CI `Visual Regression` job already runs `yarn test:visual`; new `@visual` tests must join that job without a new workflow.

- [ ] Write route tests for sign-in return, default list, all/personal/server scopes, attendance, Load more, legacy Library replacement redirect, direct detail links and Back/Forward. Use an ordinary member fixture with denied meetings as well as a manager fixture. Assert no cross-source results, false empty guide or management actions from the wrong server.
- [ ] Extend `assertPageCanScroll(page, target?: Locator)` to target the intended scroll element while preserving existing callers. Assert scrollHeight exceeds clientHeight and scrollTop changes for `[data-testid="meeting-browse-scroll"]`, source-list scrolling and `[data-testid="meeting-drawer-content"]`. Run in ordinary portal mode, not only `visual=1`; check that sidebar scrolling does not move meeting content. Assert no horizontal page overflow.
- [ ] Add deterministic production stories for mixed All, selected guild, attended, personal, global/server/personal onboarding, filtered empty, retained/denied source, loading, error, drawer and long/missing-icon sources. Capture with `yarn storybook`, then `yarn test-storybook --includeTags unified-meetings --maxWorkers 1`. Confirm these tests target production stories, not the throwaway prototype tag.
- [ ] Add `@visual` route snapshots at 1280x720, 768x900, 390x844 and 1920x1080. Both themes cover the main list and unfiltered empty states; other required states use dark plus light wherever theme-dependent controls differ. Include 767px and 768px interaction/layout assertions around the mobile source breakpoint. Capture both viewport and full-page states with existing utilities. Keep tolerances at existing levels.
- [ ] Run `$env:PW_VISUAL='true'; yarn playwright test test/e2e/unifiedMeetings.visual.spec.ts --project=chromium` for comparisons, then unset `PW_VISUAL` before `yarn playwright test test/e2e/unifiedMeetings.spec.ts test/e2e/library.spec.ts test/e2e/meetingDetailScroll.spec.ts --project=chromium` for behavior/ordinary scrolling. The first baseline run is expected to need approved screenshots; use `--update-snapshots` only on the new/changed tests, inspect every changed baseline with a VLM, then rerun comparisons without that flag. Update old My Meetings/Library expectations to the same canonical UI and leave direct-link regression coverage intact.
- [ ] Use the docs-authoring skill. Explain one Meetings destination, source filters, actual attendance and preserved old links in public user docs; add a concise What's New entry. Do not include private repair receipts or provider/customer information. Run `yarn docs:check`.
- [ ] Run `yarn build`, `yarn build:web`, `yarn build-storybook`, focused ESLint/Prettier checks and the affected Jest suites, followed by `yarn test:visual` once the focused checks pass. Investigate failures; do not regenerate every snapshot to make CI green. Save screenshot inspection notes and exact commands/results with the source checkpoint.
- [ ] Commit the tests, inspected baselines and docs. Obtain a fresh whole-branch review focused on the five Review focus cases, then resolve valid feedback and repeat only affected checks. If later asked to publish/iterate a PR, follow both PR skills and the repository's exact-head 30-minute final audit. Do not call local tests hosted CI or production acceptance.

## Acceptance and rollout handoff

The source change is ready for review when all scoped authorization/navigation tests pass, production Storybook captures and route snapshots are visually inspected, normal-mode scrolling works and old links reach authorized notes. No duplicate frontend library remains. MCP behavior and existing detail actions remain covered.

Before claiming full production acceptance, the deployment owner needs separately approved historical pointer inventory/repair evidence, the deployed source identity and an authorized signed-in smoke check. A preview, source merge or repaired index alone proves none of the others. Do not run these production steps from this implementation plan without their applicable authorization.

## Self-review and execution handoff

- Spec coverage maps discovery/personal shares/permissions to Tasks 1-2 and 6; URLs to Task 3; source navigation to Task 4; all empty/detail/cache states to Task 5; screenshots/scrolling/docs to Task 7.
- All five Review focus classes have explicit owning tests. Partial discovery, legacy cursors and former-member access are covered alongside the obvious populated state.
- Interfaces are shared by task number; browser scope and drawer record IDs stay distinct. Existing MCP and artifact/action authorization are reused.
- No product code, dependencies, customer-data repair, CI run or deployment was performed while writing this plan. The prototype remains a separate throwaway preview.

Recommended execution is subagent-driven because access/discovery, navigation and UI changes need checks at their handoffs. Native execution with one fresh whole-branch review is also available. Confirm the plan and execution approach before implementation, as required by the writing-plans workflow.
