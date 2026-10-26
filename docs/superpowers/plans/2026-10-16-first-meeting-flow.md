# First-meeting flow implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give new servers one clear path from installation to saved meeting notes,
with matching guidance on the site and in Discord.

**Architecture:** Retire the Discord setup wizard and put short instructions in
the installer DM and empty meeting library.
Reuse `/join`, `SampleSummary`, the library empty state and canonical meeting links.
Add one permission-checked, read-only meeting-status query backed by existing history
and leases; no new progress storage or recording controls.

**Tech stack:** Node.js 24.15.0, TypeScript, discord.js v14, React 19, Mantine,
tRPC, Jest, Storybook and Playwright. No new dependencies.

**Spec:** [Approved first-meeting design](../specs/2026-10-16-first-meeting-flow-design.md).

**October 20 execution status:** All four source tasks are complete in the isolated
worktree. The final review's four findings and the quality scan's four duplication
findings are addressed. The scoped independent review found no new blocking issue.
Complete Jest, Storybook, build, documentation and quality checks passed. All 136
visual tests passed with three workers; the standard runner's final retry passed
135, with one existing library test reaching its 30-second limit. Commit and
publication remain with the controller. CI, deployment and native Sandbox
acceptance remain unverified.

BASIC selected **B, Steps + example**, and its installer DM on October 19. The
implemented library pairs short instructions with the existing Discord-styled
example and stacks them on smaller screens. The installer links to that library;
`/onboard` is retired with safe handling for old interactions. The selected copy
and layout remain in the spec's
[selected layout section](../specs/2026-10-16-first-meeting-flow-design.md#selected-library-layout-and-installer-copy).

**Execution:** Scoped workers implemented the approved design in one
isolated worktree, with controller review after each task. The controller owns the
complete Jest suite and final frozen-tree quality check. No push, deployment or
provider action is part of this execution.

## Global constraints

- Keep the three instructions, **Open Discord**, **Open meeting** and collapsed
  **Optional setup** from the approved design. Remove the recording-reminder copy.
- Ship only layout B. Reuse `SampleSummary`; retain its Discord palette and visible
  fictional-example label. Stack the example below instructions under 800 CSS
  pixels of available content width, and steps under 600. No prototype controls.
- Preserve remaining command, settings, channel and meeting permissions, installer/owner
  fallback, recording controls, delivery acknowledgments and recovery behavior.
- Never infer successful recording or delivery from a click, a lease alone, a
  `complete` status alone or a PostHog event. Show existing capture/recovery warnings.
- Public instructions require no sign-in; real progress does. Unknown servers stay
  generic. No arbitrary server selection or private meeting metadata in a response.
- No new PostHog events or properties, billing changes, welcome posts, unsolicited
  DMs, storage migrations, resend endpoint or historical first-use tracker.
- Keep existing upgrade notices separate. Remove stale wizard entitlement copy.
- Start execution in a clean current-remote-head worktree. The planning checkout
  contains unrelated changes; do not stage or carry those into this feature.

## Review focus

1. A newer inaccessible meeting must not hide an older accessible candidate or leak
   metadata. A direct missing and denied target has the same result (Task 1).
2. Stale leases, absent legacy delivery evidence and partial Discord delivery must
   not produce false success or a live-recording claim (Task 1).
3. Previously sent wizard controls must acknowledge safely without changing server
   settings or reviving the old wizard (Task 2).
4. Sign-in, refetch and server changes must preserve the intended meeting without
   letting a response from the previous server replace it (Task 3).
5. Loading, errors, archives and filtered-empty results must not masquerade as a new
   server; narrow layouts must retain readable actions and scrolling (Tasks 3–4).

## Deliverables and file map

| Task                              | Files and responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: trustworthy status             | New `src/types/firstMeeting.ts` and `src/services/firstMeetingService.ts`; extend `src/trpc/routers/meetings.ts`; new `test/services/firstMeetingService.test.ts`; extend `test/trpc/meetingsRouter.test.ts`.                                                                                                                                                                                                                                                                                                  |
| 2: installer and recording result | New `src/utils/firstMeetingGuide.ts` for Discord payloads; update `src/commands/onboard.ts`, installer DM in `src/bot.ts`, and existing message components in `src/embed.ts`; new `test/utils/firstMeetingGuide.test.ts`; extend `test/commands/onboard.test.ts` and `test/embed.test.ts`.                                                                                                                                                                                                                     |
| 3: site guide and handoff         | Update `src/frontend/pages/Join.tsx`, `src/frontend/router.tsx`, `src/frontend/contexts/AuthContext.tsx`, `src/frontend/services/analytics.ts`, `src/frontend/pages/library/hooks/useLibraryMeetings.ts`, and `src/frontend/pages/library/LibraryPage.tsx`; extend `test/frontend/pages.join.test.tsx`, `test/frontend/pages.library.test.tsx`, `test/frontend/authContext.test.tsx`, `test/frontend/analytics.test.ts`, `test/e2e/join.spec.ts`, `test/e2e/library.spec.ts` and `test/e2e/pages/JoinPage.ts`. |
| 4: visual and public acceptance   | Extract `src/frontend/storybook/UpgradePreview.tsx` from the existing oversized `UpgradePlans.stories.tsx` and migrate its two callers; extend `Join.stories.tsx`; add sibling `FirstMeetingEmptyState.stories.tsx` and actual-payload `FirstMeetingDiscord.stories.tsx`; add `test/e2e/firstMeeting.visual.spec.ts` and its snapshots, update only intended existing join snapshots; update public getting-started, features, admin permissions, What's New and README guidance.                              |

Task 3 also creates `src/frontend/pages/library/components/FirstMeetingEmptyState.tsx`
and `FirstMeetingEmptyState.module.css` in that directory. Task 4 adds the sibling
`FirstMeetingEmptyState.stories.tsx`. Keep the rich first-use view local to the
server library; do not expand `MeetingList`'s string description prop or change its
other callers. Existing `MeetingList` loading, error and search-empty stories stay.

Reuse `buildPortalMeetingUrl` in `src/utils/portalLinks.ts`, existing meeting access
helpers, `getActiveMeetingLeaseForGuild`/`isLeaseActive`, capture notices and the
library's existing query and shell. Do not build replacement infrastructure.

## Task 1: expose trustworthy meeting progress

**Files:** Task 1 row above. Reuse the history service readers already imported by
the meetings router and `ensureUserCanAccessMeeting` with the configured attendee
access setting, not its permissive default by accident.

**Interfaces:** Export from `src/types/firstMeeting.ts`:

```ts
type FirstMeetingTarget = {
  historyId: string;
  title: string;
  portalUrl: string;
  discordUrl: string | null;
  captureNotice: string | null;
  recoveryNotice: string | null;
};
type FirstMeetingState =
  | { kind: "guide" }
  | { kind: "recording" | "processing"; meeting: FirstMeetingTarget }
  | { kind: "ready" | "saved"; meeting: FirstMeetingTarget }
  | {
      kind: "delivery_attention";
      delivery: "partial" | "failed";
      meeting: FirstMeetingTarget;
    }
  | {
      kind: "attention";
      reason:
        "interrupted" | "no_notes" | "processing_failed" | "status_unknown";
      meeting: FirstMeetingTarget;
    };
```

Export `getFirstMeetingState(input: { guildId: string; userId: string;
historyId?: string }): Promise<FirstMeetingState>` from the new service.
Expose `meetings.firstMeeting({ serverId: string, historyId?: string })` through
`guildMemberProcedure`. Use existing router error conventions for denied/missing
targets and unavailable permission checks. Server IDs are Discord snowflakes;
`historyId` is the history sort key (`channelId_timestamp`), never the internal UUID.

- [x] Write service and router tests named `selects_latest_accessible_candidate`,
      `denied_target_matches_missing_target`, `requires_member_and_bot_presence`,
      `lease_and_delivery_evidence`, and `preserves_incomplete_outcomes`. Assertions:

  ```ts
  expect(result).toMatchObject({ meeting: { historyId: accessibleHistoryId } });
  expect(deniedError.code).toBe(missingError.code);
  expect(expiredLeaseResult.kind).toBe("attention");
  expect(savedWithoutDelivery.kind).toBe("saved");
  expect(partialResult).toMatchObject({
    kind: "delivery_attention",
    delivery: "partial",
  });
  expect(completeDeliveryResult.kind).toBe("ready");
  expect(JSON.stringify(result)).not.toContain(privateMeetingTitle);
  ```

  Fixtures also cover signed-out/nonmember access, disabled attendee access,
  permission-provider unavailability, whitespace-only notes, skipped/failed notes,
  empty transcription, cancellation, interrupted capture and recovery warnings.
  Assert the DTO has no notes body, transcript, provider error or media URL.

- [x] Run `yarn test --runInBand --runTestsByPath test/services/firstMeetingService.test.ts test/trpc/meetingsRouter.test.ts`.
      Confirm failure comes from the absent procedure/service or the new assertions.
- [x] Implement the signatures above. With an explicit history key, point-read that
      record and check access without falling back to a different meeting. Otherwise
      read at most 50 recent unarchived guild records, check access before choosing the
      newest permitted candidate, and return `guide` if none is available. This bounded
      lookup is recent activity, not proof that a server has never recorded.
- [x] Derive state using persisted notes, processing and delivery outcomes. Only
      matching, unexpired leases justify `recording` or `processing`; a stale active
      row becomes `attention/status_unknown`. Missing history during initialization
      stays generic until a permitted row appears. Saved nonblank notes take priority:
      acknowledged complete notes delivery (`sent === intended`, `intended > 0`)
      with the matching number of message pointers means `ready`;
      partial/failed means `delivery_attention`; absent evidence means `saved`.
      Preserve capture/recovery notices on every target. Terminal rows without notes
      use `attention`, never success. Build URLs with the existing canonical helper
      and authorized message/channel pointers; do not guess a recording message ID.
- [x] Rerun the Task 1 command and require all tests to pass. Commit only Task 1
      files with `feat: expose permission-checked first-meeting progress`.

## Task 2: retire the wizard and improve existing Discord messages

**Files:** Task 2 row above. Leave recording and delivery ownership protocols intact.

**Interfaces:** In `src/utils/firstMeetingGuide.ts`, export only
`buildFirstMeetingInstallerMessage(options: { guildId: string; serverName: string; siteUrl: string }): BaseMessageOptions`.
The payload uses the spec's exact installer copy, **Open {serverName}** and **Open portal**
to that server's existing library route. It uses link buttons, not DM-incompatible
server interaction controls. Do not create a replacement guide command.

- [x] Add `installer_explains_first_recording`, `legacy_controls_are_read_only`,
      `retired_command_is_not_registered` and `notes_actions_preserve_delivery` tests.
      Assert the exact three steps, interpolated server name, server/portal links
      and retained sign-in destination. Include long and Markdown-bearing server
      names; escape display formatting without changing IDs or link destinations,
      fit Discord's button-label limit and disable unintended mentions.
      Exercise every supported old wizard button, modal and channel-select ID,
      including auto-all, plus a temporarily cached slash invocation.

  ```ts
  expect(saveAutoRecordSetting).not.toHaveBeenCalled();
  expect(setConfigOverrideForScope).not.toHaveBeenCalled();
  expect(replyPayload.flags).toBe(MessageFlags.Ephemeral);
  expect(registeredCommands.map((command) => command.name)).not.toContain(
    "onboard",
  );
  expect(notesActions.map((action) => action.label)).toContain("Open meeting");
  expect(notesActions.map((action) => action.label)).toContain(
    "Optional setup",
  );
  ```

  A former installer clicking an old control must receive the retirement notice,
  never a settings write or privileged access. Retain installer-discovery and owner
  fallback tests. Test caught DM failure, component limits, multipart notes,
  existing upgrade actions and finalization acknowledgments. Assert no new capture.

- [x] Run `yarn test --runInBand --runTestsByPath test/utils/firstMeetingGuide.test.ts test/commands/onboard.test.ts test/embed.test.ts`; confirm the new assertions fail.
- [x] Remove `onboardCommand` from registration in `src/bot.ts`. Replace the old
      wizard handlers in `src/commands/onboard.ts` with safe acknowledgment of existing
      interaction IDs and cached invocations. The private notice is: "Setup is now in
      the portal." Include **Open portal** for that server; do not return a tutorial,
      apply settings, or record a new installer. Keep acknowledgments within Discord's
      response deadline. Preserve the installer-DM feature gate and its fallback logic.
      Delete unused wizard presentation/imports after checking all callers. Leave
      historical state, storage schema and existing configuration commands alone.
- [x] Use the installer builder in the existing guild-install DM path. In
      `src/embed.ts`, relabel the canonical result link **Open meeting** and add a
      link-style **Optional setup** to `/join?serverId=...#optional-setup`. Put these
      actions on the last notes batch and the summary's existing result row. Preserve
      correction/feedback/tag/upgrade controls and delivery counts. Do not add messages,
      resend paths, completion flags or settings mutations.
- [x] Rerun the Task 2 command and
      `yarn test --runInBand --runTestsByPath test/services/guildInstallerOnboardingService.test.ts test/services/guildInstallerService.test.ts`.
      Require passing tests; commit only Task 2 files with
      `feat: retire onboarding wizard and add contextual first-meeting help`.

## Task 3: connect the site guide, library and saved meeting

**Files:** Task 3 row above. Keep the guide in `Join.tsx` unless its status section
becomes too large to review; reuse house components rather than adding a framework.

**Interfaces:** `/join` accepts validated optional `serverId` and `historyId`
search values. Use `meetings.firstMeeting` from Task 1. Expose
`hasAccessibleMeetings: boolean` and `listReady: boolean` from `useLibraryMeetings`.
The first uses returned rows before UI filtering, not a historical server count;
the second requires an enabled, successful query for the currently selected server.
Update the hook's result type, its callers and test mocks together. Keep the existing AuthContext
login URL builder; add `/join` to its allowed local return destinations.

Export `FirstMeetingEmptyState({ discordUrl, optionalSetupUrl }: {
discordUrl: string; optionalSetupUrl: string }): React.JSX.Element` from the new
library component. It consumes verified server destinations supplied by
`LibraryPage`, contains the selected instructions and `SampleSummary`, and performs
no queries or recording actions. Use a CSS container query on its wrapper for the
800/600-pixel stacking thresholds. Keep it scoped to the server library.

- [x] Add `unknown_server_stays_generic`, `normal_member_can_choose_server`,
      `pins_meeting_and_ignores_old_server_response`, `signin_preserves_guide_target`,
      `filtered_empty_is_not_first_meeting`, and `status_error_keeps_verified_result` tests.
      Include private/missing direct target, no bot, invalid search, loading, archives
      and permission-loss fixtures. A known server is verified against the existing
      signed-in `servers.listEligible` result, including members without Manage Server.
      Add `empty_library_uses_selected_example_layout`,
      `older_unfiltered_row_suppresses_first_use` and
      `empty_library_filters_do_not_hide_existing_results`. Assert a successful,
      unfiltered empty active response shows all three instructions, one
      `sample-summary` with its fictional label, **Open Discord** and collapsed
      **Optional setup**, and hides filter/count/sort chrome. A row outside the
      default 30-day display range must suppress first-use guidance. Loading,
      errors, archive views and user-applied filters retain their normal UI.

  ```ts
  expect(openDiscord).toHaveAttribute(
    "href",
    "https://discord.com/channels/@me",
  );
  expect(loginReturn.pathname).toBe("/join");
  expect(loginReturn.searchParams.get("historyId")).toBe(intendedHistoryId);
  expect(
    filteredEmptyView.queryByText("Your first meeting goes here."),
  ).toBeNull();
  expect(savedMeetingLink).toHaveAttribute("href", intendedPortalUrl);
  expect(JSON.stringify(redactDeep(captureProperties))).not.toContain(
    intendedHistoryId,
  );
  ```

  Test each Task 1 state against the exact copy in the spec, including partial
  delivery and legacy saved-only records. The sample remains `SampleSummary`.
  Assert **Open portal** is available before recording and preserves the selected
  server through sign-in; the unknown-server link uses the existing server picker.
  Analytics fixtures include guide query parameters, meeting-page URLs, referrers,
  link attributes and encoded nested sign-in return URLs.

- [x] Run `yarn test --runInBand --runTestsByPath test/frontend/pages.join.test.tsx test/frontend/pages.library.test.tsx test/frontend/authContext.test.tsx test/frontend/analytics.test.ts`; confirm new assertions fail before editing production code.
- [x] Add server choice with the existing `ServerPicker` and eligible-server query.
      Keep sign-in optional for the generic guide and necessary for real progress.
      Never trust query parameters as access proof. Preserve explicit target errors
      without silently substituting another meeting. Once an authorized candidate is
      returned, retain its history key in the URL for refetch/reload. Server selection
      clears the previous target and cache display immediately.
- [x] Keep **Open Discord** primary before recording and add **Open portal** as a
      visible secondary link. A verified server opens its existing meeting-library
      route; an unknown server opens the existing portal server picker. Preserve the
      intended destination through the normal sign-in flow.
- [x] Render the approved state and primary action from the DTO. Refetch on focus
      and **Check again**; poll every 10 seconds only while visible and in verified
      recording/processing state. Before a meeting is found, returning from Discord
      refetches on focus. Stop polling terminal states. Preserve the last verified
      display on transient errors, mark it stale and remove live-state claims; clear
      protected display on authorization loss. No timer or progress percentage.
- [x] Preserve `/join` search in sign-in return through the existing same-origin
      redirect validation. Use the canonical meeting URL for **Open meeting** so its
      existing protected route returns to the same record after sign-in. Remove the
      reminder sentence; keep optional setup collapsed except on its explicit hash.
- [x] Extend the existing `redactShareIds(value: string, depth?: number): string`
      and `redactDeep(value: unknown): unknown` pipeline to redact guide `historyId`
      and `serverId` query values and the meeting-key segment of canonical meeting
      paths, including encoded return URLs. Keep real navigation URLs intact; only
      analytics copies are redacted. Reuse the bounded parser, preserve DNT behavior,
      and add no capture calls or properties. This narrows collection.
- [x] Implement `FirstMeetingEmptyState` with the spec's exact copy and the existing
      `SampleSummary`, not copied markup. Instructions and primary action precede
      the sample in DOM order. Keep the fictional label visible and optional setup
      collapsed. Use the existing house layout components and the scoped stylesheet.
- [x] Render this component from `LibraryPage` only after a successful, unfiltered
      active-library response with no accessible rows before client filtering.
      Return `hasAccessibleMeetings` from the existing hook using `meetingRows.length`
      rather than `filteredMeetings.length`. Require a verified selected server,
      settled successful query and no user-applied filters. Do not infer first use
      from a disabled query, previous-server placeholder or filtered rows. Hide
      filter/count/sort controls only while this view is active; keep navigation and
      integration status. Preserve `MeetingList` and normal filter controls in all
      other cases, including loading, errors, archives and search-empty states.
- [x] Rerun the Task 3 Jest command, then
      `yarn test:e2e test/e2e/join.spec.ts test/e2e/library.spec.ts --project=chromium`.
      Require passing state transitions, server switches, sign-in return and actual
      scrolling (`scrollHeight > clientHeight` and changed `scrollTop`). Commit only
      Task 3 files with `feat: connect first-meeting guide to server progress`.

## Task 4: capture visual regressions and finish public guidance

**Files:** Task 4 row above. The focused `@visual` spec is discovered by the existing
runner; do not grow `visual.spec.ts` or change its wrapper. The installer is captured
by the existing Storybook harness, so standard Playwright CI needs no Storybook
server. Reuse the existing Storybook router/auth/tRPC fixture;
the Discord story consumes the actual Task 2 builders' serialized payloads.
Its small story-only renderer is a review aid, not a new production component.

**Interfaces:** Add `firstMeetingState?: FirstMeetingState` to the existing
`UpgradePreview` fixture props. New story exports: `UnknownServer`, `Recording`,
`Processing`, `Ready`, `SavedWithoutDelivery`, `DeliveryPartial`, `DeliveryFailed`,
`StatusUnavailable` and `OptionalSetup`. The Discord story exports `InstallerGuide`, using the real installer payload.
Existing recording/result behavior is covered by payload tests and the separate
live Sandbox acceptance check.

The sibling `FirstMeetingEmptyState.stories.tsx` exports `StepsAndExample` using the
real Task 3 component and verified link fixtures. Page-level Playwright
coverage uses the existing library route with authenticated mocked empty data,
including ordinary members. The installer story uses Task 2's real payload, not
another hardcoded version of the DM copy.

- [x] Add story play assertions for exact copy, links, optional disclosure and
      available actions before adding fixtures. Add Playwright screenshot assertions
      for these site states at 390, 768 and 1280 pixels, retaining existing join views
      and existing light/dark coverage. Include ready, partial delivery and optional
      setup in light theme. Assert no horizontal overflow and that primary actions
      remain reachable by keyboard and scroll. Require tests to fail on absent states.
      Include the selected empty server-library page and installer DM. For the
      library, assert instructions precede the example at 390 and 768 browser
      pixels, appear beside it when content width reaches 800 pixels, and never
      overflow when steps change orientation around 600 pixels. Check one pixel
      either side of both content-width thresholds in the component story.
      Capture both portal themes and keep the example's Discord colors unchanged.
      Verify filters remain available in search-empty, error, loading and archive
      states. Assert the installer DM's **Open portal** targets the same library.
- [x] Implement the fixtures and story-only Discord payload renderer. Record an
      initial screenshot run without updating baselines and inspect its differences;
      update only intended changed/new snapshots, then rerun without update flags.
      Keep `react-docgen-typescript` and the existing screenshot harness intact.
- [x] Run Storybook on port 6006, `yarn test-storybook`, and
      `yarn test:visual:update`, followed by `yarn test:visual`.
      The repository wrapper does not forward a custom grep argument.
      Review generated Storybook captures
      and the affected Playwright snapshots with the VLM; repair clipping, wrapping,
      misleading emphasis or stale visual claims before accepting baselines.
- [x] Update getting-started docs with the three actions, optional commands and
      where notes appear. Remove wizard instructions and the guide's reminder copy.
      Add a concise What's New entry. Run `yarn docs:check`, `yarn build`,
      `yarn build:web`, `yarn lint:check`, `yarn prettier:check`, and
      `yarn markdownlint:check`. Require exit 0.
- [x] Run the complete Jest suite after integration and inspect the final quality
      result and independent review.
- [ ] Commit the reviewed Task 4 and final fixes after controller checks, then
      publish only within the user's authorized scope.
- [ ] Before calling the live flow accepted, use Dev/Sandbox with an approved test
      server to verify installer
      DM, one recording, saved notes, Discord result actions and the
      site's same-meeting return. Reuse test evidence for delivery failure and private
      channels rather than changing a real user's permissions. Record source, CI,
      deployment and live outcomes separately in the existing private ops owner note.
      Existing recording-safe deploy guards and production authorization still apply.

### Local execution evidence

Task 4 and its final fixes are complete. Storybook passed 43 suites and 274 tests,
including 28 focused first-meeting checks. Captures use the real components and
installer payload. All 42 first-meeting visual cases passed. The complete visual
selection passed all 136 tests with three workers and no update flags. VLM review
confirmed the responsive layout, fictional-example label, Discord palette,
restored Refresh action and truthful guide status sentence.

The final standard-runner retry passed 135 of 136 tests. Its existing library
case reached the 30-second total limit while selecting All time. An earlier
standard run had five existing timeouts and one Ask scrollbar/footer difference;
none reproduced in the complete three-worker pass. No unrelated baseline,
runner, timeout or configuration was changed. The standard runner remains red;
retain this limit in the publication and CI handoff.

The preceding complete Jest run passed 386 suites and 3,639 tests with normal
coverage. The final source run passed 386 suites and 3,646 tests without coverage
collection. It reported a delayed-exit warning, then exited successfully. Backend
and frontend builds, docs, lint, formatting and Markdown checks passed. The final
pinned quality scan inspected all 1,182 eligible files and reported zero
duplication, complexity or file-size findings. The broader frontend typecheck
retains its unchanged 58 baseline diagnostics.

Scoped independent review confirmed the eight final findings were addressed and
found no new blocker. This establishes local source and capture evidence. It does
not establish CI, deployed behavior, native Discord rendering or a Sandbox
recording.

## Measurement and completion

Keep `server_installed`, `meeting_started` and `meeting_completed` unchanged.
Retiring wizard writes means `onboarding_step_reached` is historical, not a
comparable measure of this guide. Do not invent replacement tutorial events.
Existing aggregate reporting can connect installs to permitted saved/delivered
results and a later useful meeting, with capture gaps stated. Any future collection
change needs its own privacy review and notice; PostHog is never the progress store.

The implementation is complete when its source checks and reviewed screenshots
pass. Describe hosted acceptance separately until the Sandbox exercise passes.
If asked to publish a PR, use the repository's push/review skills and its full
30-minute current-head feedback window before calling the PR merge-ready.

## Plan review and evidence appendix

Self-review covered spec requirements, task interfaces, concrete test assertions,
the five Review focus conditions and scope. No new storage, dependencies, billing
behavior, event schema or recording-control path is required. The bounded candidate
query can miss older accessible meetings, so its empty state makes no historical
first-ever claim. Native Discord rendering remains a Sandbox acceptance item.

Latest layout-planning source: remote `master`,
`d80c8baae5562d8ba818f7a1cdd616a6f5204f2a`, verified through GitHub on October 19, 2026. Inspected the pinned library page, hook, list, list stories and `SampleSummary`.
The library response precedes client filtering, so its rows can distinguish a
display-filtered empty list without a new query. `MeetingList.emptyDescription`
is a string; a library-local component avoids changing that shared contract.
The earlier status-service planning used
`00813f875433299c5fa2feae544e94b8d7fc6fe1` on October 16. Execution must refresh that
service analysis before implementation. Reads were pinned because the planning
checkout is older and dirty. Execution
must recheck drift before editing. This planning pass ran no product tests and
made no provider, deployment, PostHog or Discord mutations.

### Final implementation and review

The implementation follows the approved in-context journey. Existing permissions,
recording controls and delivery warnings remain authoritative. The empty library
keeps manual refresh and refreshes its existing query on focus without polling.
The shared analytics-copy sanitizer removes Discord channel and message link
identifiers, including encoded return URLs, while navigation keeps its real hrefs.

The final review and quality fixes add no storage, dependencies, collection or
provider operation. Local checks and reviewed captures are recorded above. The
standard visual timing failure, existing frontend typecheck debt and unverified
CI/deployment/native acceptance remain explicit handoff limits. The controller
owns commit and publication.
