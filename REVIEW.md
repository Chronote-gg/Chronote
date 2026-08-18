# Review Instructions

## What Important Means Here

Reserve Important findings for defects introduced by the pull request that
could lose or expose meeting audio, transcripts, notes, credentials, or
personal data; cross guild, channel, meeting, or personal-ownership boundaries;
break billing, OAuth, webhook, Discord interaction, recording, transcription,
or notes state; notify users unexpectedly; or make deployment and recovery
unsafe for active recordings.

Style, naming, broad refactor preferences, missing comments, and test coverage
suggestions are Nit at most unless they hide a concrete product, privacy,
security, billing, or operational risk.

## Noise Controls

- Do not report formatting, lint, type errors, generated files, routine
  lockfile churn, or issues already enforced by CI. Do report dependency or
  workflow changes that create a concrete integrity, credential, permission,
  provider, or runtime risk.
- Do not recommend a new abstraction unless duplication creates a real
  correctness, privacy, security, or operational risk.
- Do not flag pre-existing issues as pull request blockers. Identify them as
  pre-existing in the summary if they warrant separate follow-up.
- On follow-up reviews, suppress new nits unless the latest pushed code
  introduced them.

## Evidence Bar

Every finding should name the exact file and line, explain the changed
behavior, connect it to a Chronote invariant, and suggest the smallest safe
fix. Put concerns that depend on product judgment or unavailable runtime data
in the summary instead of presenting them as confirmed blockers.

## Chronote Checks

- Every meeting read must preserve guild, channel, ownership, and share access
  checks. Pointer indexes and MCP service-account scopes may narrow access but
  must never replace or widen the canonical MeetingHistory permission check.
- Generated notes must strip unknown Discord mentions. Notes-derived ordinary
  message content must disable mention parsing, and all non-Discord read
  surfaces must resolve mentions through the shared mention service.
- Discord interactions must acknowledge within the platform deadline, and
  retries or partial failures must not duplicate meetings, commands, notes,
  corrections, billing state, or provider events.
- Billing and OAuth changes must preserve signature and CSRF validation,
  idempotency, token encryption or hashing, resource and scope binding, and
  tenant isolation. Never expose secrets or user content in logs or analytics.
- Bot and API runtime changes must preserve lease ownership and targeted
  meeting-control routing. Deploy workflows must not replace bot tasks while
  an unexpired active-meeting lease remains.
- Recording and transcription changes must retain the two-hour per-source
  boundary, client-first stop-and-upload behavior, guardrails for silent or
  hallucinated audio, and recoverable state across partial uploads.
- DynamoDB and S3 changes must preserve key shapes, access re-checks,
  encryption, expiry, and retry-safe transitions. A failed side effect must not
  be recorded as completed state.
- Product analytics may carry counts and enums, not notes, transcripts,
  prompts, dictionary terms, question text, or extra stable identifiers.
- Public route and UI changes must preserve route-specific metadata and the
  repository's Storybook and visual-review evidence requirements.
