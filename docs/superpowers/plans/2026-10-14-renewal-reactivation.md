# Renewal reactivation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authorized payer turn renewal back on for the same paid subscription after seeing its verified date and rate, while keeping cancellation, payment history and terminal repurchase understandable.

**Architecture:** A focused renewal service owns eligibility, a signed consent quote and a minimal Stripe update. Namespaced operation/control records in the existing GuildSubscription table preserve duplicate and timeout recovery. The existing reconciliation service remains authoritative for access; unsupported states use the existing payer-checked portal.

**Tech stack:** Node.js 24.15.0, TypeScript, tRPC/Zod, Stripe SDK pinned to API `2026-07-29.dahlia`, DynamoDB, React 19/Mantine, Jest, Storybook and Playwright.

**Spec:** [Turn subscription renewal back on](../specs/2026-10-14-renewal-reactivation-design.md). Read it before executing. BASIC approved local implementation and separately authorized new owned Stripe Sandbox fixtures on October 14. Both new gates remain false. Deployment and activation are separate.

## Implementation status (October 15)

Local consent/storage, protected renewal API, Billing UI and lifecycle producers are implemented. The latest full Jest result is 278 suites and 2,271 tests passed. The complete affected browser run passed 78 checks: 48 Billing, eight renewal and 22 responsive/scroll checks without baseline updates. Forty-two affected Storybook stories passed. Storybook captures and Playwright snapshots were visually reviewed, including the failed-payment state.

Owned native proof passed 16 supported cases and one read-only portal check, with six expected direct-route exclusions and nine retained controller failures. Every created fixture was cleaned up. Manual inclusive/exclusive tax is covered; this is not nonzero automatic-tax acceptance.

New event producers remain disabled. The verified Chronote PostHog project has no rows for the eight new events in the last seven days. This is no ingestion acceptance claim. Existing onboarding and purchase insights were found; saved loss views were not created. Signed-in deployed-app acceptance remains pending separate deployment and flag activation.

The operation’s financial consent binding remains immutable. A later DNT opt-out can only widen suppression while an operation is unresolved; it can never clear suppression. Private invoice deduplication markers retain 400 days of coverage and become eligible for deletion afterward.

## Global constraints

- Use **Renewal off**, **Turn renewal back on**, **Payment history** and **View invoices and receipts** as specified. Do not use em dashes or the word upfront.
- Preserve the same subscription/item/customer, billing mode, paid period, anchor, price, quantity, discounts, account balance and offer-use records. No unintended immediate invoice, payment, charge or proration.
- Show authoritative renewal date, recurring rate and tax basis before consent. Keep any valid remaining offer; never restart one.
- Keep Manage Server and original-payer checks. A manager who is not the payer cannot restore or manage the existing subscription. Terminal repurchase retains the existing Checkout authorization and may use a new payer without granting access to the old billing account.
- Use `2026-07-29.dahlia`; verify effective API headers in native acceptance. Never use the paused-subscription resume endpoint.
- Use separate default-false `STRIPE_RENEWAL_REACTIVATION_ENABLED`. It must not enable hosted plan switching or prevent reconciliation of a previously submitted renewal operation.
- Keep uncertain outcomes recoverable. No fallback Checkout for a nonterminal subscription, no customer-wide lock and no schedule release.
- Preserve the centered Monthly/Annual selector, Upgrade comparison, existing complimentary access and current payment-failure entitlement policy.
- Native proof uses new owned Sandbox fixtures only, with separate execution authorization and cleanup. Never mutate the already cleaned parent test subscription.
- Implement only the approved analytics contract in [Product lifecycle analytics](../../purchase-analytics.md#three-lifecycle-funnels). Keep the two-identifier limit, fixed enums, bounded maturity duration and opt-outs. New capture is behind the separate default-false BILLING_LIFECYCLE_ANALYTICS_ENABLED gate; no production setting or saved PostHog view changes are authorized by this plan review.

## Review focus

These are review priorities, not omitted tests. Each is pinned to a task below.

1. A custom cancellation can shorten item period end. Equal dates alone must not qualify it for direct reactivation. Task 1 and Task 3 verify the independent paid boundary.
2. A timed-out request can have succeeded. An expired quote or a new button click must not create a second operation. Task 2 and Task 3 verify durable recovery.
3. An external portal/admin edit can race the final read. Task 1 and Task 3 must detect drift and avoid false success or destructive compensation.
4. A valid remaining discount, inclusive tax or account balance can differ from the sample. Task 1, Task 3 and Task 4 verify truthful rate copy and preserved billing state.
5. A server manager can view the plan without being its payer. Task 3 and Task 4 must preserve read access while denying writable actions and receipt-account access.

## Delivery order and ownership

| Task | Reviewable result                                                              | Dependency                                                   |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1    | Accepted native update contract, or evidence that blocks the direct route      | Separate Sandbox execution authority                         |
| 2    | Typed consent, durable operation storage and disabled-by-default configuration | Spec; can prepare locally while native proof is pending      |
| 3    | Protected API with recovery of the same operation and authoritative readback   | Task 1 must accept the candidate before connecting its write |
| 4    | Revised Billing card and payment history, with responsive proof                | Task 2 contract; fixtures can precede Task 3                 |
| 5    | Loss/recovery telemetry with privacy and event-row proof                       | Tasks 2/3; Task 4 for browser visibility and clicks          |
| 6    | Integrated checks, docs and exact-head review packet                           | Tasks 1 through 5                                            |

This is one narrow feature. It does not implement the separate plan-switching payment adapter or editable subscription schedules.

## Task 1: Prove the native reactivation contract

**Files:**

- Create in private ops: `evidence/2026-10-14-renewal-reactivation/README.md` and `results.json`.
- Create in private ops: `evidence/2026-10-14-renewal-reactivation/renewal-reactivation-probe.ps1`, a scoped on-demand fixture controller with `-BillingMode classic|flexible` and `-Case <case>`.
- Update the existing private billing owner note with the result pointer. Do not copy provider identities or raw receipts into product docs.

**Interfaces:**

- Consumes the pinned Stripe API, authorized Sandbox route and new owned fixtures.
- Produces a sanitized accepted request contract for `clearPendingCancellation` in Task 3, plus private per-case snapshots and cleanup results.

- [x] **Step 1: Establish scope before creating a fixture.** Read private ops instructions, the Dev/Sandbox runbook and existing billing evidence. Discover the intended tool route; use only its recorded fallback after reporting a route failure. Verify account, test mode and effective API. Stop if execution authority or private identity evidence is absent. Do not run this task merely because the plan exists.
- [x] **Step 2: Build a failing acceptance packet.** Cases must assert the required result, not an HTTP 200 response alone. Include classic period-end flag, flexible dated cancellation, annual introductory history with regular renewal, remaining monthly discount, inclusive/exclusive tax, repeat request, cancel-again, lost response, pending payment, custom date, schedule and a concurrent native edit.

```text
acceptedUndo:
  same subscription, item, customer and mode
  cancellation cleared; natural paid boundary and anchor unchanged
  same price, quantity, discounts, balance and offer-use records
  invoice/payment-intent/charge sets unchanged by undo
  no proration item created
```

- [x] **Step 3: Prove the read-only preview before the write.** Preview the cancellation removal on the same subscription. Verify the next recurring service rate, cadence, tax basis and boundary. Reject unsupported lines or schedules. Preview must create no persisted invoice or payment. A zero-cash application invoice is not independent proof of the paid-service boundary.
- [x] **Step 4: Test only the minimal candidate.** Classic candidate: `cancel_at_period_end=false, proration_behavior=none`. Flexible candidate: `cancel_at='', proration_behavior=none`. Supply no items, price, discounts, anchor or payment parameters. If the pinned API requires a different request, record the mismatch and revise the spec before implementation.
- [x] **Step 5: Verify native readback and legitimate renewal.** Compare complete before/after inventories. Replay the same request/key, cancel again and verify an old completed operation is not reissued. Advance an owned test clock to the real renewal, then verify its invoice and applicable discount. Exercise an externally changed price/date/schedule and record whether drift is detected. An unexpected immediate charge or changed anchor fails acceptance.
- [x] **Step 6: Verify fallback and clean up.** Read the actual portal configuration and test the claimed general-management recovery without changing shared/default settings. Record cases requiring support rather than promising schedule editing. Clean up only owned fixtures, then reconcile every held resource. Preserve historical invoices and the previously cleaned parent subscription.
- [x] **Step 7: Save proof through the private repo policy.** The probe is executable research, so its reusable source uses a topic branch/PR there. Commit only intended files. Record pass, rejected and unverified cases separately. No activation follows from passing proof.

## Task 2: Define consent and operation storage

**Files:**

- Create: `src/types/renewal.ts`, `src/services/renewalQuote.ts`, `src/repositories/renewalReactivationRepository.ts`.
- Modify: `src/db.ts`, `src/repositories/mockStore.ts`, `src/services/configService.ts`, `_infra/main.tf`, `_infra/terraform.tfvars.example`.
- Test: `test/services/renewalQuote.test.ts`, `test/repositories/renewalReactivationRepository.test.ts`, `test/services/billingActivationConfig.test.ts`.

**Interfaces:**

- `RenewalTerms`: tier, interval, currency, next recurring `unitAmount` in minor units, `taxBehavior: 'exclusive' | 'inclusive'`, `renewsAt`, and `discount: null | { endsAt; regularUnitAmount }`.
- `RenewalQuote`: `purpose: 'billing_renewal_v1'`, nonce, guild/payer/subscription IDs, saved subscription revision or null, source fingerprint, terms, issuedAt and expiresAt in milliseconds.
- `RenewalRequest`: `{ kind: 'confirm'; quoteToken: string } | { kind: 'recover'; operationId: string }`.
- `RenewalOperation`: immutable operation/quote nonce, server/payer/mode/source/terms/request/idempotency binding; a discriminated state of applying, verifying, succeeded, rejected or needs_review. Each state carries only its required result/reason fields.
- `RenewalControl` is `{ guildId: string; operationId: string; revision: string }`. Its presence means that operation still owns the server's renewal control. Release deletes only that matching control.
- Repository signatures: `getOperation({guildId, operationId}): Promise<RenewalOperation | undefined>`, `getControl({guildId}): Promise<RenewalControl | undefined>`, `claim({operation, expectedSubscription}): Promise<boolean>`, `compareAndWrite({next, expectedRevision}): Promise<boolean>`. The argument types are the named domain records plus strings for IDs/revisions. `expectedSubscription` is the existing `GuildSubscription` row.
- Pin operation field names used across tasks: `operationId`, `quoteNonce`, `guildId`, `payerId`, `mode`, `subscriptionId`, `sourceFingerprint`, `invariantFingerprint`, `sourceRevision`, `approvedTerms`, `stripeRequest`, `idempotencyKey`, `firstAttemptAt`, `analyticsOptOut`, `revision`, `state`. `stripeRequest` is the accepted minimal Stripe SubscriptionUpdateParams subset. The invariant fingerprint covers fields that must stay unchanged and excludes the cancellation fields being cleared. `firstAttemptAt` is recorded conservatively when the first write is claimed, so a crash cannot extend the 23-hour retry limit.
- `signRenewalQuote(quote): string` and `readRenewalQuote(token, now): RenewalQuote | undefined` reuse `src/utils/consentToken.ts` with a strict Zod payload and a renewal-specific derived signing key.
- `RenewalView` carries `{ state: RenewalState; canManageBilling: boolean; lifecycleAnalyticsEnabled: boolean }`. Task 2 defaults the telemetry capability to false; Task 5 binds it to the separate capture gate and persisted subscription opt-out, with browser DNT still checked locally. Its permission is verified from current payer metadata, including for an already-renewing or terminal subscription. Payment history must not infer it from `hasStripeBilling` or the old broad `canManageBillingPortal` field.
- Define the shared state shape in Task 2's `src/types/renewal.ts` before using it:

```ts
type RenewalAction =
  | {
      kind: "ready";
      quoteToken: string;
      expiresAt: number;
      terms: RenewalTerms;
    }
  | {
      kind: "review_in_stripe";
      reason:
        | "unsupported_state"
        | "payment_problem"
        | "direct_unavailable"
        | "unverified_terms";
    }
  | { kind: "payer_required" }
  | { kind: "unavailable" };
type RenewalState =
  | { kind: "off"; tier: PaidTier; endsAt: string; action: RenewalAction }
  | { kind: "on"; terms: RenewalTerms }
  | { kind: "processing"; operationId: string; endsAt: string }
  | { kind: "needs_review"; operationId: string; knownEndsAt: string | null }
  | { kind: "payment_problem" }
  | { kind: "terminal" }
  | { kind: "not_applicable" }
  | { kind: "unavailable"; knownEndsAt: string | null };
```

Derive `PaidTier` and `BillingInterval` from existing pricing types. An unresolved payment uses the off/provider-review branch only when a future cancellation is known; otherwise payment_problem preserves payment attention and the original payer's Manage billing action. Do not reinterpret unavailable state as terminal or Free.

- [x] **Step 1: Write failing quote/repository/config tests.** Pin the five-minute lifetime, purpose and actor binding. Reject altered payloads, wrong purpose, another server/payer, expired new consent and unsupported terms. Assert that two claims on one source allow one winner, another server remains independent, and subscription/purchase/offer rows are untouched.

```ts
expect(readRenewalQuote(tamperedToken, now)).toBeUndefined();
expect(readRenewalQuote(token, issuedAt + 300_000)).toBeUndefined();
expect(
  await Promise.all([
    repo.claim({ operation: first, expectedSubscription }),
    repo.claim({ operation: competing, expectedSubscription }),
  ]),
).toEqual(expect.arrayContaining([true, false]));
expect(mockStore.purchaseAttempts).toEqual(beforePurchases);
expect(mockStore.offerUsages).toEqual(beforeOffers);
```

- [x] **Step 2: Run the new focused tests and confirm failure.** Use `node node_modules/jest/bin/jest.js test/services/renewalQuote.test.ts test/repositories/renewalReactivationRepository.test.ts test/services/billingActivationConfig.test.ts --runInBand --coverage=false`. Failure must be the missing contract, not an unrelated environment error.
- [x] **Step 3: Implement the protocol and durable claim.** Use `RENEWAL_OP#<guildId>#<nonce>` for operations and `RENEWAL_CONTROL#<guildId>` for the active pointer in the existing GuildSubscription table. A transaction condition-checks the saved subscription ID/revision, creates the new operation once and claims an absent control. Terminal completion releases only its own control; the immutable operation remains readable. Keep incomplete operations recoverable without time-based control stealing. A signed quote is not itself the replay record.
- [x] **Step 4: Add the separate default-false gate.** Map exact env value `true` to `config.stripe.renewalReactivationEnabled`. Add matching boolean Terraform input/env wiring and example, following the existing transition gate in `_infra/main.tf`. Do not change `STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED`. Test unset, false and mixed-case values stay disabled. No Terraform apply or runtime setting change.
- [x] **Step 5: Run the focused tests, root TypeScript and lint.** Verify real Dynamo command shapes and conditional failures as well as the mock store. No extra table, secret or broad IAM grant is required. Validate any policy effect before assuming existing permissions cover the transaction.
- [x] **Step 6: Commit this independently testable protocol.** Stage only Task 2 files. Suggested message: `Add guarded renewal consent and operation storage`.

## Task 3: Implement the protected renewal API and recovery

**Files:**

- Create: `src/services/renewalProvider.ts`, `src/services/renewalReactivationService.ts`, `src/services/billingPayerService.ts`.
- Modify: `src/services/billingService.ts`, `src/trpc/routers/billing.ts`. Reuse `src/services/subscriptionReconciliation.ts`; change it only if a demonstrated integration need requires it.
- Test: `test/services/renewalProvider.test.ts`, `test/services/renewalReactivationService.test.ts`, `test/trpc/renewal.test.ts`, existing `test/services/billingTransition.test.ts`, `test/services/basicIntroOfferService.test.ts` and `test/api/billing.test.ts`.

**Interfaces:**

- `readRenewalState({stripe, guildId, payerId, now}): Promise<RenewalView>` owns native reads, preview and the ready quote. `now` defaults to Date.now inside the service.
- `restoreRenewal({stripe, guildId, payerId, request, analyticsOptOut, now}): Promise<RenewalResult>` consumes Task 2's request and durable operation contract.
- `readRenewalSource({stripe, guildId, subscriptionId}): Promise<RenewalSource>` validates native identity, independent paid boundary, payment state, tax basis and source fingerprint.
- `clearPendingCancellation({stripe, operation}): Promise<void>` sends only Task 1's accepted exact body and immutable idempotency key.
- `assertStripePayer({stripe, customerId, payerId}): Promise<void>` centralizes the existing metadata check; migrate both current billing-service callers without weakening their association checks.
- `billing.renewal` is a Manage Server query with `{serverId}`. `billing.reactivateRenewal` is a Manage Server mutation with `{serverId, request: RenewalRequest}`. Mutation success never comes from browser-supplied terms.
- Consumes Task 2's `RenewalView`, `RenewalState` and `RenewalAction`. Payment problems never imply terminal status or Free.
- `RenewalResult` is confirmed with verified terms, changed requiring new review, processing with operation ID, or needs_review. Authorization failures use the existing BillingActionError mapping.

- [x] **Step 1: Write failing service and API tests.** Name and pin: `classic_flag_undo_preserves_contract`, `flexible_date_undo_preserves_contract`, `custom_shortened_period_requires_provider_review`, `manager_is_not_payer`, `expired_quote_cannot_start_operation`, `remaining_monthly_offer_is_not_restarted`, `inclusive_price_is_not_labeled_before_tax`, `another_server_is_unchanged`, `disabled_gate_blocks_new_write`, `terminal_never_calls_update`, `terminal_checkout_new_payer_cannot_view_old_receipts`.

```ts
expect(result.kind).toBe("confirmed");
expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
expect(stripe.subscriptions.resume).not.toHaveBeenCalled();
expect(mockStore.offerUsages).toEqual(beforeOffers);
```

Add failure cases for unresolved payment, missing payer metadata, subscription/customer/mode mismatch, unsupported discount, invoice-preview failure and existing schedule. Readable state is distinct from permission to write or open the payer's receipts.

- [x] **Step 2: Run focused tests and confirm the expected failures.** Use the four new service/API test paths with Jest `--runInBand --coverage=false`. Keep test fixtures explicitly typed; inspect the installed SDK's preview-line format rather than assuming an older API shape.
- [x] **Step 3: Implement read and consent.** Query current provider state and the independently verified paid boundary. Preview only Task 1's accepted cancellation removal. Build the quote from verified service terms, not the initial invoice cash amount or a public catalog guess. Include relevant item/period/price/discount/tax/payment/schedule state in the fingerprint. Return payer_required to a permitted nonpayer viewer without issuing a writable quote.
- [x] **Step 4: Implement claim, apply and reconcile.** Check gate and current permissions, validate the token, claim the server control, then re-read and compare the source before sending the minimal update. Call `reconcileSubscription(stripe, guildId, subscriptionId)` and verify its consistent saved result after independent native readback. Confirm only if cancellation is gone and all invariant terms match. Do not write offer usage, reserve an offer, create Checkout or call a collection API.
- [x] **Step 5: Pin recovery and external races before declaring success.** Add `lost_update_response_recovers_same_operation`, `persistence_failure_stays_processing`, `quote_expiry_does_not_erase_submitted_operation`, `old_completed_request_cannot_undo_later_cancel`, `concurrent_native_terms_require_review`, `webhook_and_request_reconcile_current_state`, `disabling_gate_preserves_read_recovery`. Retry writes only with the original request/key within 23 hours of the first attempted update, inside Stripe's documented minimum 24-hour API v1 retention. Outside it, require review rather than risking a new write. When the action gate is off, recovery may read and persist verified outcomes but may not send an update retry. Keep unresolved control records for review. Confirmed old operations return current status on replay, never a new undo. Post-write drift becomes needs_review with verified facts and no automatic price rollback or recancellation.
- [x] **Step 6: Run focused and existing billing regressions.** New tests plus `billingTransition`, `basicIntroOfferService` and `test/api/billing.test.ts` must pass. Run root `tsc --noEmit --incremental false`, scoped ESLint and the repository complexity check without new suppressions. Inspect behavior at the explicit provider/app boundaries.
- [x] **Step 7: Commit the protected API.** Suggested message: `Restore renewal on the existing verified subscription`. Keep the gate false.

## Task 4: Revise the current-plan card and payment history

**Files:**

- Create: `src/frontend/components/BillingRenewalStatus.tsx`, `src/frontend/components/BillingPaymentHistory.tsx`.
- Modify: `src/frontend/pages/Billing.tsx`, `src/frontend/components/SubscriptionDetails.tsx`, `src/frontend/pages/UpgradePlans.stories.tsx`, `src/frontend/pages/basicIntroFixtures.ts`, `src/frontend/utils/billingManagement.ts` only where state classification needs it.
- Test: `test/e2e/billingMocks.ts`, `test/e2e/billing.spec.ts`, `test/e2e/visual.spec.ts`, affected snapshots in `test/e2e/visual.spec.ts-snapshots` and Storybook play functions.

**Interfaces:**

- `BillingRenewalStatus({state, canManageBilling, onConfirm, onCheckStatus, onRetry, onPortal, busy})` renders Task 3's RenewalState. onConfirm accepts the server-issued quote token; onCheckStatus recovers the existing operation. The component never derives provider terms.
- `BillingPaymentHistory({firstYearPayment, previousStatus, canViewReceipts, onViewReceipts, busy})` receives the existing verified FirstYearPayment DTO and uses RenewalView.canManageBilling for the original payer's receipt action.
- Billing owns the `billing.renewal` query and reactivation mutation. It passes the returned state and verified canManageBilling permission to both new components. After a confirmed result, invalidate both renewal and billing.me, then show reconciled current data. A stale first-year display cannot overwrite the confirmed terms.

- [x] **Step 1: Write the failing browser and Storybook assertions.** The annual renewal-off fixture must show one end-date statement, no ACTIVE badge, the $100 renewal rate, a primary **Turn renewal back on**, secondary **Manage billing**, and first-year invoice details only inside **Payment history**. Include a normal renewal-on state, confirmed success, processing, read/update failure, nonpayer, payment problem, schedule/provider review and terminal Free.

```ts
await expect(current.getByText("Renewal off", { exact: true })).toBeVisible();
await expect(current.getByText("ACTIVE", { exact: true })).toHaveCount(0);
await expect(current).toContainText("Your Basic plan ends October 12, 2027.");
await expect(current).toContainText("$100/year before tax");
await expect(current).not.toContainText("First year paid");
await expect(history).toContainText("$64.20");
await expect(
  history.getByRole("button", { name: "View invoices and receipts" }),
).toBeEnabled();
```

- [x] **Step 2: Verify the failing UI behavior.** Run the new Billing tests with `PW_VISUAL=false`. Start/reuse Storybook on its verified port and run the focused renewal tag. Failures must correspond to the current screenshot's hierarchy or missing new states.
- [x] **Step 3: Implement the approved hierarchy.** Use the two focused components to keep Billing.tsx from accumulating another large nested state block. Replace the old broad action group; every portal/receipt button uses the verified canManageBilling permission, with backend checks still authoritative. Put server, renewal-off badge, end date, verified rate and primary action before usage/features. Remove duplicate renewal/cancellation lines from SubscriptionDetails and move payment amounts/coverage into Payment history. Use an existing accordion for those details, with a visible receipt action. Preserve the comparison selector and existing non-Stripe/grant states.
- [x] **Step 4: Wire consent and recovery.** The primary button consumes the quote displayed on the card. If it expired or changed, refresh terms and require another deliberate click, never auto-submit updated consent. While unresolved, show Checking renewal and recover the same operation. Payment/update failures must not claim success. Nonpayer and provider-review states must route as the spec says. **Get Basic again** reuses verified-terminal Checkout and the selected existing interval; it does not call reactivation.
- [x] **Step 5: Prove responsive behavior and scrolling.** Use 1280x720, 768x900 and 390x844. Include off/on/processing/failure/history-open/terminal fixtures in visual coverage. Assert no horizontal overflow. For short-height overflow, identify the actual scroll container, assert `scrollHeight > clientHeight`, scroll it and assert scrollTop changes; do not merely check element visibility. The button and receipt action remain reachable. Capture Storybook screenshots with the repo runner and inspect them with a VLM. Inspect Playwright snapshots too. Update only intended baselines, then rerun without updates.
- [x] **Step 6: Run browser and component checks, then commit.** Run affected Billing Playwright tests, the renewal Storybook tag, root types, scoped lint/format and complexity checks. Review copy with unslop. Suggested message: `Clarify renewal status and payment history`.

## Task 5: Measure cancellation, loss and recovery

**Files:**

- Create: `src/types/billingAnalytics.ts`, `src/services/billingLifecycleAnalytics.ts`, `test/services/billingLifecycleAnalytics.test.ts`.
- Modify: `src/services/subscriptionReconciliation.ts`, `src/services/renewalReactivationService.ts`, `src/api/billing.ts`, `src/types/db.ts`, `src/trpc/routers/billing.ts`, `src/services/configService.ts`, `_infra/main.tf`, `_infra/terraform.tfvars.example`, `src/frontend/pages/Billing.tsx` and `src/frontend/services/analytics.ts`, `src/services/analyticsService.ts`.
- Test: `test/api/billing.test.ts`, `test/services/renewalReactivationService.test.ts`, `test/e2e/billing.spec.ts`, current analytics-service tests and `test/services/billingActivationConfig.test.ts`.
- Docs: `docs/purchase-analytics.md`, `apps/docs-site/docs/legal/privacy.md`, `apps/docs-site/docs/whats-new/index.md`.

**Interfaces:**

- `BillingLifecycleState = 'renewal_on' | 'renewal_off' | 'ended'`; an optional private `billingAnalyticsState` in GuildSubscription records the last observed baseline. It is never a new product identifier or browser-controlled state.
- `publishBillingLifecycleTransition({previous, current, provider, observedAt, analyticsOptOut}): void` receives the winning before/after GuildSubscription rows, validated StripeSubscription and server observation Date. It derives fixed categories, publishes once after a real accepted transition and never throws into billing. An initial observation establishes a baseline without inventing a historical cancellation. A changed cancellationAt while renewal remains off is terms_updated, not a new cancellation episode.
- `captureRenewalOperationEvent({operation, phase}): void`, with phase requested or result, publishes only on the first persisted operation transition. A repeat response does not publish another event.
- `captureBillingInvoiceOutcome({stripe, invoice, outcome}): Promise<void>`, with outcome failed, recovered or renewal_settled, validates native invoice/subscription ownership and private deduplication evidence. It exports no provider identity. Keep the existing positive-payment producer unchanged.
- Use existing browser capture and visibility patterns for renewal-off viewed and eligible primary-action clicks. Pass server-observed Date as the optional standard timestamp argument in captureEvent; existing callers keep their current default. Emit boundary_known for state observations. Include remaining_seconds_to_scheduled_end only when the verified remaining interval is within 0..31,622,400 seconds; otherwise boundary_known is false. Query maturity using event timestamp plus that duration and latest terms updates. Unknown boundaries are counted separately. The canonical event/property contract is [Product lifecycle analytics](../../purchase-analytics.md#loss-and-recovery-events).

- [x] **Step 1: Write failing event semantics tests.** Pin one on-to-off state transition, off-to-on restoration and actual paid relationship ending. Repeat and out-of-order webhook requests must not produce duplicates. A canceled old subscription replaced by a current active one must not become a new server loss. A first observed off state is a baseline, not a newly timed cancellation. Keep complimentary product access distinct from the end of Stripe payment.

```ts
expect(stateChanges.map((event) => event.to_state)).toEqual([
  "renewal_off",
  "renewal_on",
]);
expect(replayedStateChanges).toHaveLength(0);
expect(firstObservationEvents).toHaveLength(0);
expect(outcomes).not.toContainEqual(
  expect.objectContaining({ provider_invoice_id: expect.anything() }),
);
```

Add exact maturity just before/at/after the known boundary, annual dates that differ from the entry month/day, updated cancellation dates, unknown/out-of-range boundaries and zero duration. Add verified failed-invoice recovery matched to that same invoice, nonmatching later payment, normal renewal, credit-covered renewal, downgrade contraction and no extra acquisition conversion.

- [x] **Step 2: Write the opt-out, actor and visibility tests.** A webhook outcome has guild identity, not the original purchaser presented as the cancellation actor. A direct accepted request uses its verified actor. Read DNT from the request header and the validated analyticsOptOut input, combining it with stored subscription opt-out. It never affects billing authorization or financial fingerprints. Persist the operation suppression bit so DNT suppresses browser and synchronous request events and the associated operation outcomes; retain stored subscription opt-out for later outcomes. Bind operation suppression privately without retroactively changing purchase attribution. An ambiguous association suppresses capture rather than guessing. Test no key and capture errors do not affect billing. Browser tests prove visible exposure once per server/terms state and distinguish a click from an accepted request.
- [x] **Step 3: Run focused tests and confirm the intended failures.** Use the new lifecycle suite plus billing API, renewal-service, existing analytics and focused browser tests. Fixtures stay local; they do not write to PostHog.
- [x] **Step 4: Implement the shared producers and private deduplication.** Publish state changes only after a successful conditional reconciliation write and actual semantic change. Reuse existing receipt/repository patterns for invoice failure/recovery/settlement deduplication, keeping keys internal. A recovered invoice must be the previously failed one. Wire authoritative settled-renewal handling for paid service even when cash due is zero, rather than widening billing_entitlement_saved. Emit operation events only at the first durable claim and final persisted result. No portal visit is labeled cancellation intent. No raw cancellation reason, price, amount, quote, provider ID or operation ID reaches PostHog.
- [x] **Step 5: Add the independent rollout switch and notices.** Add exact-true `config.analytics.billingLifecycleEnabled` from BILLING_LIFECYCLE_ANALYTICS_ENABLED, default false, with matching Terraform/example wiring and activation tests. Keep state baselines and financial reconciliation independent from capture. Return lifecycleAnalyticsEnabled in RenewalView so the new browser captures cannot run while their server-side rollout switch is off. The privacy-policy analytics detail, provider table, last-updated date and What's New notice must describe lifecycle/payment-recovery categories before enabling capture. Verify DNT wording for existing subscriptions and new operation outcomes; do not quietly broaden it.
- [ ] **Step 6: Verify received Sandbox rows separately.** Under the implementation's execution authority, verify the Chronote PostHog project before querying. Read the actual events table because schema definitions can lag ingestion. Confirm environment, guild continuity, actual or absent actor, categories, duplicate suppression, opt-out absence and no forbidden payload fields. Do not query customer content or mix Sandbox into production metrics. Source code tests are not ingestion proof.
- [ ] **Step 7: Validate the three funnel definitions before publishing saved views.** Inspect existing onboarding/purchase insights and private reporting owner notes. Keep the existing seven-day purchase definitions; review the proposed onboarding and win-back windows. Use same-server ordered cohorts without assuming native groups are configured. Report cancellation cohorts only after their paid boundary matures, and keep voluntary loss, payment-failure loss, save attempts and later settled renewal distinct. Show baseline counts, unknown cause, DNT/capture gaps and small samples. Prefer updating the existing reporting/daily health summary over creating duplicate dashboards. Saved insight/configuration changes need their own explicit execution scope.
- [x] **Step 8: Run the focused suites, docs checks, lint and formatting, then commit.** Suggested message: `Measure subscription loss and renewal recovery`. Analytics remains best effort, never a billing audit ledger. Reconcile bounded aggregate state counts; do not invent missing event timestamps. Both new action and telemetry gates stay false.

## Task 6: Integrate, document and prepare review

**Files:**

- Modify: `apps/docs-site/docs/features/feature-overview.md`, `docs/billing-subscription-transitions.md`, `_infra/README.md` if the new gate needs an operator explanation.
- Update: this plan's checkboxes and exact evidence appendix, plus the existing private billing owner note for native acceptance references.

**Interfaces:**

- Produces one coherent branch with direct reactivation and new lifecycle capture both disabled by default, a readable test/acceptance packet, and no deployment or activation claim.
- Existing initial Checkout, provider management, current-state webhooks and offer ledger remain unchanged outside the named integration.

- [ ] **Step 1: Trace the complete same-subscription journey.** Run the UI through quote, click, native update, current-state reconciliation and confirmed card in signed-in Sandbox only after execution authorization. Verify receipts, return server context, nonpayer denial and terminal repurchase separately. Never restore the cleaned parent fixture.
- [x] **Step 2: Update public and operator docs.** Explain renewal off, who may restore renewal, the date/rate shown before consent, payment-history access and terminal repurchase. Document the separate flag and recovery behavior. Do not publish private fixture identities or claim that all schedules are editable in Stripe.
- [x] **Step 3: Run the appropriate full affected checks.** Jest for the new renewal, billing activation, consent/repository and existing billing/webhook suites; `PW_VISUAL=false` Billing browser tests; `PW_VISUAL=true` affected visuals; Storybook capture after Playwright finishes; root types, scoped lint/Prettier, docs build and full complexity check. Avoid racing the Storybook runner with Playwright report writes. New failures or changed code justify repeat checks; otherwise proceed to review.
- [x] **Step 4: Review the actual branch, not only helper tests.** Inspect authorization, source association, inclusive-tax copy, quote replay after cancel-again, external-race behavior, unresolved operations, same-subscription invariants and default-false gate. Separate mock proof, native provider proof, signed-in app proof, PostHog received rows, saved query configuration, CI and runtime evidence.
- [x] **Step 5: Prepare the PR under the active authorization.** If publishing is authorized, use a concise problem/behavior description with relevant validation, attach the PR, and follow the repository's exact-head 30-minute gate plus all mutable review/check surfaces before calling it merge-ready. Every new commit restarts the window. Do not merge, deploy, enable the flag or perform production billing writes under design/planning authority.

## Self-review and open gates

The design's UX states map to Task 4, provider boundaries and source races to Tasks 1/3, consent/storage to Task 2, and release evidence to Tasks 5 and 6. Public signatures above are the only new cross-task contract; internal helpers remain the implementer's choice. Task 4 can use fixtures before the provider is accepted, but cannot certify Task 3 through those mocks.

The analytics addition preserves the three-funnel map and makes loss/recovery coverage part of completion. Current onboarding/purchase source coverage is not proof of a saved live funnel. Native proof may reject the candidate. That is a release gate, not permission to substitute Checkout or silently weaken the invariants. External Stripe edits remain an explicit limitation; a failed concurrency test requires a design revision.

No additional pricing decision remains. Before implementation, review the recommended direct route, inline consent and separate disabled-by-default gate. Native execution is the suggested implementation approach because these tasks share one source/operation contract and can be completed sequentially, with an independent whole-branch review afterward. BASIC subsequently approved local execution and the owned native tests.

## Evidence appendix

Planning source: local branch `codex/plan-switching` at `20b038b8d6d40fe0a198ff06ca61c9e7b842fff4`. Current cancellation source is already saved in `e340763e89b1b0bcd7fedabf359e2957e566cfb0`; it recognizes both representations and clears stored cancellation on authoritative resume-shaped data. It does not implement a reactivation mutation.

Current stories are under `src/frontend/pages/UpgradePlans.stories.tsx`; the baseline reference is `pages-upgradeplans--intro-subscriber-canceled`. Current static preview uses localhost:6106. Existing provider/production evidence is separately owned and is not acceptance for the new action.

Builder check on the design: a fresh software-engineering reviewer reported **nothing important left**. This plan then received the writing-plans self-review and an unslop pass. Local implementation and owned provider proof have since been executed.

### Final local verification and review

The implementation is committed through `29c44711ef453c995ec1eb3abb58b00ccb4b19cc` on `codex/plan-switching`. A fresh whole-branch review covered `3e3981968955a82e06f2d4544b3c3dec6a8b76a2..390ece47e2555a3eaa7bb6ad6d4db45261ddd1bf`. Its two Important findings were reproduced with failing tests and fixed in one pass:

- Recovery now retains a newly stored subscription analytics opt-out before update, readback and confirmation. Suppression cannot clear.
- A past-due or unpaid renewal without scheduled cancellation retains payment attention and the original payer's Manage billing action.

The full suite and affected browser/Storybook checks passed after those fixes. Root source types, explicit SDK-test types, scoped lint, formatting, docs build and Markdown lint passed. Full complexity analysis ran without new suppressions. The first local complexity run used Lizard 1.21.6. CI uses the locked 1.24.0 and identified seven over-threshold functions. PR follow-up split provider validation, operation recovery, Billing rendering and fixtures into focused helpers. The complete pinned check now passes without new suppressions.

Local result files are `tmp/renewal-final-jest.json`, `tmp/renewal-final-browser.log`, `tmp/renewal-final-stories.log`, `tmp/renewal-review-types.log`, `tmp/renewal-review-test-types.log`, `tmp/renewal-review-lint.log`, `tmp/renewal-docs-build.log` and `tmp/renewal-docs-lint.log`. These are local verification artifacts, not CI or deployed acceptance.

Private native proof is committed as `e46a22d` on `codex/renewal-reactivation-proof` in chronote-ops. Its receipt index reports 17 accepted checks, six exclusions, nine retained controller failures and zero unresolved owned resources. The source branch contains only synthetic SDK fixtures.

### Remaining release and publication gates

- The native provider packet and mock browser journey are separate proof. A signed-in deployed Sandbox journey has not been accepted. Both action and telemetry gates remain false.
- No new lifecycle event rows were received in the verified PostHog project. Notice publication and separately authorized activation precede ingestion acceptance. Existing saved insight identities were found; their full definitions and new loss views have not been validated or changed.
- Neither branch has been published in this implementation slice. CI, exact-head review readiness, merge, deployment and production behavior remain unverified.
- Source configuration was reviewed for encryption and privacy boundaries. Live infrastructure encryption, operational deletion fulfillment and jurisdiction-specific legal sufficiency are not certified by source review.

These gates remain unchecked above. They do not prevent reviewing the completed local implementation and owned native proof.

### Implementation decisions retained from the execution ledger

| Decision                                                                                                                                      | Cost if wrong                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Use seven-day onboarding/purchase and 30-day win-back reporting defaults; saved-view writes remain separate.                                  | Revise the reporting windows.                                                        |
| Use the existing `_infra/terraform.tfvars.example`; the plan's earlier `_infra/tfvars.example` path did not exist.                            | Correct the path.                                                                    |
| A local FORCE_TIER fixture has no Stripe pointer, so it retains complimentary access without a payment action.                                | Add a separate paid mock fixture.                                                    |
| Keep private invoice deduplication markers for 400 days rather than 30 days.                                                                  | Revise private retention and replay coverage.                                        |
| Let unresolved-operation analytics suppression widen, never clear; financial consent remains immutable.                                       | Fewer analytics rows, with no billing change.                                        |
| Keep capture off until notice publication and separately authorized activation; do not synthesize acceptance events.                          | Received-event and signed-in release acceptance remain pending.                      |
| Accept the retained private native receipt/cleanup packet as bounded owned Sandbox proof; the branch reviewer did not repeat provider writes. | Repeat an affected owned case before activation if its evidence proves insufficient. |
| Do not infer deployed-app acceptance, ingestion, complete saved-query validation, CI or merge readiness from local checks.                    | Obtain missing release proof before making those claims.                             |
| Keep live encryption and deletion-fulfillment verification separate from source review.                                                       | Operator verification or configuration correction may be required.                   |
| Treat public-copy review as engineering accuracy review, without jurisdiction-specific legal assurance.                                       | Qualified legal review and notice revisions may be required.                         |

The complexity maintenance item was resolved during PR iteration. No suppression was added. The final frontend and static Storybook builds passed after the review fixes. The existing local and tailnet preview both returned HTTP 200 and serve the `29c44711` UI build with simulated actions.

### PR iteration (October 15)

BASIC authorized publication and iteration until merge-ready. Product PR [#410](https://github.com/Chronote-gg/Chronote/pull/410) targets master; private native-proof PR #1 targets chronote-ops main. Both branches merge cleanly. No merge, deployment or activation is included in this instruction.

The first CI cycle exposed seven complexity failures, missing visual-job routing, stale cancellation/history assertions and unfinished mock routes at browser teardown. The locked Lizard 1.24.0 check now passes for the entire source and test tree. Renewal screenshots use the existing visual gate and @visual selection; the short-height scroll assertion remains an ordinary functional test. Known billing fixture responses no longer fetch the real mock billing endpoint, and route teardown waits for active handlers.

Greptile identified a pending-state bug: a successful mutation's operation ID disappeared from the card if its follow-up query failed. Two regression tests reproduced the failure before implementation. The hook now retains processing/review state for the same server, supports recovery with the returned operation ID and replaces it after a successful read. The five-minute consent lifetime is shared by creation, validation and fixtures in a browser-safe constants module.

Claude reported no Important findings on the initial head. Codex and Copilot reviews were unavailable due to account review quotas. Those unavailable attempts are recorded separately from completed reviews. Current-head CI, all review pages and mutable summaries must be refreshed after the repository's 30-minute commit window before claiming merge readiness.

The post-review full unit run passed 278 suites and 2,269 tests. Functional billing checks passed 57 cases at CI-like concurrency, with 21 screenshot cases correctly skipped outside visual mode. Source types, explicit SDK-test types, lint, format and the complete locked complexity check passed. The targeted visual capture passed 70 cases. The updated baselines and the complete visual matrix must pass without updates before merge readiness.

### In-flight server navigation follow-up

A later isolation check found that a mutation finishing after navigation could refresh the newly selected server and lose the original operation's local state. A single pending-state slot could also overwrite another server's unresolved operation. Two new regression tests reproduced these failures before the fix, including a missing query cache on return.

Pending records and read versions are now kept separately per server. Refreshes and notices are ignored after leaving the request's server. A missing cache is not treated as a successful read, and returning to the original server preserves its operation ID until authoritative data replaces it. This changes no provider request, financial consent or authorization rule.

The full suite after this follow-up passed 278 suites and 2,271 tests. Source typing, lint and the pinned complexity check passed. The next push restarts the exact-head 30-minute readiness window; previous green checks remain evidence for their earlier head only.
