# Shared meeting update delivery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make supported meeting edits save once and durably synchronize their existing Discord presentation without DynamoDB Streams.

**Architecture:** A shared application action conditionally saves canonical fields and a compact delivery intent on the same meeting row. A sparse due index feeds a REST worker in existing application runtimes. Every provider mutation has durable submission state and a common per-meeting ownership barrier.

**Tech Stack:** Node.js 24.15.0, TypeScript, strict Zod schemas, AWS SDK v3/DynamoDB, Discord REST, Jest, local DynamoDB, existing Terraform and runtime lifecycle tools.

**Spec:** [Approved design](../specs/2026-10-22-shared-meeting-update-delivery-design.md), approved at commit `51dd212341a0d18257c43820004b6f162051084b`.

## Execution authority and sequencing

The user approved the written spec and explicitly chose subagent implementation.
This plan breaks that approved scope into implementation and review gates. Use
one fresh implementer per task, one task-scoped reviewer after it, scoped fix
rounds, and a fresh whole-branch reviewer at the end. Do not ask again which
execution method to use or stop between successful task gates.

Start from the approved design branch, whose product baseline is
`bb7b2e89b0b0be256efdd27de744f250334ea67e`. Recheck remote master before
implementation. Keep changes on the dedicated feature branch and preserve any
unrelated workspace changes.

Create the SDD workspace and ledger using the installed skill's scripts once
the executor is usable. Record every task base/head, test commands and outcomes,
review verdicts, and rulings there. Before Task 1, record the required
task-interface conflict table. A pending/offline executor is not test evidence.

## Global constraints

- Runtime is Node.js 24.15.0 and package engines are `>=24.15.0 <25`.
- No Streams, SQS, Lambda, new queue table, historical backfill or blanket production repair.
- Legacy missing content revision is zero; missing notes version is one.
- Content and intent persist atomically on the same existing row.
- The queue constant is `meeting-update:v1`; due timestamps use epoch seconds.
- `UpdateDeliveryDueIndex` uses `updateDeliveryQueue` and `updateDeliveryDueAt`, with `KEYS_ONLY` projection.
- Poll immediately and every five seconds, without overlap; admit at most 25 candidate rows and 10 seconds of admission work per poll; allow two claimed meetings concurrently.
- Honor definite rate-limit timing; otherwise retry with jittered exponential backoff starting at five seconds and capped at five minutes.
- Expired leases do not authorize replay of submitted effects. Uncertain outcomes use read-only reconciliation.
- Discord retry execution makes zero LLM, Notion, notification or new-export calls.
- Preserve existing Notion opt-in, cancellation and uncertainty handling at the successful notes action boundary, exactly once.
- Preserve controls, links, attachments, unrelated embeds, colors, timestamps and required uncertainty notices.
- Ordinary notes-only delivery does not rewrite an unrelated summary.
- Preserve supported pagination growth and shrinkage; never recreate a missing recorded post automatically.
- Preserve original initial-publication, recovery, personal-upload and deployment ownership.
- Public code/docs/fixtures contain synthetic data only. Real operational evidence stays private.
- Run required quality gates. No quality-exception label without explicit user authorization.

## Review focus

1. A notes save races with a worker transition: neither may erase newer work or an immutable submitted attempt. Exercise in Tasks 1 and 2.
2. Rename races with pending body delivery: both title changes and the newer body must eventually remain requested. Exercise in Tasks 1, 3 and 6.
3. A process dies after a POST ID is durably recorded but before pointer registration: keep that candidate for safe replanning; a crash before ID persistence instead remains an unknown-POST hold. Exercise in Tasks 4 and 6.
4. An old repair publisher or initial-delivery owner overlaps adoption: there must be one delivery barrier before any provider write. Exercise in Task 6.
5. A save succeeds while Discord fails: the user sees saved data plus pending/attention status, and retry does not rerun correction generation or Notion. Exercise in Tasks 6 and 7.

## File boundaries

| Unit                                                  | Ownership                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/types/meetingUpdateDelivery.ts`                  | Schemas, discriminated state, per-part revisions, cursors and pure transitions              |
| `src/repositories/meetingUpdateDeliveryRepository.ts` | Strong reads, due discovery, content/intent CAS, claims, operation progress and pointer CAS |
| `src/services/meetingUpdateService.ts`                | Shared canonical update action and single existing Notion hook                              |
| `src/services/meetingUpdatePlan.ts`                   | Scoped embed merge and bounded ordered pagination plan                                      |
| `src/services/meetingUpdateDeliveryService.ts`        | Durable provider operations and read-only reconciliation                                    |
| `src/services/meetingUpdateDeliveryWorkerService.ts`  | Bounded due polling and runtime ownership                                                   |
| Existing callers and lifecycle code                   | Authorization, generation/approval, initial publication and common delivery barrier         |
| Existing meeting detail UI                            | Save versus delivery status, no new administration surface                                  |

Keep provider planning/execution helpers focused when complexity warrants a
module split. Do not create a general workflow framework or duplicate the
legacy notes/version/provenance rules.

### Task 1: Domain state and deterministic transitions

**Files:** Create `src/types/meetingUpdateDelivery.ts` and
`test/types/meetingUpdateDelivery.test.ts`; modify `src/types/db.ts`.

**Interfaces:**

- Export `MeetingUpdateKey = Pick<MeetingHistory, "guildId" | "channelId_timestamp">`.
- Export `PresentationPart`: `notesBody`, `notesTitle`, `notesWarning`,
  `summaryBody`, `summaryTitle`, `summaryWarning`.
- Export `PartWatermarks = Record<PresentationPart, { desired: number; acknowledged: number }>`.
- Export strict schema-derived `MeetingUpdateDelivery`,
  `PreparedMeetingUpdateAttempt`, `MeetingUpdateDeliveryTransition`,
  `MeetingUpdateMutation`, `NotesPointers` and due-cursor types.
- The delivery envelope names its watermarks `parts` and its discriminated
  operation state `progress`. A running `progress` owns the immutable attempt.
- Delivery has a separate opaque string `revision` CAS token advanced on every
  transition. Canonical revision does not substitute for this token.
- Export `requestedPartsForMutation(mutation)`,
  `requestMeetingUpdateDelivery(input)`,
  `meetingUpdateDeliveryNextCheck(delivery)`,
  `assertMeetingUpdateDeliveryTransition(before, after)`,
  `readMeetingUpdateDeliveryCursor(cursor?)` and
  `writeMeetingUpdateDeliveryCursor(cursor)`.
- Extend history with optional `contentRevision`, `updateDelivery`,
  `updateDeliveryQueue` and `updateDeliveryDueAt`.

- [ ] Write tests named `notes edit preserves pending rename watermarks`,
      `request retains submitted attempt`, `completion acknowledges only captured parts`,
      `held state retains unsettled attempt`, `expired lease cannot authorize replay`
      and `legacy revisions remain zero and one`. Assert actual parsed state and transitions.
      Representative assertions for a rename followed by notes revision 2:

  ```ts
  expect(after.parts.notesBody).toEqual({ desired: 2, acknowledged: 0 });
  expect(after.parts.summaryTitle).toEqual(before.parts.summaryTitle);
  expect(after.progress).toEqual(before.progress);
  ```

- [ ] Run the new test file and record its expected feature-missing failure.
- [ ] Implement the minimal domain model. Use unions for policy, progress,
      provider operation and submission state. No contradictory optional-state bags
      or duplicated payload bodies.
- [ ] Run the new suite plus relevant history/processing type tests and typecheck.
- [ ] Run the scoped quality gate, commit, self-review and produce the task report.

### Task 2: Atomic persistence and discovery

**Files:** Create the focused delivery repository and its unit tests;
modify `src/db.ts`, `src/repositories/meetingHistoryRepository.ts` and mock
implementations; create
`test/deployment/meetingUpdateDelivery.integration.test.ts`.

**Consumes:** Task 1 schemas and transitions.

**Produces:**

- `getStrong(key, signal?): Promise<MeetingHistory | undefined>`.
- `updateContentAndDelivery(input: MeetingContentWrite, signal?): Promise<MeetingWriteResult>`,
  where input binds key, expected content revision, expected delivery token or
  absence, typed mutation, next delivery, mutation ID and timestamp.
- `MeetingWriteResult` is committed with returned history, or conflict.
- `listDue({ now, limit, cursor?, signal? }): Promise<{ keys; cursor? }>`.
- `claim({ key, expectedContentRevision, expectedDeliveryRevision, attempt, authority, signal }): Promise<"claimed" | "stale">`.
- `transition({ key, expectedDeliveryRevision, attemptId, ownerInstanceId, change, signal }): Promise<"applied" | "stale">`.
- `registerNotesPointers({ key, expectedContentRevision, expectedDeliveryRevision, attemptId, expectedPointers, nextPointers, signal }): Promise<"applied" | "stale">`.
- An injected Dynamo factory accepts a client and table names for real local
  integration tests; normal construction binds configured app dependencies.

- [ ] Write failing unit and real Dynamo tests for one content-plus-intent write,
      nonexistent-row rejection, legacy CAS, simultaneous save/worker transition,
      stale acknowledgments, exact claim ownership, pointer registration, sparse due
      pagination, malformed cursors and item-size rejection without partial changes.
      For a legacy row, strongly read actual Dynamo state after the action:

  ```ts
  expect(saved).toMatchObject({
    notes: "Edited",
    notesVersion: 2,
    contentRevision: 1,
  });
  expect(saved.updateDelivery.parts.notesBody).toEqual({
    desired: 1,
    acknowledged: 0,
  });
  expect(await readMissingMeeting()).toBeUndefined();
  ```

- [ ] Run unit tests and the integration command below; record expected failures.
- [ ] Implement field-specific conditional updates preserving current notes
      history, suggestion provenance and Delta removal. Require row identity,
      notes-version CAS for notes edits, content revision and delivery token.
      Return `ALL_NEW`; propagate unexpected errors.
- [ ] Use existing deployment admission transaction checks for claims. Strongly
      reread after discovery and unknown acknowledgments. Never expose a generic row
      patch or convert arbitrary errors into conflicts.
- [ ] Run both suites, existing history tests and typecheck; verify real Dynamo
      state, not command shape alone. Commit after the scoped quality gate.

Integration command:

```sh
DEPLOYMENT_TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:8000 yarn test:deployment:integration --runTestsByPath test/deployment/meetingUpdateDelivery.integration.test.ts
```

Use existing loopback-only integration setup and run-specific tables. Never use
cloud data or delete tables not created by this run.

### Task 3: Scoped rendering and pagination planning

**Files:** Create `src/services/meetingUpdatePlan.ts` and its tests; extract
shared merge/normalization helpers from recovery publication planning only
where both paths use them. Preserve the repair manifest approval boundary.

**Consumes:** Task 1 part watermarks and history, plus validated Discord messages.

**Produces:** `planMeetingUpdate(input): MeetingUpdatePlan`, returning captured
part revisions, immutable target/pointer identities, ordered PATCH/POST/register/
cleanup operations and compact before/desired fingerprints. Rendered provider
payloads remain local to a prepared execution, not copied into durable history.

- [ ] Write failing tests for a notes-only edit with a differing untouched
      summary, title-only rename with a pending notes body, shared summary warnings,
      preserved controls/attachments/unrelated embeds, multiple notes embeds in one
      post, Discord aggregate limits and unfamiliar layouts.
- [ ] Write growth/shrink tests proving surviving post IDs are reused and
      additions/removals affect only positively identified notes slots.
      Assert the proposed payloads, including an intentionally different summary:

  ```ts
  expect(proposedSummary).toEqual(beforeSummary);
  expect(proposedNotes.description).toBe(editedNotes);
  expect(mergedMessage.components).toEqual(beforeMessage.components);
  expect(outgoingPatch).not.toHaveProperty("components");
  ```

- [ ] Run the tests to establish the expected failure.
- [ ] Implement requested-part merging using current canonical fields and shared
      notice/notes builders. Body includes its version footer, required notice and
      pagination dependencies. Do not regenerate content.
- [ ] Preflight the complete plan before the first mutation. A missing saved
      target blocks, rather than becoming a POST fallback. Protected surplus posts
      require safe embed removal or a specific layout hold.
- [ ] Run new tests and existing recovery planner/editor/processing presentation
      tests; scoped lint, typecheck and quality gate; commit and report.

### Task 4: Durable provider execution and reconciliation

**Files:** Create `src/services/meetingUpdateDeliveryService.ts`, focused
execution/reconciliation helpers if needed, and service tests. Extend the
Discord transport for bounded signals, known rejection metadata and explicit
notes-only creation/deletion operations without changing existing callers.

**Consumes:** Task 2 repository and Task 3 plan.

**Produces:**

- `deliverMeetingUpdate({ key, work, signal }): Promise<MeetingDeliveryRunResult>`.
- `reconcileMeetingUpdate({ key, work, signal }): Promise<MeetingDeliveryRunResult>`.
- Results distinguish settled progress, retryable rejection, blocked state,
  uncertain effect and superseded work. They never claim a synced newer revision.

- [ ] Write failing tests using the real planner and state transitions with
      controlled provider boundaries. Cover crash before/after submitted marker,
      lost marker acknowledgment, definite 429, a crash after POST response before
      returned-ID persistence, unknown PATCH/POST, lost completion
      acknowledgment, stale content during a target loop and replayed work.
- [ ] Add reflow tests for returned new IDs before registration, lost pointer
      acknowledgment, supersession with created candidates, obsolete-ID cleanup
      and protected surplus messages.
      With a controlled HTTP boundary, inspect both remote content and durable state:

  ```ts
  expect(await readRemoteMessage()).toEqual(expectedPreservedMessage);
  expect(after.parts.notesBody.acknowledged).toBe(capturedRevision);
  expect(after.parts.notesBody.desired).toBe(newerRevision);
  ```

- [ ] Observe RED, then implement exact-claim checks and durable operation
      progress before every POST/PATCH/DELETE. Persist each returned POST ID before
      continuing. Register pointers before any obsolete-post cleanup.
- [ ] Read back edits and prove intended fingerprints. Suppress mentions and
      omit ordinary content/components/attachments from PATCH.
- [ ] For ambiguous effects do GET-only reconciliation. Lease expiry, a matching
      unrelated GET, or a nonce is not replay authorization. Preserve unknown POSTs
      without an ID as uncertainty holds. Do not issue a newer write over an
      unsettled older effect.
- [ ] Retire settled superseded attempts while carrying known created candidates
      into latest replanning. Preserve newer desired work on every completion.
- [ ] Run service, transport, planner and repository tests; typecheck, scoped
      lint/quality; commit and report.

### Task 5: Due index, worker and runtime lifetime

**Files:** Create worker and tests; modify `_infra/main.tf`,
`scripts/init-dynamodb.js`, `src/apps/bootstrap.ts`, runtime work domain/
admission/shutdown services and associated tests. Add index migration tests
following `test/scripts/renewalRecoveryIndex.test.ts`.

**Consumes:** Tasks 2 and 4.

**Produces:** `startMeetingUpdateDeliveryWorker(): void`,
`stopMeetingUpdateDeliveryWorker(): Promise<void>` and
`verifyMeetingUpdateDeliveryReadiness(): Promise<void>`.

- [ ] Write failing tests for immediate/nonoverlapping bounded polling, due
      pagination, stale GSI rows, two-owner contention, serving denial, lease loss,
      lost wakeup, restart, shutdown with a held provider tail and missing index.
- [ ] Write fresh/existing local-table index tests and Terraform/IAM assertions
      for exact names, `KEYS_ONLY`, no Streams and no broad permissions.
      Assert admitted work and actual effect settlement under the controlled clock:

  ```ts
  expect(admittedMeetingKeys).toHaveLength(25);
  expect(maximumConcurrentMeetings).toBe(2);
  expect(shutdownSettled).toBe(false);
  releaseHeldProviderResponse();
  await shutdown;
  expect(shutdownSettled).toBe(true);
  ```

- [ ] Observe RED, then implement the sparse index and idempotent local upgrade.
      Verify ACTIVE readiness before enabling the shared writers/worker. No Scan
      fallback. Keep Terraform application outside feature implementation.
- [ ] Register one REST worker through `whenRuntimeServing` in bootstrap for
      combined/API-only/bot-only modes. Use existing deployment admission and
      `ancillary_delivery` work accounting with a specific delivery domain.
- [ ] Poll using the exact Global Constraints budgets, jitter/backoff and two
      concurrent meetings. Renew claims without replacing immutable submission
      identity. Stop admission and await actual effect/promise tails at shutdown.
- [ ] Run worker/index/runtime lifetime and shutdown suites plus relevant
      deployment integration tests; typecheck, lint/quality; commit and report.

### Task 6: Shared action, caller migration and one publication owner

**Files:** Create `src/services/meetingUpdateService.ts` and tests; migrate
`meetingHistoryService.ts`, portal notes/import/correction/rename handlers,
Discord correction/rename commands and title helpers. Integrate initial target
registration/recovery eligibility, repair apply/reconcile and
`scripts/recover-meeting-artifacts.ts` with the shared barrier.

**Consumes:** Tasks 1–5. Use delivery-only repositories inside the worker.

**Produces:** `updateMeeting(input: MeetingUpdateActionInput): Promise<MeetingUpdateActionResult>`.
Input contains the existing key, authorized typed mutation, actor/provenance and
existing signal/RuntimeApiOperation ownership. Result uses `kind: "conflict"` or `kind: "saved"` with a public delivery-status
projection. The projection has a `status` field; domain state remains a
discriminated `progress` union, rather than duplicated status flags.

- [ ] Write failing action/caller tests for successful notes mutation, CAS
      conflict, rename, import, approved corrections and lost wakeup. Assert durable
      intent and zero remaining caller-owned Discord mutations.
- [ ] Assert Notion is called once after acknowledged notes+intent persistence,
      never on conflict/name-only/Discord retry; preserve existing opt-in and
      `assertNotionOutcomeKnown` behavior and interruption ownership.
- [ ] Write adoption/ownership tests for legacy unknown outcomes, explicit
      stored-only recovery holds, unsettled initial publication, overlapping repair
      apply, and initial pointer registration racing a newer edit.
      Assert canonical success independently of an intentionally held Discord send:

  ```ts
  expect(result.kind).toBe("saved");
  expect(await readCanonicalNotes()).toBe(editedNotes);
  expect(await readPublicDeliveryStatus()).toMatchObject({ status: "pending" });
  expect(await readRemoteNotes()).toBe(originalRemoteNotes);
  ```

- [ ] Observe RED, then implement the action and remove old Notion/Discord side
      effects from migrated service/callers in the same task. Keep authorization,
      generation, approval/token and teaching-context responsibilities unchanged.
- [ ] Keep legacy notes-version rules and existing Delta/provenance/history
      behavior. Rename requests both managed titles without bumping notes version.
- [ ] Make repair apply/reconcile use the same per-meeting barrier; preserve
      existing approved preview and durable receipt meanings. Do not create a
      second independent lock. Unknown legacy publishers remain held.
- [ ] Prevent broad artifact-repair PutItem from overwriting new canonical or
      delivery fields. Keep initial/personal/recovery generation ownership intact;
      updates become eligible only after initial publication is settled.
- [ ] Run action, portal, command, Notion interruption, recovery publication,
      initial delivery and personal/recovery ownership suites. Run integration
      races against real local Dynamo. Scoped quality, lint/typecheck; commit.

### Task 7: Delivery status, documentation and complete validation

**Files:** Existing meeting detail API/projection and frontend save/status
components, stories and tests; public feature docs, delivery/operator docs,
short ADR, AGENTS/copilot/README where material. Do not add an admin dashboard.

**Consumes:** Shared action result and durable delivery state.

- [ ] Write failing API/UI tests for saved+pending, synced, needs-attention and
      held states, with no raw provider messages or private channel details.
      Render the real status component with the saved-and-pending API fixture:

  ```tsx
  expect(screen.getByText("Saved. Updating Discord.")).toBeVisible();
  expect(
    screen.queryByText("Saved. Discord is up to date."),
  ).not.toBeInTheDocument();
  ```

- [ ] Implement the spec's compact save/delivery copy and expose desired/synced
      revision, last success and sanitized state. Reuse edit/operator permissions
      for retry or release-hold. Neither clears an unsettled attempt.
- [ ] Run covering component/router tests; capture Storybook screenshots and
      review them visually; cover changed user flow in Playwright.
- [ ] Document automatic updates, explicit holds, retry/uncertainty limits,
      index-before-code rollout and separate notification behavior. Add a short ADR
      with the repository's required headings and explain the no-Streams choice.
- [ ] Run full required lint, format, quality, TypeScript, unit/integration,
      docs and relevant UI/E2E checks. Do not run local Docker image builds unless
      separately requested; use repository CI for required image validation.
- [ ] Perform fresh whole-branch review, fix material findings through a
      subagent and scoped re-review, then create/update the draft PR with concise
      sanitized behavior and non-obvious validation/rollout limits.
- [ ] Follow the repository post-push audit and review-recycle workflow,
      including the five-minute late-comment audit before merge-ready claims.
- [ ] Hosted synthetic Sandbox acceptance follows an authorized Sandbox rollout
      and reviewed index setup. Do not claim it from unit tests or a merged PR.
      Do not deploy production or release any live publication hold.

## Verification commands

Use targeted tests during RED/GREEN, always recording exact command and result:

```sh
yarn test --runInBand --coverage=false --runTestsByPath TEST_FILES
yarn build
yarn check:quality
yarn lint:check
yarn prettier:check
yarn markdownlint:check
yarn test --runInBand
yarn docs:check
yarn test:e2e
```

Use `yarn run check` as the repository full gate where its side effects are
appropriate, respecting the explicit local-Docker-build restriction. Record
unavailable environment/external-service checks honestly rather than weakening
tests or adding exception labels.

## Preflight interface scan

Copy this table into the SDD ledger and confirm against the final plan before
Task 1. Any implementation ruling must preserve the approved spec.

| Tasks | Shared interface or file                  | Expected relationship                                                          |
| ----- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| 1 / 2 | Delivery state, tokens and history fields | Repository validates the exact domain model and independent delivery CAS token |
| 1 / 3 | Part watermarks and captured revisions    | Scoped plan acknowledges only requested captured parts                         |
| 2 / 4 | Claims, transitions and pointer CAS       | Executor has no unrestricted write escape hatch                                |
| 3 / 4 | Immutable operation plan and fingerprints | Known results advance operations; unknown results do not replay                |
| 2 / 5 | Due query and readiness                   | Bounded GSI discovery followed by strong base-row checks                       |
| 4 / 5 | Actual effect lifetime                    | Worker shutdown waits for owned effects; lease timeout is not settlement       |
| 2 / 6 | Canonical action and atomic write         | Save never commits without the corresponding intent                            |
| 4 / 6 | Repair/initial/worker ownership           | One common barrier precedes every competing publication path                   |
| 5 / 6 | Runtime ownership and wakeups             | Durable index is authoritative; in-memory wakeup is optional                   |
| 6 / 7 | Public save/delivery status               | Canonical success does not falsely acknowledge Discord delivery                |

Each task's named tests, code, files and outputs are consistent with its stated
deliverable. New implementation details may refine internal helpers without
changing the approved behavior or dropping a verification requirement.
