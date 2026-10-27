# Checkout lock recovery design

Date: 2026-10-27. Status: approved in conversation, pending implementation plan.

## Why

A server's buyer opened a Pro Checkout, closed it without paying, and came back to a billing page they could not use. Six days later the server's purchase attempt (`PURCHASE#<guildId>` in GuildSubscriptionTable) was still `open`. Basic was disabled, the page said "A previous checkout may still be pending", and "Refresh offers" changed nothing. Support had to release the lock with a manual production write. The private incident record lives in chronote-ops (`incidents/2026-10-27-stale-purchase-lock.md`).

Root cause, on master as of bc6347fe:

- An `open` attempt is only released to `expired` by the `checkout.session.expired` webhook (`src/api/billing.ts`, event map) or by `refreshAttempt` inside the checkout mutation (`src/services/initialPurchaseService.ts`, `refreshAttempt` and `preparePurchaseAttempt`).
- The live webhook endpoint did not deliver `checkout.session.expired`.
- The billing page read path never checks expiry. `getBillingSnapshot` (`src/services/billingService.ts`, the `Promise.all` that calls `getGuildBasicIntroOffer` twice) reaches `getGuildBasicIntroOffer` (`src/services/basicIntroOfferService.ts`), which returns `{ status: "unavailable" }` for any `open`, `preparing` or `needs_review` attempt without reading `checkout.expires_at`. The frontend disables Basic on `unavailable` (`basicPlanDisabled` and `checkoutIsBlocked` in `src/frontend/pages/Billing.tsx`, `offerBlocked` in `src/frontend/pages/UpgradeServerSelect.tsx`).
- `prepareBillingChangeOwned` (`src/services/billingChangeService.ts`) throws `changePending()` for the same states, with the same lack of an expiry check.

## Intent

No server should ever be stuck because someone started a checkout and walked away. A buyer who comes back to the billing page, an hour or a week later, either continues where they left off or gets a fresh checkout. They never see a disabled plan with a vague pending notice because of an abandoned checkout.

## Goals

1. **Expired checkouts release on read.** When billing state is loaded for a server whose attempt is `open` and past `checkout.expires_at`, the attempt is released through the existing guarded expiry path before the snapshot is built. The buyer sees plans normally and their next click creates a fresh Checkout. The same release runs before the plan change path checks for a pending purchase.
2. **Same choice resumes.** If the attempt is `open`, not expired, and the new request has the same payer, mode and fingerprint, the buyer is sent to the existing Stripe Checkout URL. This is current behavior and must keep working.
3. **Different choice starts fresh.** If the attempt is `open`, not expired, and the new request differs in payer, plan, interval, price or discount, Chronote cancels the old Checkout session with Stripe (`checkout.sessions.expire`), releases the attempt and any intro offer reservation it held, and creates a fresh Checkout for the new request. This replaces today's `purchase_pending` refusal for that case. Decided by BASIC: this applies to a different admin on the same server too.
4. **The billing page stops blocking on open checkouts.** An `open` attempt no longer makes the Basic offer `unavailable` or disables any plan button. The "A previous checkout may still be pending" recovery notice no longer appears for an `open` attempt.

## Non-goals

- A "welcome back, here's where you left off" message. Desirable later, explicitly not MVP (BASIC).
- Enabling `checkout.session.expired` on the live Stripe webhook endpoint. That is a dashboard change BASIC makes. A separate webhook inventory tracks drift between handled and subscribed events.
- Changing `needs_review` handling. That state means competing subscriptions or an unknown creation result and needs a human. It keeps blocking as it does today.
- A background sweeper, TTL unlock or new table.

## Anti-goals

These would make the fix a failure even if the lock clears:

- **Any path that can charge twice or grant a second subscription.** Releasing or cancelling must only happen after Stripe confirms the session is expired with no subscription. A buyer completing payment in another tab at the same moment must end with exactly one subscription, recorded normally.
- **Handing one payer another payer's hosted Checkout URL.** Existing rule; preserved. A different payer gets a fresh session, never the old URL.
- **A Stripe call on every billing page load.** The read-path check runs only when an `open` attempt exists and its `checkout.expires_at` has passed by local clock. Live sessions and servers with no attempt cost nothing extra.
- **Losing or double-counting an intro offer reservation.** Releasing an attempt that reserved an intro offer must move the offer usage record back exactly as the webhook expiry path does today.

## Constraints

- **Reuse the existing guarded transitions.** The webhook handler `expirePurchaseAttemptOwned` (`src/services/purchaseReconciliation.ts`), `refreshAttempt`, and `prepareExpiredOfferRelease` (`src/services/offerUsageService.ts`) already retrieve the session, check association (`src/services/purchaseSession.ts`), require `status === "expired"` with no subscription, and compare-and-write the attempt plus the offer release. The new read-path release and the new supersede path go through the same functions, not new writes. Writes keep going through the runtime billing owner (`owner.effect`) like the existing paths.
- **Compare-and-write losses are normal.** If a concurrent writer changes the attempt, re-read and continue from the current state. Do not surface a concurrency error to a page load.
- **DynamoDB data compatibility.** No change to the `PurchaseAttempt` shape or keys (AGENTS.md backward compatibility rule). Existing `open`, `expired` and `completed` rows must keep working.
- **Read path must degrade, not fail.** If Stripe is unreachable during a read-path release, the snapshot still loads with the attempt treated as it is today. Recovery happens on the next load or click.
- Repo rules: AGENTS.md typing, KISS/YAGNI, no em dashes in docs and copy, Storybook and visual review for UI changes, tests for every modified file.

## Decided behavior

| Attempt state at request time | Request | Result |
| --- | --- | --- |
| none, `expired`, retired `completed` | any checkout | fresh Checkout (unchanged) |
| `open`, past `expires_at` | billing page load | guarded release to `expired`, then normal snapshot |
| `open`, past `expires_at` | checkout click | guarded release, fresh Checkout (unchanged) |
| `open`, live | same payer, mode and fingerprint | same Checkout URL (unchanged) |
| `open`, live | different payer, plan, interval, price or discount | expire old session at Stripe, guarded release, fresh Checkout |
| `open`, live, Stripe refuses the expire | different choice | retrieve the session: if `complete`, reconcile it and return the normal completed-purchase result, not a new Checkout; if still `open` (for example a payment is processing), keep today's `purchase_pending` for this request |
| `open`, past `expires_at`, Stripe reports `complete` | billing page load | reconcile the completed session the way `refreshAttempt` does on click, so the row stops being `open` |
| `preparing` | any | unchanged (short replay window, then `needs_review`) |
| `needs_review` | any | unchanged (blocks, needs a human) |
| `open`, live or expired | plan change for an existing subscriber | run the release above first; block only if still `open` and live |

## Calls made by the design author

These were not discussed with BASIC; they follow from the decisions above and the existing code.

- The two rows above for a refused expire and for a past-expiry `complete` session. Verify during planning whether Stripe can refuse `checkout.sessions.expire` while a session is still `open` with a payment processing, not only when it is `complete`.
- The read path reuses `refreshAttempt` rather than calling the webhook's `expirePurchaseAttemptOwned` directly, because `refreshAttempt` already covers both the expired and the completed outcomes.
- Two admins choosing different plans at the same moment can supersede each other in turn. This follows from letting a different admin supersede, charges nobody twice, and is accepted rather than guarded against.
- The fingerprint already excludes metadata and return URLs, so a fingerprint mismatch is treated as a genuine change of choice. No extra normalization is added.

## Left to the builder

- Where the read-path release lives (a small helper called from `getBillingSnapshot` and `prepareBillingChangeOwned`, or inside the purchase repository read) and how it obtains a runtime billing owner on a read request.
- How the supersede path orders the Stripe expire call, the guarded release and the new reservation inside `reserve`, as long as the anti-goals hold.
- Whether `getGuildBasicIntroOffer` still needs a special case for live `open` attempts, beyond reusing a frozen intro offer for the same payer, once the frontend no longer blocks on `unavailable` for them. Whatever it returns, the intro offer the page quotes to a second payer must agree with the `expectedOffer` check that runs after the old reservation is released.
- Frontend copy and component changes, and which existing tests change versus get added. Existing tests that assert `unavailable` for pending rows (`test/services/basicIntroOfferService.test.ts`) should be revisited, not deleted blindly.
- Test layering: unit tests for the release and supersede paths with a mocked Stripe client (expired, live, completed-concurrently, Stripe error, CAS loss), webhook and read path coexisting, plus frontend tests and Storybook coverage for the billing page with an `open` attempt.

## Docs to update

- `docs/billing-initial-purchases.md`: it currently says no provider cancellation is introduced and that price, discount and payer changes receive an in-progress error. Both change.
- `AGENTS.md` if the purchase lock gains a rule future agents need (for example, read-path release is required for any new surface that blocks on attempt state).
- An ADR in `docs/` (`adr-YYYYMMDD-<slug>.md`) for introducing provider cancellation of a live Checkout, since it reverses a documented decision.
- Public docs in `apps/docs-site/` only if user-visible billing copy changes; otherwise `docs-exempt` with rationale.
