# DAVE reset and recovery diagnostics

Status: approved for implementation on October 12, 2026. Release and a new monitoring schedule require separate authorization.

## Intent

When an Opus decoder input follows DAVE's `not-ready` passthrough path, distinguish initial MLS waiting, an epoch reset, invalid MLS recovery, and recovery replies suppressed during resume. The existing immutable per-input snapshot establishes the failing input's readiness and decrypt decision, but cannot distinguish these causes.

Local native controls reproduce a recovery defect: decrypt failures while Resuming reset native readiness, both recovery reply gates skip their sends, and Resumed restores transport Ready without retrying those replies. This establishes a local mechanism, not the cause of a production incident. Initial waiting and invalid MLS handling can produce similar outer states.

The user's direction is a small content-free diagnostic extension. My design choice is four fixed fields on the existing decoder-error warning, backed by only the latest reset episode. No history, counters, new logging surface, or recovery behavior change.

## Scope and alternatives

Extend the current `@discordjs/voice` patch and `OpusDiagnosticDecoder`. Preserve passthrough, native decrypt calls, failure thresholds, state gates, message ordering, capture-incomplete marking and resubscription behavior.

Keeping the current snapshot alone cannot separate the hypotheses. A lifecycle event history could explain more ordering but would add logs and correlation work. A recovery-gate patch could fix the synthetic defect, but would not identify whether that path explains observed failures. The latest-episode snapshot is the smallest next diagnostic.

## Four added warning fields

| Field                         | Values                                                                                                                                  | Meaning                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daveResetReason`             | `none`, `initial`, `epoch-1`, `invalid-welcome`, `invalid-commit`, `decrypt-failures`, `unknown`; missing metadata formats as `UNKNOWN` | Trigger of the latest native initialization/reinitialization/reset attempt. `none` means no native attempt yet. This does not claim that an attempt succeeded. |
| `daveResetAgoMs`              | Nonnegative integer; `none` if no attempt has occurred; `UNKNOWN` if metadata is missing                                                | Age of that attempt when the receiver processes this input, not when the decoder later fails.                                                                  |
| `daveKeyPackageDisposition`   | `not-emitted`, `send-returned`, `skipped-resuming`, `skipped-other-state`, `send-threw`; missing metadata is `UNKNOWN`                  | Latest key-package dispatch disposition within that reset episode.                                                                                             |
| `daveInvalidationDisposition` | Same disposition values                                                                                                                 | Latest invalidation dispatch disposition within that episode.                                                                                                  |

`send-returned` means the existing WebSocket send method returned normally. The wrapper can catch a transport exception, emit an error, and still return normally; this disposition does not establish wire delivery, server acknowledgment, acceptance, or native activation. Tracking that emitted transport error is outside this four-field scope. `send-threw` means the method itself threw; propagate the original exception unchanged. `skipped-resuming` requires Networking Resuming at the existing send gate; other rejected states use `skipped-other-state`.

`unknown` is a recorded attempt whose trigger is not classified; `UNKNOWN` means the evidence was absent. `not-emitted` means the instrumented episode has not emitted that reply. It must never substitute for missing instrumentation.

## Ownership and event sequence

The DAVE wrapper owns one small mutable episode record: reason, attempt timestamp, and the two dispositions. Do not retain packet data, key packages, transition IDs, connected-client lists, identities, or exception text in this record.

Initialize the instrumented record to reason `none`, absent timestamp, and both dispositions `not-emitted`. A protocol-zero `reinit()` with no native session does no native work and leaves that record unchanged. An actual native initialization, reinitialization or reset starts an attempt episode; absence of the instrumented record instead means `UNKNOWN`.

Start a fresh episode for initial initialization, accepted epoch-1 reinitialization, and each recovery that actually passes the existing `reinitializing` guard. Label failed welcome and failed commit separately; label threshold-triggered recovery as `decrypt-failures`. An otherwise unclassified direct `reinit()` starts an `unknown` episode. Ignored epochs and suppressed duplicate recoveries do not replace the record.

For recovery, begin the episode before the existing invalidation emission, then retain that same episode through reinitialization and key-package emission. Starting it again inside `reinit()` would erase the invalidation disposition and is incorrect. Initial and epoch paths start their own episode. Preserve the exact order of native operations and outbound messages.

Attach the episode reference as an additional internal event argument, leaving the existing first argument and behavior intact, or use an equally small explicit session-bound callback. The networking handler must update the emitting wrapper's episode, even during initial creation before the new wrapper is installed in networking state. Do not assume `networking.state.dave` is the emitter.

At each existing reply gate, record the skip reason when rejected. When allowed, mark `send-threw` immediately before the existing send and `send-returned` only after it returns, so failures keep their original exception behavior. Instrumentation must not retry, queue, replay, or suppress any reply.

Keep the last episode after native readiness returns. A later reset replaces it; a new DAVE wrapper starts fresh. Neither Resumed nor execute-transition clears the evidence. Diagnostic fields describe the last reset, while the existing `daveReady` field describes current native readiness.

## Per-input correlation

While constructing the existing receiver snapshot, copy the episode's scalar values and calculate reset age with the same clock/clamp convention as transition age. Do not put the mutable episode object into the WeakMap. Freeze the completed snapshot as today.

The decoder keeps that exact snapshot when its transform fails, including buffered writes. A later reset, reply send, Resumed event, or native activation must not change an earlier input's diagnostics. CJS, ESM and both declaration files expose the same four fields. Missing wrapper/episode metadata stays `UNKNOWN`.

Continue formatting these fields only on the existing Opus decoder-error marker. The paired decoded-stream warning remains unchanged and is still deduplicated by meeting. No successful-input logs, new lifecycle markers, analytics properties, or broad voice debugging.

## Interpretation and limits

| Failing-input evidence                                           | Supported next investigation                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `not-ready`, `initial`, key package `send-returned`              | MLS establishment, outbound errors or delayed/invalid controls; wrapper return is not delivery proof. |
| `not-ready`, `epoch-1`                                           | Native group establishment after the epoch reset.                                                     |
| `not-ready`, `invalid-welcome` or `invalid-commit`               | MLS recovery and response disposition.                                                                |
| `not-ready`, `decrypt-failures`, both replies `skipped-resuming` | The locally reproduced resume/recovery gate defect is directly relevant.                              |
| Any reset with a reply `send-threw`                              | The outbound-send failure path, with its existing error handling.                                     |
| Missing episode metadata                                         | Instrumentation/source coverage remains unknown; do not choose a cause.                               |

Multiple resets overwrite earlier evidence. A later episode may hide a previous skipped reply; that is an explicit limit of avoiding a history. If this prevents distinguishing incidents, revisit the diagnostic scope with evidence rather than adding a ring buffer now.

These fields do not establish encrypted input, packet validity, server control arrival, or DAVE causation. A footer remains a candidate. Do not drop all unready inputs, force native decrypt while unready, or reinitialize on every Opus error: legitimate plaintext/silence and remaining epoch state can be lost.

## Change surface and validation

Implementation reaches `patches/@discordjs+voice+0.19.2.patch` (CJS, ESM and both declarations), `src/utils/opusDiagnosticDecoder.ts`, and the existing receive-diagnostic/resume tests. `src/audio.ts` already uses the formatter and should need no additional call site. No dependency bump, build configuration, product UI, processing notice, or public analytics change.

Begin implementation in an isolated checkout from current `origin/master`, including the already shipped per-input diagnostic. The older diagnostic branch is not a suitable release base.

Required tests establish:

1. Each classified trigger creates one episode; ignored epochs and guard-suppressed recovery preserve the previous one. Recovery retains invalidation and key-package dispositions in the same episode. Direct unclassified reinit records `unknown`.
2. SelectingProtocol/Ready record normal sends, Resuming records skipped sends, rejected/closed states record other skips, and thrown sends preserve the original exception. Initial creation attributes events to the actual emitter.
3. A real native recovery during Resuming records `decrypt-failures` and both skipped dispositions; after Resumed the same pending native state/evidence survives. Existing native activation and valid plaintext controls still work.
4. Queued decoder failure retains the earlier reason, age and dispositions after later episode mutation/replacement. Missing metadata formats as `UNKNOWN`; no-attempt age is `none`; no forbidden content enters the episode or added warning fields.
5. CJS and ESM produce equivalent snapshots and warning fields. Existing decrypt/passthrough/drop, resume and decoder tests pass unchanged in behavior, with updated snapshot expectations.

Run focused audio tests, backend build/type checks, changed-file lint/format, then the repository's required CI and PR feedback/readiness checks before calling an implementation merge-ready. Keep any public PR prose free of private operational evidence.

## Release and observation

An implementation and release are separate from this design. After a release is authorized and independently verified, establish its exact running-image boundary before interpreting the new fields. Extend the bounded read-only monitor's whitelist with only these four fields; preserve all existing restrictions, especially `opusPacketBytes=UNKNOWN` and internal-only ID correlation.

For a new incident, deduplicate warning pairs, report the immutable failing-input episode values, and match actual processing outcomes where accessible. Earlier warnings remain legacy evidence. No incident with no observed meetings is no exposure; clean meetings without the relevant recovery path do not exercise that path.

The current monitor's October 12 final readout/pause remains in force. Shipping this extension does not silently extend monitoring; any further schedule is a separate user decision. Retain the original distinction between startup/service health and actual meeting/recovery exposure.

## Approval and implementation boundary

The user approved proceeding with this four-field, latest-episode diagnostic on October 12. The main tradeoff is limited ordering evidence in exchange for a bounded snapshot and no extra log stream. The builder may choose the smallest internal plumbing that satisfies episode ownership and ordering; broader diagnostics and a behavior-changing recovery fix remain outside this design.
