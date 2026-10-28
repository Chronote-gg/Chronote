# Checkout Lock Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An abandoned or superseded initial Checkout never leaves a server's billing page or plan change path blocked.

**Architecture:** One exported read-path helper in `initialPurchaseService.ts` reuses `refreshAttempt` to release an `open` attempt whose local `checkout.expires_at` has passed, and `getBillingSnapshot` and `prepareBillingChangeOwned` call it before reading attempt state. `reserve` gains a supersede branch for a live `open` attempt with a different payer or choice: expire the old session at Stripe through `owner.effect`, then let `refreshAttempt` perform the existing guarded release (or reconcile a completed session), then loop to a fresh reservation. `getGuildBasicIntroOffer` stops returning `unavailable` for a live `open` attempt and quotes the offer that the supersede path will reserve.

**Tech Stack:** TypeScript, stripe-node 23.0.1, DynamoDB compare-and-write (mock store in tests), Jest.

**Spec:** `docs/superpowers/specs/2026-10-27-checkout-lock-recovery-design.md`

## Global Constraints

- Reuse the existing guarded transitions: `refreshAttempt`, `prepareExpiredOfferRelease`, `assertSessionAssociation`, `reconcileSubscription`. No new attempt or offer-usage write paths.
- Writes keep going through the runtime billing owner (`owner.effect`), including the new `checkout.sessions.expire` call.
- Compare-and-write losses are normal: re-read and continue from the current state. Do not surface a concurrency error to a page load.
- No change to the `PurchaseAttempt` shape or keys. Existing `open`, `expired` and `completed` rows must keep working.
- Read path must degrade, not fail: if Stripe (or runtime admission) fails during a read-path release, the snapshot still loads.
- No Stripe call on a billing page load unless an `open` attempt exists and its `checkout.expires_at` has passed by local clock.
- Releasing must only happen after Stripe confirms the session is `expired` with no subscription. A different payer never receives the old hosted URL.
- `preparing` and `needs_review` behavior is unchanged.
- No em dashes in docs, copy or comments. Comments explain why, not what.
- Quality ratchet (`quality-ratchet.json`): files at or above 1,000 lines may not grow (`src/services/basicIntroOfferService.ts` 1149, `test/services/basicIntroOfferService.test.ts` 2587, `test/api/billing.test.ts` 1435); keep `test/services/initialPurchase.test.ts` (944) and `test/services/billingChangeService.test.ts` (996) under 1,000; no touched function above 15 cyclomatic or cognitive complexity; no new 8-line/50-token duplicate blocks. This is why new tests go in new files and shared fixtures are moved, not copied.
- Single-file test runs need `--coverage=false` because `jest.config.ts` sets `collectCoverage: true` with global thresholds.

## Review Focus

- A billing page load while the runtime is draining (`RuntimeAdmissionUnavailable` from `runBillingOperation`) must still render the snapshot. Pinned in Task 1.
- An `open` row carrying an `incidentKey` must never be released or superseded by the new paths. Pinned in Task 1 and Task 3.
- Two admins choosing different plans at the same moment may supersede each other (accepted by the spec), but must end with exactly one unexpired session, the one stored on the attempt. Pinned in Task 3.
- A plan change while Stripe is unreachable must still answer with the pending error, not a 500. Pinned in Task 2.
- The intro offer quoted to a second payer must be accepted by the `expectedOffer` check after the old reservation is released. Pinned in Task 4.

## File Structure

- `src/services/initialPurchaseService.ts`: gains `releaseExpiredPurchaseAttempt`, `reuseOpenOrCurrentAttempt`, `supersedeOpenAttempt`; narrows `refreshAttempt`'s input type.
- `src/services/billingService.ts`, `src/services/billingChangeService.ts`: one call each to the helper.
- `src/services/purchaseAttemptOffer.ts` (new): frozen-offer helpers moved out of `basicIntroOfferService.ts` (which may not grow) plus `openAttemptHoldsOffer`.
- `test/fixtures/initialPurchaseStripe.ts` (new, moved from `initialPurchase.test.ts`) and `test/fixtures/introOfferPurchase.ts` (new, moved from `basicIntroOfferService.test.ts`).
- `test/services/checkoutLockRecovery.test.ts` (new): read-path, plan-change and supersede tests on the plain fixture.
- `test/services/checkoutLockRecoveryOffer.test.ts` (new): intro offer quote, release and supersede tests.
- No frontend file changes. See Task 4 for why.

---

### Task 1: Read-path release on billing load

**Files:**
- Create: `test/fixtures/initialPurchaseStripe.ts`, `test/fixtures/introOfferPurchase.ts`, `test/services/checkoutLockRecovery.test.ts`, `test/services/checkoutLockRecoveryOffer.test.ts`
- Modify: `test/services/initialPurchase.test.ts:19-131` (fixtures move out), `test/services/basicIntroOfferService.test.ts:45-127,263-358` (fixtures move out)
- Modify: `src/services/initialPurchaseService.ts:86-89` (`save`), `:385-394` (`checkCheckoutReplayWindow`), `:430-476` (`refreshAttempt`), new export
- Modify: `src/services/billingService.ts:113-122` (`getBillingSnapshot`)

**Interfaces:**
- Produces: `export async function releaseExpiredPurchaseAttempt(input: { stripe: StripeClient; guildId: string; owner?: RuntimeBillingOwner }): Promise<void>` in `initialPurchaseService.ts`. Never throws.
- Produces: `type AttemptRefreshInput = Pick<PurchaseInput, "stripe" | "owner" | "guildId" | "expected">`; `refreshAttempt(input: AttemptRefreshInput, initial: PurchaseAttempt | undefined)`, `checkCheckoutReplayWindow(input: AttemptRefreshInput, attempt)`, `save(input: Pick<PurchaseInput, "owner">, ...)`. Behavior unchanged.
- Produces (fixtures): `test/fixtures/initialPurchaseStripe.ts` exports `purchaseGuildId`, `sessionFields()`, `paidProvider(id: string)`, `initialPurchaseStripe(): { stripe; client: StripeClient }` (the former `fixture()`), with two additions: `retrieve` echoes the requested session id (existing tests only ask for `cs_first`, so they are unaffected), and `stripe.checkout.sessions.expire: jest.fn()` records the id and returns that session expired (`status: "expired"`, `url: null`, `subscription: null`); from then on `retrieve` reports that id expired. `test/fixtures/introOfferPurchase.ts` exports `introNow`, `introSettings`, `introOfferStripe()` (former `fixture()`), `introPurchaseFixture()` (former `purchaseFixture()`), with the same `expire` behavior for `cs_intro`. The two old test files import these under their old local names; their bodies do not change.

- [ ] **Step 1: Move the fixtures and confirm nothing regressed**

Run: `yarn test test/services/initialPurchase.test.ts test/services/basicIntroOfferService.test.ts --coverage=false`
Expected: PASS, same test count as before the move.

- [ ] **Step 2: Write the failing read-path tests** in `test/services/checkoutLockRecovery.test.ts`

Header: `/** @jest-environment node */`, `jest.mock` of `runtimeApiOperationService` with `runRuntimeApiOperation: jest.fn(<runTestApiOperation from ../fixtures/runtimeApiOperation>)`, `analyticsService` mocked, `resetMockStore()` and `jest.clearAllMocks()` in `beforeEach`. Shared setup: `const { stripe, client } = initialPurchaseStripe(); const retrieve = stripe.checkout.sessions.retrieve; const request = { stripe: client, user: { id: "payer" }, guildId: purchaseGuildId, priceId: "price_basic" };`. Each test first calls `createCheckoutSession({ stripe: client, user: { id: "payer" }, guildId: purchaseGuildId, priceId: "price_basic" })` to get an `open` attempt, then `retrieve.mockClear()`.

```ts
const pastExpiry = () => {
  getMockStore().purchaseAttempts.get(purchaseGuildId)!.checkout.expires_at =
    Math.floor(Date.now() / 1000) - 1;
};

test("billing read leaves a live open checkout untouched without calling Stripe", async () => {
  await releaseExpiredPurchaseAttempt({ stripe: client, guildId: purchaseGuildId });
  expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)?.state).toBe("open");
});

test("billing read releases a provider-confirmed expired checkout past its local expiry", async () => {
  pastExpiry();
  retrieve.mockResolvedValueOnce({ ...sessionFields(), id: "cs_first", status: "expired", url: null, subscription: null });
  await releaseExpiredPurchaseAttempt({ stripe: client, guildId: purchaseGuildId });
  expect(retrieve).toHaveBeenCalledTimes(1);
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)?.state).toBe("expired");
});

test("billing read keeps a past-expiry session that Stripe still reports open", async () => {
  pastExpiry();
  await releaseExpiredPurchaseAttempt({ stripe: client, guildId: purchaseGuildId });
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)?.state).toBe("open");
});

test("billing read reconciles a past-expiry session Stripe reports complete", async () => {
  // model on "complete session with delayed webhook reconciles before directing to billing"
  pastExpiry();
  retrieve.mockResolvedValueOnce({ ...sessionFields(), id: "cs_first", status: "complete", subscription: "sub_new" });
  Object.assign(stripe, paidProvider("sub_new"));
  await releaseExpiredPurchaseAttempt({ stripe: client, guildId: purchaseGuildId });
  expect(getMockStore().subscriptions.get(purchaseGuildId)?.stripeSubscriptionId).toBe("sub_new");
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)?.state).toBe("completed");
});

test("billing read degrades when Stripe is unreachable", async () => {
  pastExpiry();
  retrieve.mockRejectedValueOnce(new Error("connection reset"));
  await expect(releaseExpiredPurchaseAttempt({ stripe: client, guildId: purchaseGuildId })).resolves.toBeUndefined();
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)?.state).toBe("open");
});

test("billing read degrades when the runtime is not admitting billing work", async () => {
  pastExpiry();
  jest.mocked(runRuntimeApiOperation).mockRejectedValueOnce(
    new RuntimeAdmissionUnavailable("Runtime is not accepting work"));
  await expect(releaseExpiredPurchaseAttempt({ stripe: client, guildId: purchaseGuildId })).resolves.toBeUndefined();
  expect(retrieve).not.toHaveBeenCalled();
});

test("billing read tolerates a concurrent writer winning the release", async () => {
  pastExpiry();
  retrieve.mockImplementationOnce(async () => {
    const row = getMockStore().purchaseAttempts.get(purchaseGuildId)!;
    getMockStore().purchaseAttempts.set(purchaseGuildId, { ...row, state: "expired", revision: "webhook" });
    return { ...sessionFields(), id: "cs_first", status: "expired", url: null, subscription: null };
  });
  await expect(releaseExpiredPurchaseAttempt({ stripe: client, guildId: purchaseGuildId })).resolves.toBeUndefined();
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)).toMatchObject({ state: "expired", revision: "webhook" });
});

test("billing read never touches an open attempt under incident review", async () => {
  pastExpiry();
  getMockStore().purchaseAttempts.get(purchaseGuildId)!.incidentKey = "PURCHASE#x#DUPLICATE#test#a#b";
  await releaseExpiredPurchaseAttempt({ stripe: client, guildId: purchaseGuildId });
  expect(retrieve).not.toHaveBeenCalled();
});
```

In `test/services/checkoutLockRecoveryOffer.test.ts` (header copied from `basicIntroOfferService.test.ts:1-22`: `admittedApi` import, `ledgerWriterRuntime` and `analyticsService` mocks, ledger flag; `beforeEach`/`afterEach` from its `authoritative initial-purchase offer` describe), the wiring and offer tests:

```ts
test("billing snapshot after an abandoned introductory checkout quotes the offer again and releases its reservation", async () => {
  const { request } = introPurchaseFixture();
  await createCheckoutSession({ ...request, expectedOffer: "basic_intro_v1" });
  jest.setSystemTime(introNow + 3601 * 1000);
  await request.stripe.checkout.sessions.expire("cs_intro"); // fixture flag: retrieve now reports expired
  const snapshot = await getBillingSnapshot({ stripe: request.stripe, guildId: request.guildId, payerId: "payer" });
  expect(snapshot.introOffer).toMatchObject({ status: "available", id: "basic_intro_v1" });
  expect(getMockStore().purchaseAttempts.get(request.guildId)?.state).toBe("expired");
  expect(await getOfferUsageRepository().get(request.guildId, "basic_intro_v1", "test"))
    .toMatchObject({ state: "unused", released: { resourceId: "cs_intro", reason: "checkout_expired" } });
});

test("webhook and read-path expiry release the introductory reservation exactly once", async () => {
  // create, advance past expiry, expire("cs_intro"), retrieve.mockClear(), then run
  // expirePurchaseAttempt(request.stripe, expiredSession) as the webhook would
  const before = await getOfferUsageRepository().get(request.guildId, "basic_intro_v1", "test");
  await getBillingSnapshot({ stripe: request.stripe, guildId: request.guildId, payerId: "payer" });
  expect(await getOfferUsageRepository().get(request.guildId, "basic_intro_v1", "test")).toEqual(before);
  expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledTimes(1); // only the webhook's read
});
```

(The "available again" assertion depends on Task 1 only: once the attempt is `expired`, `getGuildBasicIntroOffer` takes the normal ledger path.)

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `yarn test test/services/checkoutLockRecovery.test.ts test/services/checkoutLockRecoveryOffer.test.ts --coverage=false`
Expected: FAIL with "releaseExpiredPurchaseAttempt is not a function" / snapshot `introOffer` `unavailable`.

- [ ] **Step 4: Implement `releaseExpiredPurchaseAttempt(input: { stripe: StripeClient; guildId: string; owner?: RuntimeBillingOwner }): Promise<void>` in `src/services/initialPurchaseService.ts`**

Read the attempt; return with no Stripe call unless `state === "open" && sessionId && !incidentKey && Number(checkout.expires_at) * 1000 <= Date.now()`. Otherwise `runBillingOperation(input.owner, (owner) => refreshAttempt({ stripe, guildId, owner, expected: <current subscription pointer> }, attempt))`. Catch every error and `console.warn("Expired checkout release deferred", { guildId, error })`. Narrow `refreshAttempt`, `checkCheckoutReplayWindow` and `save` to the types in Interfaces. In `getBillingSnapshot`, `await releaseExpiredPurchaseAttempt({ stripe, guildId })` immediately after the disabled-billing guard and before the subscription read, so a reconciled completion is visible in the same snapshot.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test test/services/checkoutLockRecovery.test.ts test/services/checkoutLockRecoveryOffer.test.ts test/services/initialPurchase.test.ts test/services/basicIntroOfferService.test.ts --coverage=false`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/initialPurchaseService.ts src/services/billingService.ts test/fixtures/initialPurchaseStripe.ts test/fixtures/introOfferPurchase.ts test/services/checkoutLockRecovery.test.ts test/services/checkoutLockRecoveryOffer.test.ts test/services/initialPurchase.test.ts test/services/basicIntroOfferService.test.ts
git commit -m "fix: release provider-expired checkouts when billing loads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Release before the plan change pending check

**Files:**
- Modify: `src/services/billingChangeService.ts:162-167` (`prepareBillingChangeOwned`)
- Test: `test/services/checkoutLockRecovery.test.ts`

**Interfaces:**
- Consumes: `releaseExpiredPurchaseAttempt` from Task 1, passed `{ stripe: context.stripe, guildId: context.guildId, owner: context.owner }`.

- [ ] **Step 1: Write the failing tests**

Each test: create an `open` attempt as in Task 1, then set a subscription pointer `{ guildId, tier: "basic", status: "active", subscriptionType: "stripe", startDate: "2026-01-01", stripeSubscriptionId: "sub_source" }`, set `config.stripe.subscriptionTransitionsEnabled = true` (restore in `afterEach`), and give the fixture `subscriptions.retrieve: jest.fn().mockRejectedValue(new Error("source read reached"))` so reaching `readBillingChangeSource` is observable.

```ts
const change = () => prepareBillingChange({ stripe: client, guildId: purchaseGuildId, payerId: "payer",
  selection: { tier: "pro", interval: "month", expectedOffer: "none" } });

test("plan change releases a provider-expired checkout before its pending check", async () => {
  pastExpiry();
  retrieve.mockResolvedValueOnce({ ...sessionFields(), id: "cs_first", status: "expired", url: null, subscription: null });
  await expect(change()).rejects.toThrow("source read reached");
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)?.state).toBe("expired");
});

test("plan change still blocks on a live open checkout without calling Stripe", async () => {
  await expect(change()).rejects.toMatchObject({ reason: "purchase_pending" });
  expect(retrieve).not.toHaveBeenCalled();
});

test("plan change keeps the pending error when expiry cannot be verified", async () => {
  pastExpiry();
  retrieve.mockRejectedValueOnce(new Error("connection reset"));
  await expect(change()).rejects.toMatchObject({ reason: "purchase_pending" });
});
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `yarn test test/services/checkoutLockRecovery.test.ts --coverage=false -t "plan change"`
Expected: FAIL on "releases a provider-expired checkout" (rejects with `purchase_pending`); the other two PASS.

- [ ] **Step 3: Implement**: in `prepareBillingChangeOwned`, `await releaseExpiredPurchaseAttempt(...)` on the line before `getPurchaseRepository().get(context.guildId)`. The existing pending check stays as is and now sees the released state.

- [ ] **Step 4: Run to verify they pass**

Run: `yarn test test/services/checkoutLockRecovery.test.ts test/services/billingChangeService.test.ts --coverage=false`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/billingChangeService.ts test/services/checkoutLockRecovery.test.ts
git commit -m "fix: release expired checkouts before plan change pending check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Supersede a live open checkout on a different choice

**Files:**
- Modify: `src/services/initialPurchaseService.ts:192-258` (`reserve`), `:19` (`import Stripe from "stripe"` as a value import, needed for `Stripe.errors`)
- Test: `test/services/checkoutLockRecovery.test.ts`, `test/services/checkoutLockRecoveryOffer.test.ts`
- Modify tests: `test/services/initialPurchase.test.ts:816-834` (rewrite), `:232-248` (one added assertion); `test/services/basicIntroOfferService.test.ts:839-858` (rewrite without growing the file)

**Interfaces:**
- Consumes: `refreshAttempt(input: AttemptRefreshInput, initial)` and the fixture `expire` mock from Task 1.
- Produces (private): `reuseOpenOrCurrentAttempt(input: PurchaseInput, current: PurchaseAttempt): Promise<PurchaseAttempt | "superseded">` and `supersedeOpenAttempt(input: PurchaseInput, current: PurchaseAttempt): Promise<PurchaseAttempt | "superseded">`.

Verified Stripe behavior this task relies on ([expire](https://docs.stripe.com/api/checkout/sessions/expire), [session status](https://docs.stripe.com/api/checkout/sessions/object)): only a session with status `open` can be expired; expiring returns the Session with `status: "expired"`; it "returns an error if the Checkout Session has already expired or isn't in an expireable state" (a 400 `StripeInvalidRequestError`). `open` means "Payment processing has not started"; `complete` means "Payment processing may still be in progress". So a processing payment is already `complete`, and expire on it is refused; the refused-then-still-`open` row in the spec is a narrow race (customer submitting at the same instant), and the docs do not describe it further. stripe-node signature: `expire(id: string, params?: Checkout.SessionExpireParams, options?: RequestOptions): Promise<Response<Session>>`; `StripeClient` is `InstanceType<typeof Stripe>`, so no type change is needed.

- [ ] **Step 1: Write the failing tests** in `test/services/checkoutLockRecovery.test.ts`

Each test starts from the `open` attempt created by `payer` for `price_basic`; `firstAttemptId` is read from the store before the second call. Every click on an `open` attempt already retrieves the session once in `preparePurchaseAttempt` (it is still `open` then); the supersede path retrieves it a second time after `expire`. Create mocks must build `sessionFields()` inside the implementation so the metadata carries the new attempt id.

```ts
test("another payer supersedes a live open checkout with a fresh session", async () => {
  stripe.checkout.sessions.create.mockImplementationOnce(async () => ({ ...sessionFields(), id: "cs_second",
    status: "open", url: "https://checkout.stripe.com/second" }));
  await expect(createCheckoutSession({ stripe: client, user: { id: "other" }, guildId: purchaseGuildId, priceId: "price_pro" }))
    .resolves.toBe("https://checkout.stripe.com/second");
  expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_first", undefined,
    { idempotencyKey: `purchase-supersede-${firstAttemptId}` });
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)).toMatchObject({ payerId: "other", state: "open", sessionId: "cs_second" });
});

test.each([{ priceId: "price_pro" }, { promotionCodeId: "promo_changed" }, { allowPromotionCodes: false }])(
  "the same payer changing payment terms %p supersedes the open checkout", async (change) => {
    await expect(createCheckoutSession({ ...request, ...change })).resolves.toContain("checkout.stripe.com");
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
    expect(getMockStore().purchaseAttempts.get(purchaseGuildId)?.attemptId).not.toBe(firstAttemptId);
  });

test("a refused expire on a session completed in another tab returns billing, not a new checkout", async () => {
  Object.assign(stripe, paidProvider("sub_new"));
  stripe.checkout.sessions.expire.mockImplementationOnce(async () => {
    // payment completed in another tab between the first retrieve and the expire
    retrieve.mockResolvedValue({ ...sessionFields(), id: "cs_first", status: "complete", subscription: "sub_new" });
    throw new Stripe.errors.StripeInvalidRequestError({ message: "Session is not open", statusCode: 400 });
  });
  await expect(createCheckoutSession({ stripe: client, user: { id: "other" }, guildId: purchaseGuildId, priceId: "price_pro" }))
    .resolves.toBe(`/portal/server/${purchaseGuildId}/billing`);
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});

test("a refused expire on a still-open session keeps purchase_pending", async () => {
  stripe.checkout.sessions.expire.mockRejectedValueOnce(
    new Stripe.errors.StripeInvalidRequestError({ message: "Session is not open", statusCode: 400 }));
  await expect(createCheckoutSession({ ...request, user: { id: "other" } })).rejects.toThrow("already in progress");
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)).toMatchObject({ attemptId: firstAttemptId, state: "open" });
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
});

test("an unknown expire outcome never releases the attempt", async () => {
  stripe.checkout.sessions.expire.mockRejectedValueOnce(new Error("socket hang up"));
  await expect(createCheckoutSession({ ...request, user: { id: "other" } })).rejects.toBeInstanceOf(UnresolvedBillingMutation);
  expect(getMockStore().purchaseAttempts.get(purchaseGuildId)).toMatchObject({ attemptId: firstAttemptId, state: "open" });
});

test("a webhook releasing the old attempt during supersede still yields one fresh checkout", async () => {
  stripe.checkout.sessions.expire.mockImplementationOnce(async (id) => {
    const expiredSession = { ...sessionFields(), id, status: "expired", url: null, subscription: null };
    retrieve.mockResolvedValue(expiredSession);
    await expirePurchaseAttempt(client, expiredSession);
    return expiredSession;
  });
  await expect(createCheckoutSession({ ...request, user: { id: "other" } })).resolves.toContain("checkout.stripe.com");
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
});

test("an open attempt under incident review is never superseded", async () => {
  getMockStore().purchaseAttempts.get(purchaseGuildId)!.incidentKey = "PURCHASE#x#DUPLICATE#test#a#b";
  await expect(createCheckoutSession({ ...request, user: { id: "other" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
});

test("concurrent different choices leave one open attempt whose session is the only unexpired one", async () => {
  let n = 0;
  stripe.checkout.sessions.create.mockImplementation(async (params) => ({ ...sessionFields(),
    metadata: params.metadata, id: `cs_${++n}`, status: "open", url: `https://checkout.stripe.com/${n}` }));
  await Promise.allSettled([
    createCheckoutSession({ ...request, user: { id: "other" }, priceId: "price_pro" }),
    createCheckoutSession({ ...request, user: { id: "third" }, priceId: "price_pro" }),
  ]);
  const created = (await Promise.all(stripe.checkout.sessions.create.mock.results.map((r) => r.value)))
    .map((session) => session.id);   // includes cs_first from the setup call
  const expired = stripe.checkout.sessions.expire.mock.calls.map(([id]) => id);
  const stored = getMockStore().purchaseAttempts.get(purchaseGuildId)!;
  expect(stored.state).toBe("open");
  expect(created.filter((id) => !expired.includes(id))).toEqual([stored.sessionId]);
});
```

(Metadata is echoed from the request because, with two writers, the store's current attempt may belong to the other request.)

In `test/services/initialPurchase.test.ts`: delete the `"a change to payment terms %p still blocks reuse"` test (its cases now live above) and add `expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();` to `"an open provider session is not released at the local deadline"` (same payer and terms still resume; Goal 2).

In `test/services/checkoutLockRecoveryOffer.test.ts`:

```ts
test("another payer superseding an introductory checkout releases the old reservation once and reserves it afresh", async () => {
  const { request } = introPurchaseFixture();
  await createCheckoutSession({ ...request, expectedOffer: "basic_intro_v1" });
  const first = getMockStore().purchaseAttempts.get(request.guildId)!;
  await expect(createCheckoutSession({ ...request, user: { id: "other" } })).resolves.toContain("checkout.stripe.com");
  const next = getMockStore().purchaseAttempts.get(request.guildId)!;
  expect(next.attemptId).not.toBe(first.attemptId);
  expect(await getOfferUsageRepository().get(request.guildId, "basic_intro_v1", "test"))
    .toMatchObject({ state: "reserved", operationId: next.attemptId });
});

test("the same payer switching from the intro offer to a promotion supersedes it", async () => {
  // first: automatic intro; second: promotionCodeId "promo_other", promotionCode "OTHER", offerChoice "promotion", expectedOffer "none"
  expect(getMockStore().purchaseAttempts.get(request.guildId)?.checkout.metadata)
    .toMatchObject({ purchase_offer_choice: "promotion" });
  expect(await getOfferUsageRepository().get(request.guildId, "basic_intro_v1", "test"))
    .toMatchObject({ state: "unused", released: { reason: "checkout_expired" } });
});
```

In `test/services/basicIntroOfferService.test.ts:839-858`, rename `"another payer and competing promotion cannot rewrite the frozen offer"` to `"a preparing introductory attempt still refuses another payer and a competing promotion"`: before the two calls, set the stored attempt's `state` to `"preparing"` and delete its `sessionId`; keep both rejections and the final `toEqual(attempt)` (with the edited attempt). Net line change must be zero or negative.

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test test/services/checkoutLockRecovery.test.ts test/services/checkoutLockRecoveryOffer.test.ts --coverage=false -t "supersed|refused|unknown expire|webhook releasing|incident review is never|concurrent"`
Expected: FAIL for the supersede, completed-in-another-tab, unknown-outcome, webhook and concurrent tests (they reject with "already in progress" and `expire` is never called). The still-open and incident-review tests already PASS and guard the change.

- [ ] **Step 3: Implement `reuseOpenOrCurrentAttempt` and `supersedeOpenAttempt` and call them from `reserve`**

`reserve`'s loop becomes: `preparePurchaseAttempt`; if `kind === "reuse"`, `const reused = await reuseOpenOrCurrentAttempt(input, preparation.current); if (reused !== "superseded") return reused; continue;`; otherwise the existing new-reservation code (prep without `current`, `previous = preparation.previous`). The fresh reservation therefore runs on the next iteration, after the old attempt is `expired` and its offer `unused`, so `freshIntroQuote` checks `expectedOffer` against the released state.

`reuseOpenOrCurrentAttempt` keeps today's reuse body for every non-open attempt exactly as it is (prep with `current`, then mode/payer/fingerprint mismatch throws `pending()`, analytics opt-out save, return `current`). An attempt is supersedable when `state === "open" && sessionId && !incidentKey`. For a supersedable attempt it returns `supersedeOpenAttempt(...)` when: mode or payer differs (checked before prep, so another payer never reaches `reuseIntroCheckout`); prep throws a `BillingActionError` with reason `discount_choice_required` or `offer_changed_terms` (an offer-choice, promotion or interval change against the frozen offer); or the fingerprint differs. The fingerprint is used as is (spec: it already excludes metadata and return URLs).

`supersedeOpenAttempt` ordering, which the anti-goals fix:

```ts
try {
  await input.owner!.effect(() => input.stripe.checkout.sessions.expire(current.sessionId!, undefined,
    { idempotencyKey: `purchase-supersede-${current.attemptId}` }));
} catch (error) {
  // A refused expire means the session already left `open`; the provider read below decides.
  if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) throw error;
}
let after: PurchaseAttempt | undefined;
try {
  after = await refreshAttempt(input, current);   // Stripe-confirmed expiry + offer release, or reconcile
} catch (error) {
  if (error instanceof BillingActionError && error.reason === "purchase_pending") return "superseded"; // CAS loss: re-read
  throw error;
}
if (after?.attemptId !== current.attemptId || after.state === "expired") return "superseded";
if (after.state === "completed") return after;     // createInitialPurchase answers currentOutcome
throw pending();                                    // still open after a refused expire
```

Unknown expire outcomes surface as `UnresolvedBillingMutation` from `owner.effect` and are rethrown, so nothing is released without provider proof.

- [ ] **Step 4: Run to verify they pass**

Run: `yarn test test/services/checkoutLockRecovery.test.ts test/services/checkoutLockRecoveryOffer.test.ts test/services/initialPurchase.test.ts test/services/basicIntroOfferService.test.ts test/api/billing.test.ts --coverage=false`
Expected: PASS. `"two different payers cannot obtain simultaneous first-purchase sessions"` still passes unchanged because the loser meets a `preparing` attempt, which is not supersedable.

- [ ] **Step 5: Commit**

```bash
git add src/services/initialPurchaseService.ts test/services/checkoutLockRecovery.test.ts test/services/checkoutLockRecoveryOffer.test.ts test/services/initialPurchase.test.ts test/services/basicIntroOfferService.test.ts
git commit -m "feat: supersede a live checkout when the payer or choice changes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Open checkouts stop making the Basic offer unavailable

**Files:**
- Create: `src/services/purchaseAttemptOffer.ts`
- Modify: `src/services/basicIntroOfferService.ts:299-366` (move out), `:380-430` (`getGuildBasicIntroOffer`, `pendingIntroOffer`)
- Test: `test/services/checkoutLockRecoveryOffer.test.ts`; modify `test/services/basicIntroOfferService.test.ts:506-548`

**Interfaces:**
- Produces in `purchaseAttemptOffer.ts` (moved unchanged, now exported): `ownsFrozenReservation(current: PurchaseAttempt, frozen: Extract<BasicIntroOffer, { status: "available" }>): Promise<boolean>`, `frozenIntroOffer(current: PurchaseAttempt | undefined): BasicIntroOffer | null`, `canReuseFrozenIntroOffer(frozen, current, interval: BillingInterval, payerId: string | undefined): frozen is Extract<BasicIntroOffer, { status: "available" }>`.
- Produces: `attemptIntroOffer(current: PurchaseAttempt, params: { payerId?: string; interval?: BillingInterval }): Promise<BasicIntroOffer | null>`: for `preparing`, `needs_review`, or `open` with an `incidentKey`, today's `pendingIntroOffer` result (frozen or `unavailable`); for any other `open` attempt, the frozen offer when it is reusable by this payer and owned, else `null`; for other states, `null`. `null` means "use the normal ledger quote".
- Produces: `openAttemptHoldsOffer(current: PurchaseAttempt | undefined, offerId: IntroOfferId): Promise<boolean>`: true when `current` is `open`, has a `sessionId`, no `incidentKey`, its frozen offer id is `offerId`, and `ownsFrozenReservation` holds.
- `basicIntroOfferService.ts` imports these back for `reuseIntroCheckout` and `prepareBasicIntroCheckoutWithAuthority`. Its line count must go down.

Why there is no frontend change: `Billing.tsx` (`basicPlanDisabled`, `checkoutIsBlocked`, `BillingCheckoutRecovery`) and `UpgradeServerSelect.tsx` (`offerBlocked`) only see `introOffer.status` from `billing.me`, and cannot tell an open attempt apart from the `preparing`, `needs_review` and ledger-failure cases where `unavailable` must still block. Fixing the status at the source satisfies Goal 4 on both pages. `Home.tsx` reads public pricing, which never reads attempts. The recovery notice also appears after a failed click (`failedCheckout`), which now only happens for `preparing` or a refused expire, where its copy is accurate.

- [ ] **Step 1: Write the failing tests** in `test/services/checkoutLockRecoveryOffer.test.ts`

```ts
test("an open Pro checkout does not make the Basic offer unavailable", async () => {
  const { request } = introPurchaseFixture();
  await createCheckoutSession({ ...request, priceId: "price_pro", tier: "pro", interval: "month" });
  expect(await getGuildBasicIntroOffer({ stripe: request.stripe, guildId: request.guildId, payerId: "other" }))
    .toMatchObject({ status: "available", id: "basic_intro_v1" });
});

test("another payer is quoted the reserved offer and the superseding checkout accepts that quote", async () => {
  const { request } = introPurchaseFixture();
  await createCheckoutSession({ ...request, expectedOffer: "basic_intro_v1" });
  const quote = await getGuildBasicIntroOffer({ stripe: request.stripe, guildId: request.guildId, payerId: "other" });
  expect(quote).toMatchObject({ status: "available", id: "basic_intro_v1" });
  expect(quote).not.toHaveProperty("reservedForCheckout");
  await expect(createCheckoutSession({ ...request, user: { id: "other" }, expectedOffer: "basic_intro_v1" }))
    .resolves.toContain("checkout.stripe.com");
});

test("a preparing attempt still makes the offer unavailable to another payer", async () => {
  // lost create response leaves `preparing`; see "stale unknown introductory checkout" in basicIntroOfferService.test.ts
  expect(await getGuildBasicIntroOffer({ stripe: request.stripe, guildId: request.guildId, payerId: "other" }))
    .toEqual({ status: "unavailable" });
});
```

In `basicIntroOfferService.test.ts`, `"a new comp grant preserves the same payer's reusable frozen offer"`: the `payerId: "other"` expectation becomes `.toMatchObject({ status: "available", id: "basic_intro_v1" })` and the `interval: "year"` expectation becomes `.toEqual({ status: "inactive" })` (the fixture configures no annual coupon, so the normal path is inactive). Same payer monthly stays `available` with `reservedForCheckout`. Same line count.

- [ ] **Step 2: Run to verify they fail**

Run: `yarn test test/services/checkoutLockRecoveryOffer.test.ts --coverage=false -t "open Pro|quoted the reserved|preparing attempt"`
Expected: first two FAIL with `{ status: "unavailable" }`; the preparing test PASSES.

- [ ] **Step 3: Implement**

Move the three helpers and `pendingIntroOffer` (as `attemptIntroOffer`) into `purchaseAttemptOffer.ts`. In `getGuildBasicIntroOffer`: `const held = current && (await attemptIntroOffer(current, params)); if (held) return held;` replaces the pending branch. In the ledger decision, `reserved` no longer maps to `unavailable` when `await openAttemptHoldsOffer(current, offerId)` is true (`offerId` is the monthly or annual id for `params.interval`, as in `selectedOfferDecision`); that case continues to `getBasicIntroOffer`, the quote the supersede path will verify after the release. `used` stays `ineligible`, every other non-`unused` state stays `unavailable`.

- [ ] **Step 4: Run to verify they pass**

Run: `yarn test test/services/checkoutLockRecoveryOffer.test.ts test/services/basicIntroOfferService.test.ts test/services/initialPurchase.test.ts --coverage=false`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/purchaseAttemptOffer.ts src/services/basicIntroOfferService.ts test/services/checkoutLockRecoveryOffer.test.ts test/services/basicIntroOfferService.test.ts
git commit -m "fix: quote the Basic offer while another checkout is open

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation, ADR and agent rule

**Files:**
- Create: `docs/adr-20261027-checkout-supersede.md`
- Modify: `docs/billing-initial-purchases.md`, `apps/docs-site/docs/admin/setup-and-access.md:184-189`, `apps/docs-site/docs/whats-new/index.md` (new entry at the top of `## 2026`), `AGENTS.md` (Known nuances / gotchas)

- [ ] **Step 1: ADR** in the format of `docs/adr-20260106-voice-receiver-resubscribe.md` (Status: Accepted, Date: 2026-10-27, Owners: Billing; Context, Decision, Consequences, Alternatives Considered, Notes). Context: the stale lock incident and the earlier "no provider cancellation" decision in `billing-initial-purchases.md`. Decision: a live `open` Checkout is expired at Stripe only when a different payer, plan, interval, price or discount supersedes it; release still requires Stripe-confirmed `expired` with no subscription; a refused expire is resolved by reading the session (complete reconciles, open keeps `purchase_pending`); billing load and plan change release locally expired attempts through `refreshAttempt`. Alternatives: TTL unlock or sweeper (rejected by spec), refusing other payers (the incident), relying on the `checkout.session.expired` webhook (not delivered in production). Notes: two admins can supersede each other, accepted; the webhook stays an optimization.

- [ ] **Step 2: `docs/billing-initial-purchases.md`**: replace "No new table, TTL unlock, sweeper, history UI or provider cancellation is introduced." with a sentence that drops provider cancellation from the list and points to the ADR; replace "price, discount and payer changes still receive an in-progress error" with the supersede behavior (expire at Stripe, guarded release including the offer reservation, fresh reservation; refused expire handling); in the expiry paragraph and "Request-time and webhook expiry release it", add that a billing page load or plan change also performs the provider read once local expiry has passed, still releasing only on confirmed expiry.

- [ ] **Step 3: Public docs.** This changes user-visible billing behavior, so it gets a docs delta, not `docs-exempt`. Replace the `setup-and-access.md` paragraph with:

> Only one initial checkout can be in progress for a server. Choosing the same plan again resumes it. Choosing a different plan, billing period or discount, or starting a purchase as a different server manager, ends the earlier checkout and opens a new one. If the earlier checkout was already paid, billing shows that subscription instead. A checkout that was closed without paying no longer blocks the billing page once it expires. If billing says the purchase needs review, contact support before trying to purchase again.

Add to What's New:

> ### Abandoned checkouts no longer block billing (October 27)
>
> - Closing Checkout without paying no longer leaves Basic or Pro unavailable on the billing page.
> - Choosing a different plan, or another server manager starting a purchase, replaces the earlier unpaid checkout instead of showing an in-progress error. See [Setup and access](/admin/setup-and-access).

(Check the link target slug against the page's front matter when editing.)

- [ ] **Step 4: AGENTS.md** bullet under Known nuances / gotchas: "**Any surface that blocks on a purchase attempt's state must call `releaseExpiredPurchaseAttempt` first.** The `checkout.session.expired` webhook is not guaranteed to arrive, and an `open` attempt past its local `checkout.expires_at` only clears through a provider read. `getBillingSnapshot` and `prepareBillingChangeOwned` do this; a new reader that skips it recreates the stale-lock incident. A live `open` attempt is superseded (expired at Stripe, then released through `refreshAttempt`) only from `reserve`."

- [ ] **Step 5: Verify docs**

Run: `yarn docs:check` and `yarn markdownlint:check`
Expected: both exit 0. `grep -n "—" docs/adr-20261027-checkout-supersede.md docs/billing-initial-purchases.md apps/docs-site/docs/admin/setup-and-access.md apps/docs-site/docs/whats-new/index.md` prints nothing new.

- [ ] **Step 6: Commit**

```bash
git add docs/adr-20261027-checkout-supersede.md docs/billing-initial-purchases.md apps/docs-site/docs/admin/setup-and-access.md apps/docs-site/docs/whats-new/index.md AGENTS.md
git commit -m "docs: record checkout supersede and read-path release

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Full gate

- [ ] **Step 1:** Run `yarn lint:check`. Expected: exit 0.
- [ ] **Step 2:** Run `yarn prettier:check`. Expected: exit 0.
- [ ] **Step 3:** Run `yarn test`. Expected: all suites pass and the coverage thresholds in `jest.config.ts` hold.
- [ ] **Step 4:** Run `yarn build:all`. Expected: exit 0.
- [ ] **Step 5:** Run `yarn docs:check`. Expected: exit 0.
- [ ] **Step 6:** Run `yarn check:quality --base origin/master` (needs `QUALITY_RATCHET_HOME`, see `docs/engineering/code-quality.md`). Expected: exit 0. A file-size finding on `basicIntroOfferService.ts` or either large test file means a move in Task 1 or Task 4 was incomplete; fix it, do not request an exception.
- [ ] **Step 7:** Run `git diff --name-only master...HEAD -- src/frontend`. Expected: prints nothing. This plan changes no UI, so AGENTS.md's Storybook screenshot review does not apply. If it prints a path, run `yarn storybook`, `yarn test-storybook`, and the VLM review of `test/storybook/screenshots` for the touched component before finishing.
