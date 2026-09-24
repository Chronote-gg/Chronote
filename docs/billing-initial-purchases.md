# Initial server purchases

Initial subscription Checkout is coordinated per guild in DynamoDB. Manage Server
permission and the existing payer checks still apply. Existing-subscription
transition activation is unchanged and remains default-off.

The control record uses `PURCHASE#<guildId>` in GuildSubscriptionTable. Dedicated
helpers enforce snowflake guild IDs and keep control records out of subscription
readers. A transaction checks the original subscription ID/revision and the
attempt revision. Subscription whole-row writes cannot erase this record. No new
table, TTL unlock, sweeper, history UI or provider cancellation is introduced.

The attempt freezes customer selection or creation before making its provider
call, then freezes the Checkout request. Separate opaque idempotency keys identify
these operations. Concurrent different payers or requests receive an in-progress
error; another payer never receives the first payer's hosted Checkout URL. The
session's guild, attempt, customer and provider mode must match before returning
its URL. Responses never grant entitlement.

Checkout expires after one hour. A cancel redirect, closed browser or local clock
expiry does not release the reservation. A known session is retrieved from Stripe;
only confirmed expiration without a subscription permits replacement. Unknown
creation results remain reserved and become review-required after the bounded
replay window. An old idempotency key is never retried indefinitely. Completed
sessions reconcile current provider subscription state, including when webhook
processing precedes the request's response. The caller receives billing navigation
or an actionable pending/review error instead of a stale payable URL.

A completed attempt can retire only after its linked subscription is confirmed
terminal, the existing transition guard permits repurchase, and the pointer and
attempt revisions remain unchanged. Unresolved incidents block retirement. Late
completion or expiration from another attempt cannot release the current attempt.

## Duplicate subscriptions

A competing nonterminal subscription cannot replace an accepted nonterminal
subscription. The rejection now records a deterministic incident under
`PURCHASE#<guildId>#DUPLICATE#<mode>#<sorted subscription IDs>` and atomically blocks
the current control record for review. Replays update the same incident rather
than appending to an unbounded array. First observation and original incoming attempt provenance are preserved with `if_not_exists`; last observation, statuses and the bounded reason remain available for operator review. Invoice-success handling records payment
before reconciliation, so invoice-first delivery also surfaces the duplicate.

The control record holds a bounded incident pointer, not complete incident history.
Operator inspection uses exact keys; no history query or scan is needed. The
presence of two nonterminal subscriptions is duplicate risk, not proof of two paid
invoices. Historical duplicates without a new event are not discovered by this
change.

Operator reconciliation must verify current subscription, customer, invoice and
attempt associations and obtain separate direct approval for any billing action.
There is no automatic cancellation, refund, payer transfer, canonical-pointer
replacement or incident clearing. Do not delete an unresolved control record to
unblock a purchase.

## Webhook recovery

New receipts distinguish processing from completed. Processing carries a 60-second
lease and opaque owner token. Another delivery during processing receives a
retryable 503. After expiration, a new worker may reclaim the event. Only the
current unexpired owner can complete or release its claim. Completion follows
handler persistence, including incident persistence. Existing conditional
subscription writes, payment upserts and active-only comp revocations make replay
safe for these effects. A lease is not an exactly-once provider guarantee.

Legacy receipts with no processing state retain their previous completed meaning;
this does not recover historical poisoned claims. Recovery requires another
provider delivery or explicit replay. There is no autonomous background retry.
Receipt TTL is cleanup, never the purchase lock. The expiry webhook is an
optimization; request-time provider checks handle missed expiry delivery.

## Release and verification boundary

The ECS task policy adds only `dynamodb:ConditionCheckItem` on GuildSubscriptionTable. Review and apply that IAM change before releasing the application, or initial purchase transactions fail closed. Source merge auto-deploys, so do not merge ahead of that separately approved IAM apply. No live policy was changed during implementation.

Tests exercise deterministic request/webhook interleavings and DynamoDB command
conditions with mock provider data. They do not certify hosted Stripe payment,
3DS, live webhook configuration or operational recovery. No live billing actions
are part of source validation. Merging master starts deployment, so publishing and
release remain separately authorized steps. If enabled in the provider endpoint,
`checkout.session.expired` accelerates cleanup; it is not required for safe
request-time recovery.
