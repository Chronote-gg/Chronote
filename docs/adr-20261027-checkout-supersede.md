# ADR-20261027: Checkout Supersede and Read-Path Release

Status: Accepted  
Date: 2026-10-27  
Owners: Billing

## Context

Initial server purchases hold one purchase attempt per guild
(`docs/billing-initial-purchases.md`). An `open` attempt was released only by
the `checkout.session.expired` webhook or by a later purchase request that
reread the session from Stripe. The original design also chose not to cancel
sessions at the provider, so a different payer, plan, interval, price or
discount received an in-progress error until the session expired.

In production the expiry webhook was not delivered. A Checkout closed without
paying stayed `open` locally after Stripe expired it, the billing page showed
Basic and Pro as unavailable, and other server managers could not purchase. Loading
the billing page never reread the session, so nothing cleared the lock.

## Decision

1. `releaseExpiredPurchaseAttempt` runs on billing load (`getBillingSnapshot`)
   and before the plan change pending check (`prepareBillingChangeOwned`). An
   `open` attempt past its local `checkout.expires_at` is read from Stripe
   through `refreshAttempt`. It is released only when Stripe confirms `expired`
   with no subscription, reconciled when the session is `complete`, and left
   alone otherwise. Every error is caught so the page still loads.
2. `reserve` supersedes a live `open` attempt when the payer, mode or payment
   terms differ, including an intro offer choice, promotion or interval change.
   It expires the session at Stripe (`checkout.sessions.expire` with
   idempotency key `purchase-supersede-<attemptId>`), releases through
   `refreshAttempt` (which also releases any intro offer reservation), then
   reserves a fresh attempt. Release still requires Stripe-confirmed `expired`
   with no subscription.
3. A refused expire is resolved by reading the session. A `complete` session
   reconciles and returns the normal completed-purchase outcome; a session
   still `open` keeps the `purchase_pending` error. An unknown expire outcome
   is rethrown and nothing is released.
4. If the release step fails and the attempt revision has moved, for example
   because the expiry webhook that the expire triggers committed first, the
   request treats the attempt as superseded and continues. An unknown outcome
   of the request's own release write is rethrown first, so it never creates a
   second Checkout.
5. `getGuildBasicIntroOffer` no longer reports the Basic offer as unavailable
   while an `open` attempt is live. The same payer keeps its frozen reserved
   offer and anyone else gets the normal quote. `preparing`, `needs_review` and
   incident rows still block.

## Consequences

Positive:

- An abandoned Checkout stops blocking billing once it expires, without
  depending on webhook delivery.
- A different plan, discount or payer replaces an unpaid Checkout instead of
  returning an in-progress error.
- A paid session is never released: every release path rereads Stripe.

Costs and risks:

- Billing load and plan change can add one Stripe read when an attempt is past
  local expiry.
- Supersede adds a provider write to the purchase path, and an unpaid Checkout
  a payer still has open stops working when someone else supersedes it.

## Alternatives Considered

1. Release on a TTL or with a background sweeper. Out of scope in the spec, and
   local time alone cannot tell an expired session from a paid one.
2. Keep refusing other payers and changed terms until expiry. This is the
   behavior that produced the incident.
3. Rely on the `checkout.session.expired` webhook. It was not delivered in
   production, so correctness cannot depend on it.

## Notes

- Two admins can supersede each other's Checkout. Accepted.
- `reserve` retries at most three times, so heavy mutual superseding can leave
  neither admin with a live Checkout until the next click.
- While intro offer coverage is unresolved, a second payer can be quoted the
  offer, and their click expires the first Checkout before being refused. No
  charge results.
- The `checkout.session.expired` webhook stays an optimization, not a
  requirement.
