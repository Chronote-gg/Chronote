# Server subscription transitions

Existing nonterminal Stripe subscriptions must not enter subscription Checkout.
The billing service retrieves the saved subscription and uses a hosted
`subscription_update_confirm` flow with its existing customer and item. Stripe
confirms the change; the redirect never grants entitlements. Unsupported states
and provider failures stop without a fallback purchase.

Manage Server permission is required at the API boundary. Existing Stripe billing
also requires the customer's `metadata.discord_id` to match the signed-in user.
An email match alone does not authorize use of a Stripe customer. Missing legacy
payer metadata requires explicit operator reconciliation, not an automatic claim.

Webhook reconciliation reads the current Stripe subscription rather than applying
historical event snapshots. A conditional write checks the saved subscription ID
and revision. On conflict it re-reads both sources. Events from another subscription
cannot overwrite a current nonterminal subscription. Replacing a terminal one
requires a provider-confirmed newer subscription; equal creation timestamps fail
closed. Rejected writes do not revoke comp grants.

## Deployment prerequisite

`STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED` defaults to false; only the exact value
`true` enables hosted transitions. While disabled, any saved subscription ID stops
the purchase request before subscription/customer retrieval or session creation
with actionable guidance. The router can still read price and promotion metadata
before reaching this guard. It cannot fall
through to new Checkout. This conservatively includes terminal subscriptions that
would otherwise qualify for a new purchase. Enable only after hosted test-mode
validation and a deliberate activation decision. No production setting is changed
by this PR.

The shared ECS task definition wires the default-false Terraform boolean into
the container environment for production and sandbox. After validation and
explicit activation approval, set the environment-scoped GitHub Actions variable
`TFVAR_STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED=true`, review and apply the Terraform
plan, then deploy the backend to move the service to the new task definition.
Setting the variable or applying Terraform alone does not activate the running
service. Reversing those steps with false disables new transition requests.

This guard covers hosted transition requests, not the entire billing release.
Initial purchases still use Checkout, the payer-checked general management portal
remains available, and current-state webhook reconciliation remains active. Portal
capabilities still depend on the external Stripe configuration. Payer checks,
customer ownership matching, conditional persistence, cache invalidation and comp
reconciliation changes deploy normally. No parallel legacy webhook path is kept.
Merging master automatically starts production deployment after CI; there is no
source-only merge boundary. Keep the PR unmerged if those remaining live changes
are not approved. The guard is not proof of hosted payment or webhook behavior.

Code deployment does not configure Stripe. Before enabling this path, verify the
portal configuration allows the intended target prices, uses the reviewed
proration behavior, and preserves trials. Never create or reconfigure a portal
configuration during a customer request.

At the September 4, 2026 read-only audit, the production default configuration
disabled subscription updates and set proration to `none`. All four existing plan
prices had inclusive tax behavior and shared one product. Stripe does not allow
multiple selectable prices with the same product and recurring interval in a
portal configuration. A narrow Basic-to-Pro configuration can offer the two Pro
prices (monthly and annual). Enabling all four is not a valid shortcut. Broader
plan switching needs a separately reviewed configuration/catalog design.

Before production activation, validate with disposable test-mode fixtures:

1. Basic-to-Pro confirmation retains the customer, subscription and item IDs.
2. The preview identifies the chosen price and proration; abandoning it leaves
   Basic intact.
3. Successful confirmation settles the expected invoice and updates the portal
   only through webhook reconciliation.
4. Declined payment and required authentication do not create another subscription
   or grant a pending Pro price as though it were applied.
5. A trial remains a trial, existing discounts survive when no replacement is
   requested, and a requested valid promotion appears in confirmation.
6. Replay and out-of-order webhook tests preserve the final provider state.

Disable subscription updates to roll back activation while retaining the safe
backend guard. Do not roll back to a backend that creates a new subscription for
an existing paid server. Configuration rollback does not undo customer-confirmed
changes or invoices, which require separate reconciliation.

## Scope limits

This change prevents an existing known subscription's upgrade from creating a
second subscription. It does not reserve initial Checkout sessions across multiple
simultaneous first purchases or repair/refund historical duplicates. Comp grants
and the existing past-due entitlement policy remain separate from provider state.
Local fixtures and SDK command tests do not certify live Stripe configuration or
payment behavior.

References: [Stripe confirmation flows](https://docs.stripe.com/customer-management/portal-deep-links),
[portal limitations](https://docs.stripe.com/customer-management#limitations),
[webhook ordering](https://docs.stripe.com/webhooks#event-ordering).
