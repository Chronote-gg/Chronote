# ADR-20261112: Automatic portal sign-in recovery

Status: Accepted  
Date: 2026-11-12  
Owners: Portal and authentication

## Context

The portal can retain a cached identity after the server session expires. Private
navigation then requests data with an unusable session, requiring a manual page
refresh to recover. Returning Discord users also encounter another authorization
step when their previous grant could be reused.

## Decision

- Recheck stale identity on private entry and reconcile current-session request
  rejections through the existing auth owner. Bound each recovery episode to one
  identity check and one resumed read. Never replay mutations.
- Use Discord's `prompt=none` for ordinary login. Explicit recovery and Switch
  account use `consent`.
- Bind each validated return destination and optional recovery ID to an atomic,
  single-use OAuth state record. Login and install records use separate
  namespaces in the existing session table and retain its expiry policy.
- Keep unfinished local work mounted during same-actor recovery. Warn before
  leaving for sign-in, disable authenticated actions while paused, and discard
  the retained subtree when the actor changes.
- Keep permission failures, unavailable identity checks and empty results
  distinct. EventSource errors request an identity check without establishing
  that the session expired or consuming the session-rejection budget. External
  provider credential errors retain their own reconnect guidance.

## Consequences

Private navigation can recover without a manual refresh. Browser-session recovery
metadata prevents repeated automatic redirects when cookies are unavailable.
Callback outcome hints never establish authentication. Public routes remain
available without starting automatic recovery.

Session lifetime, OAuth scopes, CSRF protection and existing DynamoDB session and
install payloads remain compatible. Draft content stays in memory. Choosing to
leave can discard it after the warning; persistent draft restoration is deferred.

## Alternatives Considered

Always requiring another sign-in click adds friction without reconciling cached
identity. Longer sessions postpone expiry without repairing recovery. A new auth
framework or persistent draft storage would expand this change unnecessarily.

## Notes

See the [approved design](superpowers/specs/2026-11-12-portal-auth-recovery-design.md)
and [implementation plan](superpowers/plans/2026-11-12-portal-auth-recovery.md).
Local synthetic tests and screenshots do not establish live Discord consent,
revoked-grant or private-browser behavior. Controlled provider acceptance and
deployment remain separate.
