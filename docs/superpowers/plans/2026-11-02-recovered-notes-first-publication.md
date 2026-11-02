# Recovered Notes First Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver repeatable preview, approve, apply and read-only status/reconcile commands for recovered notes, automatically skipping archived meetings.

**Architecture:** Extend the existing operator CLI with a separate first-publication mode, reusing notes rendering, private artifacts and publication ownership. Conditional meeting and deployment-control transactions exclude archive races and incompatible rollbacks. Durable per-message intent supports pagination and approved resolution without duplicate POSTs.

**Tech Stack:** Node.js 24.22.1, TypeScript, Zod, existing AWS SDK v3 clients, Discord REST, Jest and the existing deployment coordinator. No new package or service.

**Spec:** [Approved design](../specs/2026-11-02-recovered-notes-first-publication-design.md), approved in this chat after revision commit `c8ab4d8d`.

## Global constraints

- Production is read-only during implementation and local verification. Production deployment and exact-preview publication require separate authorization.
- Support 1 to 25 selections per batch. Meeting identities are data, never an October allowlist.
- Archived rows skip before Discord/source-artifact checks or claims. Verified prior publication is a successful no-op.
- Preserve approved text, language, version, capture warnings, uncertainty, import provenance, archive state and access. No audio retrieval or text generation.
- Use existing pagination; bind every message and ordered page. Send notes only to the stored destination with `allowed_mentions: { parse: [] }`.
- Keep automatic delivery and Notion held. No summary, notification, start-post edits, delete, force-clear or automatic retry of an uncertain POST.
- Preview/status/reconcile write only private local artifacts. Only digest-approved apply mutates providers, including resolution plans.
- Keep old editor preview digests and PATCH-only authority compatible. No portal UI changes.
- Treat runtime compatibility as automatic command behavior and a release responsibility, not a per-run human checklist.

## Review focus

1. A selection repeats the same meeting through both a key and bundle reference: deduplicate identical references, reject contradictory ones (Task 1).
2. A newer supported release is unknown to an older operator tool: report tool-update/runtime blocker, never request per-meeting code edits (Task 4).
3. A skipped meeting is unarchived after approval: never add it to apply; refresh is required (Task 2).
4. Page one verifies and page two is rejected: preserve authority and verified IDs; do not retire the meeting as unpublished (Task 5).
5. Final registration committed but its response was lost: strong readback yields a verified/no-op result without resending (Tasks 3 and 6).

## Preparation and file responsibilities

Execute in an isolated `codex/` worktree using the worktree skill. Preserve existing
uncommitted importer files and helper exports in the source checkout. Before
branching, record a scoped checkpoint or transplant only the required approved
source dependencies; do not sweep unrelated `.worktrees/` or incidental changes
into a commit. The existing importer defines version-2 provenance; do not invent a
different format. Customer data and private operator profiles stay outside Git.

| File(s)                                                   | Responsibility                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| New `src/services/firstPublicationTypes.ts`               | Strict selection, source, plan, receipt and result contracts        |
| New `src/services/firstPublicationSource.ts`              | Recovery-v2 adapter, profiles and source/hash binding               |
| New `src/services/firstPublicationPlan.ts`                | Pure classification/rendering and exact payload plan                |
| New `src/repositories/firstPublicationRepository.ts`      | Conditional intent, pin/claim and settlement persistence            |
| New `src/services/firstPublicationRuntime.ts`             | Automatic serving-cohort/release compatibility inspection           |
| New `src/services/firstPublicationService.ts`             | Apply, status and read-only reconciliation orchestration            |
| Existing publication, deployment and archive modules      | Shared ownership checks, transaction builders and archive conflicts |
| Existing CLI plus new `scripts/first-publication-cli.ts`  | Separate argument routing, private output and stable exit codes     |
| New `scripts/operator/recovery-publication-releases.json` | Supported immutable build digests and capability contract           |
| New `docs/operations/recovered-notes-publication.md`      | Installed workflow and ordinary blocker remedies                    |

Use the existing storage/private-file abstractions where their contracts fit.
Keep customer-facing output in the notes renderer, not in repository code. Split
the service only if needed to keep provider effects separate from pure planning;
do not add parallel implementations of shared primitives.

Commands below assume Node 24 is on PATH and locked dependencies are installed.
Use `node node_modules/jest/bin/jest.js --runInBand --coverage=false --roots test`
with the listed `--runTestsByPath` files, avoiding unrelated worktree discovery.

## Task 1: Define reusable contracts and the supported source adapter

**Files:** Create `firstPublicationTypes.ts`, `firstPublicationSource.ts` above and `test/services/firstPublication.fixture.ts`, `test/services/firstPublicationSource.test.ts`.

**Interfaces:** Export `PublicationSelection`, `PublicationProfile`, `BoundRecovery`,
`FirstPublicationPlan`, `FirstPublicationReceipt`, `PublicationResult` and
`FirstPublicationDependencies`. Selection is a strict union of meeting-key entries
and an import-bundle reference, normalized to 1..25 unique meeting keys. Profile
contains account/region/table/bucket, deployment control scope, archive-writer
service scopes and credential references, never secret values. BoundRecovery
contains the selected key, row, recovery/manifest identity, source hashes and
source-binding digest. Plan operations are `publish`, `finalize`, `release` or
`continue`, with frozen skips, before-bindings, ordered payloads and a digest.
Receipt records run identity, stable meeting/recovery/version authority, generation
and per-message state (`prepared`, `submitted`, `rejected`, `verified`, `uncertain`).

Produce `normalizePublicationSelection(input: unknown, bundles: ReadonlyMap<string, unknown>): PublicationSelection` and
`bindFirstPublicationSource(profile: PublicationProfile, row: MeetingHistory,
manifest: unknown, objects: { notes: string; transcript: string }): BoundRecovery`.
The CLI resolves referenced local bundle files into the supplied map before
normalization; this pure function performs no file or network access.
Fixtures export `firstPublicationFixture(overrides?)`, returning typed synthetic
rows/manifests/objects, fake dependencies and call trace for all later tests.

- [ ] Write boundary tests, including:

  ```ts
  expect(
    normalizePublicationSelection(sameMeetingViaKeyAndBundle, bundles),
  ).toHaveLength(1);
  expect(() =>
    normalizePublicationSelection(conflictingReferences, bundles),
  ).toThrow();
  expect(() =>
    normalizePublicationSelection(twentySixMeetings, bundles),
  ).toThrow();
  expect(
    bindFirstPublicationSource(profile, row, manifest, objects).notesSha256,
  ).toBe(row.operatorRecovery.notesSha256);
  ```

  Build fixture inputs explicitly in this test file. Cover null prior artifacts,
  unsupported format, wrong scope/path/hash, malformed archive values and no
  synthesized legacy fields. Do not import real recovery content.

- [ ] Run `--runTestsByPath test/services/firstPublicationSource.test.ts`; confirm the missing adapter fails before implementation.
- [ ] Implement the strict contracts/adapter using existing Zod, stable JSON and hash helpers. Load known profiles from private operator configuration with validated fields; keep known environment selection separate from recovery data.
- [ ] Rerun that file; require all cases green and secret-free errors.
- [ ] Commit only this task's source and tests: `feat: define first-publication source contracts`.

## Task 2: Build read-only preview and deterministic pagination

**Files:** Create `src/services/firstPublicationPlan.ts`, `test/services/firstPublicationPlan.test.ts`. Reuse `src/utils/meetingNotes.ts` and existing embed-limit validation unchanged unless a focused defect requires correction.

**Interfaces:** Consume Task 1 contracts. Produce
`previewFirstPublication(selection: PublicationSelection, deps: FirstPublicationDependencies): Promise<FirstPublicationPlan>` and
`firstPublicationDigest(plan: FirstPublicationPlan): string`.
Dependencies separate read capabilities from mutating repository/transport methods.
Plan results classify each meeting as ready, skipped-archived, already-published
or blocked, plus one batch readiness outcome. Render title `Recovered notes | UTC
<ISO meeting timestamp>`, existing warning-bearing embeds and the canonical portal
link button. Every message payload is part of the digest.

- [ ] Write failing preview tests with fake provider write methods that throw.
      Assert archived rows trigger zero Discord/object reads; all archived succeeds
      without runtime inspection. Verify immutable exact text, safe mentions, warnings,
      languages, multi-message order/limits and compact blocker output. Pin scope:

  ```ts
  expect(plan.meetings.find((m) => m.key === archivedKey)?.outcome).toBe(
    "skipped_archived",
  );
  expect(applySelectionFromPlan(plan, nowUnarchivedRows)).not.toContain(
    archivedKey,
  );
  ```

  `applySelectionFromPlan` is a test-local projection of frozen eligible keys, not
  another production API. Block an eligible missing-permission row rather than
  silently dropping it. A start post is optional and nearby unrelated notes are
  not adopted. Verify prior-publication GET evidence before `already_published`.

- [ ] Run `--runTestsByPath test/services/firstPublicationPlan.test.ts`; confirm red.
- [ ] Implement preview with archived-first classification, source binding, existing rendering/batching and digest-bound skips/record changes. Parallelize independent reads; save no cloud artifacts. Expose duplicate-search bounds in private detail, with exact-meeting ambiguity blocking.
- [ ] Rerun source/plan tests; require deterministic plans with fixed fixture time and zero provider writes.
- [ ] Commit: `feat: preview recovered notes first publication`.

## Task 3: Add conditional publication persistence and archive exclusion

**Files:** Create `src/repositories/firstPublicationRepository.ts`, `test/repositories/firstPublicationRepository.test.ts`. Modify `src/types/meetingPublication.ts`, `src/repositories/meetingPublicationRepository.ts` only for reusable ownership integration; `src/db.ts` (`updateMeetingArchive`), `src/repositories/meetingHistoryRepository.ts`, `src/services/meetingHistoryService.ts`, `src/trpc/routers/meetings.ts`. Add pin types/builders to `src/types/deploymentControl.ts` and `src/services/deploymentControlTransactions.ts`. Extend `test/services/meetingPublicationOwnership.test.ts`, `test/services/meetingHistoryService.test.ts` and add `test/trpc/firstPublicationArchive.test.ts`.

**Interfaces:** Export `FirstPublicationRepository` with
`getStrong(key)`, `readAttempt(authorityKey)`,
`acquire(input: AcquireFirstPublication): Promise<"owned" | "stale">`,
`recordPage(input: RecordFirstPublicationPage): Promise<"applied" | "stale">`,
`settleVerified(input: SettleFirstPublication): Promise<"applied" | "stale">`,
`settleUnsent(input: SettleUnsentPublication): Promise<"applied" | "stale">`, and
`transferStoppedRun(input: TransferStoppedPublication): Promise<"owned" | "stale">`.
Define these request types in this module, binding exact owner, row/source/receipt
revisions, page evidence and expected pin state, with no optional bypass flag.
`PublicationArchiveConflict` is a typed repository/service error mapped to tRPC
`CONFLICT`; preserve the existing not-found result for an absent row.
Also export transaction builders `buildPublicationPinAcquisition(input, tables)`,
`buildPublicationPinSettlement(input, tables)` and
`buildIncompatiblePublicationTransition(input, tables)` returning DynamoDB
`TransactWriteItem[]`. Their exported request types carry observed control
generation, stable run pin, selected/settled meeting keys and expected transition.
This task defines and tests the primitives; Task 4 wires actual coordinator/runtime
callers. Avoid duplicate operations on one control item in a transaction.

- [ ] Write conditional-store tests for two preview digests sharing one authority,
      exact source/owner mismatch, register+acknowledge+settle atomicity, preserved
      stored-only/Notion holds and real/mock parity. Add archive-before-acquire and
      acquire-before-archive cases and explicit tRPC conflict propagation. Pin lost ack:

  ```ts
  expect(await repo.settleVerified(inputWithLostAcknowledgement)).toBe(
    "applied",
  );
  expect(await repo.getStrong(key)).toMatchObject({
    notesMessageIds: verifiedIds,
  });
  expect(fakeDiscordPosts).toHaveLength(0);
  ```

  A fixture commits the write then throws an acknowledgement error; the repository
  must read back rather than replay. `settleUnsent` rejects successful/uncertain
  pages. Transfers require exact stopped-run evidence, not a stale heartbeat.

- [ ] Run the new repository/archive tests and existing ownership/service tests; confirm new cases fail.
- [ ] Implement conditional transitions, durable page evidence and archive conflict. Keep legacy snapshot/digest semantics unchanged using a separate versioned first-publication binding. Bound item/condition sizes and never replace a whole row. Atomically include this task's pin acquisition/last-settlement fragments with the meeting claim/settlement. No pinless fallback.
- [ ] Rerun the focused tests against both mock and real transaction-request assertions.
- [ ] Commit: `feat: persist first publication and fence archive changes`.

## Task 4: Automate runtime compatibility and serialize unsafe deployments

**Files:** Create `src/services/firstPublicationRuntime.ts`, `scripts/operator/recovery-publication-releases.json`, `test/services/firstPublicationRuntime.test.ts`. Modify `src/types/deploymentControl.ts`, `src/services/deploymentControlTransactions.ts`, `src/repositories/deploymentControlRepository.ts`, `scripts/deployment/coordinator.cjs`, `scripts/deployment/production-coordinator.cjs` and relevant recipe entry points. Extend `test/scripts/deploymentCoordinator.test.ts`, `test/deployment/controlTransactions.integration.test.ts`; add `test/deployment/firstPublicationFence.integration.test.ts`.

**Interfaces:** Produce
`inspectFirstPublicationRuntime(profile: PublicationProfile, deps: RuntimeReadDependencies): Promise<RuntimeCompatibility>`.
RuntimeCompatibility is a discriminated compatible/blocker result with observed
control generation, cohort image digests and contract name. Reads use SDK clients
or injected AWS callers, not shell-built credentials. Consume Task 3's pin and
incompatible-transition builders; wire them into shared deployment entry points.
Define RuntimeReadDependencies as injected read-only control/ECS/release-metadata
operations with explicit pagination and no mutation capability.

- [ ] Write tests proving all archive-writer services/tasks are inspected, including
      replacing/legacy/unknown tasks, cohort drift and read failure. A newer unknown
      digest returns an actionable tool-update blocker. Use synthetic release metadata,
      never fabricated live compatible digests. Assert mutually exclusive ordering:

  ```ts
  expect(
    await store.acquirePublicationAndReserveIncompatibleDeployment(),
  ).toEqual(expect.arrayContaining(["owned", "stale"]));
  expect(store.bothAuthoritiesCommitted()).toBe(false);
  ```

  These are test-local interleaving helpers around actual generated transactions.
  Include both orderings, compatible rollout with pins, partial settlement,
  uncertainty/no TTL release and authority transfer without a release gap.

- [ ] Run new runtime/fence tests and `test/scripts/deploymentCoordinator.test.ts`; confirm red. Integration tests use the existing local Dynamo harness/config, never production.
- [ ] Implement capability `first_publication_archive_fence_v1`, maintained immutable-image release metadata and stable-cohort inspection. Reserve incompatible transitions before any supported rollout/rollback runtime mutation; add the check at shared coordinator entry points and test every caller. Ensure old control rows parse with no pins, preserving unrelated deployment behavior. Because control-record parsers are strict, compatibility must also include every serving control-record reader (bot/API/coordinator as applicable), not just archive writers; admit no publication pins while old readers could reject the new optional fields.
- [ ] Integrate Task 3 builders, run focused unit tests and local deployment integration tests with `jest.deployment-integration.config.ts`. Require one winner in each race and unchanged generation/ownership protections.
- [ ] Commit: `feat: gate first publication on compatible serving runtimes`.

## Task 5: Implement guarded sends and paginated apply

**Files:** Create `src/services/firstPublicationService.ts`, `test/services/firstPublicationApply.test.ts`. Add `createFirstPublicationTransport` to `src/services/discordMessageEditor.ts`; extend `test/services/discordMessageEditor.test.ts`. Consume Tasks 1..4 rather than creating a second persistence path.

**Interfaces:** Produce
`applyFirstPublication(plan: FirstPublicationPlan, expectedDigest: string, deps: FirstPublicationDependencies): Promise<PublicationResult>`.
Transport exposes only `getBotIdentity`, `getChannel`, `getMessage` and
`createNotesMessage({channelId, payload, signal})`; payload includes all approved
embeds/components and safe mentions. No PATCH, DELETE, retry or redirect support.
Implement timeouts with the existing bounded-provider pattern; use 15 seconds
for each Discord request, explicit AWS region/owner and `maxAttempts: 1`.

- [ ] Write failing apply tests: tampered digest/payload, all-target preflight,
      archive/content/runtime drift, concurrent previews, definite rejection, lost
      response/receipt, late completion, wrong returned author/channel and partial
      batching. Pin the pagination regression:

  ```ts
  expect(result.meetings[0].outcome).toBe("partial");
  expect(await repo.readAttempt(authorityKey)).toMatchObject({
    ownerState: "running",
  });
  expect(trace.posts).toHaveLength(2); // verified page one, rejected page two
  expect(trace.settleUnsent).toHaveLength(0);
  ```

  Define `partial` as a machine outcome distinct from uncertain and include it in
  PublicationResult. Verify no future page sends after uncertainty and no
  publication pin release while any selected claimed meeting remains unresolved.

- [ ] Run `--runTestsByPath test/services/firstPublicationApply.test.ts` plus the transport suite; confirm red.
- [ ] Implement regenerated approved payload, mutable preflight, atomic authority,
      per-page submission evidence, POST then GET verification, final conditional
      registration and compact results. Classify only definite rejecting responses
      as no-send evidence; timeout/5xx/lost JSON/unknown acknowledgements remain uncertain.
      On a known pre-send abort, settle only exact owned zero-success work; never
      retire partially successful meetings as unpublished.
- [ ] Rerun Task 1..5 focused suites. Require zero duplicate POSTs and zero PATCH/DELETE calls, safe no-op reruns and accurate partial results.
- [ ] Commit: `feat: apply approved first-publication plans safely`.

## Task 6: Build read-only status and approval-ready resolution

**Files:** Extend `src/services/firstPublicationService.ts`, `firstPublicationPlan.ts` and contracts; create `test/services/firstPublicationReconcile.test.ts`.

**Interfaces:** Produce
`statusFirstPublication(plan: FirstPublicationPlan, deps: FirstPublicationDependencies): Promise<PublicationResult>` and
`reconcileFirstPublication(plan: FirstPublicationPlan, deps: FirstPublicationDependencies): Promise<{ result: PublicationResult; resolution: FirstPublicationPlan | null }>`.
Resolution uses the same strict plan envelope/digest for `finalize`, `release` or
`continue`; `applyFirstPublication` dispatches those typed operations, never a
free-form patch. Evidence of a stopped run is exact run identity plus a recorded
process exit or provider task STOPPED observation, not operator silence/elapsed
time. Missing evidence yields an actionable blocker, without automatic release.

- [ ] Write failing tests with all repository writes and Discord POSTs prohibited
      during status/reconcile. Cover registration-ack loss returning already-published,
      known-ID finalization, zero-success release and multi-page continuation that
      excludes verified page IDs. Negative history search or stopped-run evidence
      alone cannot resolve an uncertain lost-ID POST. Transfer requires stopped-run
      proof plus unchanged owner/receipt and retains the existing pin.
- [ ] Run `--runTestsByPath test/services/firstPublicationReconcile.test.ts`; confirm red.
- [ ] Implement inspection and exact resolution plans. Apply revalidates positive
      evidence and performs only the approved operation. Continue sends only
      positively unsent pages, after verifying every retained successful page. A
      finalize/release plan performs zero Discord writes. Do not allow a resolution
      to change the stored destination or silently refresh approved content.
- [ ] Rerun apply/reconcile/repository tests; require correct read-only no-ops after uncertain registration responses and no resend of verified pages.
- [ ] Commit: `feat: reconcile interrupted first publication through approved plans`.

## Task 7: Wire the installed operator command and private output

**Files:** Create `scripts/first-publication-cli.ts`, `scripts/tsconfig.first-publication.json`, `test/scripts/firstPublicationCli.test.ts`, `docs/operations/recovered-notes-publication.md`. Modify `scripts/publish-recovered-meeting.ts` only to dispatch `first-publication`; retain its existing interface. Reuse existing owner-only artifact helpers; carry their existing export changes as a scoped dependency if absent in the execution branch.

**Interfaces:** Produce `runFirstPublicationCli(args: string[], deps: FirstPublicationCliDependencies): Promise<number>`; injected connector returns Task 1 dependencies lazily. Commands and flags are exactly those in the approved design's four example commands. `preview` selection accepts keys or an existing bundle reference. `status/reconcile` use the saved plan; apply accepts only the saved plan and digest, with no scope/payload override.

- [ ] Write failing process-level CLI tests with synthetic profiles, local HTTP
      and fake AWS: repeat runs for different keys/languages and paginated notes;
      all archived needs no Discord credential/runtime connection; preview and
      reconcile forbid all cloud writes; secret values/raw payloads never reach
      console. Verify private file ACL behavior and legacy CLI argument compatibility.
      Pin exit codes: 0 success/no-op, 1 invalid arguments/unsupported format, 2 ordinary
      blocked, 3 partial/uncertain. Outcomes identify which case and next action.
- [ ] Run `--runTestsByPath test/scripts/firstPublicationCli.test.ts test/scripts/publishRecoveredMeeting.test.ts`; confirm red for new routing.
- [ ] Wire lazy connectors, environment/profile validation, strict args, compact
      output and private `preview.json`, `preview.html`, `digest.txt` plus inspection
      result/resolution files. Save artifacts even for a normal blocker. Document
      installed commands, pagination, no-op, refresh/tool-update remedies and the
      archive/uncertainty tradeoff. Keep deployment acceptance details separate from
      the operator's normal three-step flow.
- [ ] Run both CLI suites and `node node_modules/typescript/bin/tsc -p scripts/tsconfig.first-publication.json`; require successful compile and no provider writes in read-only modes.
- [ ] Commit: `feat: expose repeatable recovery publication operator commands`.

## Task 8: Verify the integrated workflow and hand off runtime acceptance

**Files:** Add `test/deployment/firstPublicationWorkflow.integration.test.ts` and
synthetic fixtures beside it. Update the operator runbook with acceptance commands
and results only after they are obtained. Release workflows
`.github/workflows/deploy.yml` and `deploy-staging.yml` must use Task 4 guarded
coordinator paths and package maintained release metadata; add assertions to the
existing deployment-coordinator suite if a workflow change is needed.

- [ ] Add an end-to-end local scenario: batch with two unarchived and one archived
      synthetic meeting, one paginated body; preview writes nothing, approved apply
      publishes/registers, rerun is a no-op. Repeat with different meeting keys using
      unchanged installed profiles/tool code. Add interrupted send and approved
      continuation/finalization scenarios without scripts or PR changes.
- [ ] Run the scenario through the existing local Dynamo integration harness and
      fake/local Discord HTTP. Verify ordered pointers, original row preservation,
      held automatic/Notion state and zero archived message calls.
- [ ] Run focused suites, relevant existing publication/deployment/archive tests,
      TypeScript build, ESLint on touched files, Prettier check and `git diff --check`.
      Run deployment integration with its own config rather than the general Jest
      runner. Fix failures; do not broaden testing after green without a new concern.
- [ ] Review the complete branch for source-boundary validation, old-editor
      compatibility and concurrency/acknowledgement handling. Record local verification
      honestly. Commit integrated tests/docs: `test: verify repeatable publication workflow`.
- [ ] Prepare a separate synthetic Sandbox acceptance run using the installed
      command, compatible serving archive writer and deployment interleavings. Follow
      existing Sandbox deployment authority, verify current ownership, and retain
      private receipts. This is future execution work, not performed during planning.
- [ ] Stop before production deployment or apply. Present exact deployment scope
      and later real publication previews under their separate approvals. Production
      preview remains read-only, with archived Oct 14 skipped automatically.

## Self-review and execution handoff

For Task 3, the exact focused verification is:

```text
node node_modules/jest/bin/jest.js --runInBand --coverage=false --roots test --runTestsByPath test/repositories/firstPublicationRepository.test.ts test/trpc/firstPublicationArchive.test.ts test/services/meetingPublicationOwnership.test.ts test/services/meetingHistoryService.test.ts
```

For Task 4, run the unit suites with the same runner and
`--runTestsByPath test/services/firstPublicationRuntime.test.ts test/scripts/deploymentCoordinator.test.ts`.
For local integration, set `DEPLOYMENT_TEST_DYNAMODB_ENDPOINT` to the running
loopback-only Dynamo endpoint required by the existing harness, then run:

```text
node node_modules/jest/bin/jest.js --config jest.deployment-integration.config.ts --runInBand --runTestsByPath test/deployment/firstPublicationFence.integration.test.ts test/deployment/controlTransactions.integration.test.ts
```

Task 8 uses that integration command with
`test/deployment/firstPublicationWorkflow.integration.test.ts`. Missing local Dynamo
is a local setup prerequisite, not evidence about production. Run no integration
suite against a cloud endpoint. Passing output is all selected suites/tests green;
a skip or unexecuted scenario is not acceptance.

Coverage: Tasks 1/2 own source/preview/no-op behavior; 3/4 own archive and deployment
exclusion; 5 owns sends/pagination; 6 owns read-only resolution; 7 owns the reusable
operator interface; 8 owns whole-workflow acceptance. The five review-focus cases
are assigned above. No separate per-recovery verification project or manually
approved runtime evidence bundle is planned.

This is one dependent feature, not independent subsystem projects: the CLI cannot
publish safely before its ownership and archive/deployment contracts exist.
Recommended execution is **Native** in the isolated branch, task-by-task with a
whole-branch independent review, because these interfaces and transactions are
tightly coupled. Subagent-driven implementation remains an alternative if the
user prefers per-task independent review.

Plan status: ready for user review. No implementation, provider access, deployment
or publication has run as part of writing it. Implementation must use the selected
execution skill after plan review and execution-method selection.
