# DAVE inclusion gate result

## Outcome

The DAVE gate is unmet. The installed native parser accepts frames that the approved guard must reject. Keep the process-exit changes and exclude Task 4's DAVE behavior from this PR, as required by the [approved design](2026-10-14-voice-process-exit-design.md#gate-for-including-dave-in-this-pr).

The blocking differences are supplemental data occupying the entire frame and unencrypted ranges extending into supplemental data. Both were measured in isolated native Linux subprocesses. The approved structural bounds remain unchanged. No further decision is needed to follow the approved fallback.

Authenticated two-member proof was **unperformed**. No external Add signer, activation test suite, application classifier or pending-input guard was built. This result does not establish a production root cause.

## Method and evidence limits

Each case created a fresh native session, applied the repository's existing public external-sender and Add-proposal fixture, and processed its own real commit. This established a remote-member decryptor. The runner required native readiness, a remote decryption-stat record and disabled passthrough with zero transition expiry before evaluating the frame.

The pinned [native decryptor](https://github.com/Snazzah/davey/blob/a1e2e741bea06bc3b7167a5c3792844b8975993c/davey/src/cryptor/decryptor.rs) separates parser rejection from cryptographic failure. The runner matched its known outcomes internally:

- `UnencryptedWhenPassthroughDisabled` means the parser rejected the frame.
- `NoValidCryptorFound` means parsing succeeded and cryptographic processing failed.
- Missing decryptors, unexpected errors, successful decryption or abnormal subprocess exits would invalidate this diagnostic.

For every accepted frame, the decryption-attempt counter increased. Rejected frames left that counter unchanged. Success and passthrough counters stayed unchanged throughout. Native error messages were never printed because they contain frame sizes.

The positive native control encoded generated non-silent PCM using `@discordjs/opus`, decoded that Opus successfully, and encrypted it with the local session. Testing that frame against the fixture member's decryptor established parser acceptance only. It did not prove remote authentication. The remaining frames were synthetic structural inputs held in memory, with no stored media or live traffic.

Each case ran in a separate Node subprocess with a timeout. The container had no network, a read-only root filesystem and a read-only runner mount. Child output was captured and reduced to case labels and booleans. Both executions completed normally for every case, with empty native stderr.

## Measured comparisons

`Approved accepts` records the required structural decision, not the output of a newly implemented classifier. `Native accepts` records the parser oracle, not authenticated decryption.

| Case                                         | Approved accepts | Native accepts | Agreement |
| -------------------------------------------- | ---------------- | -------------- | --------- |
| Native encrypted control                     | true             | true           | true      |
| Valid synthetic structure                    | true             | true           | true      |
| Missing marker                               | false            | false          | true      |
| Supplemental size exceeds frame              | false            | false          | true      |
| Supplemental size equals frame               | false            | true           | false     |
| Range enters supplemental data               | false            | true           | false     |
| Range exceeds entire frame                   | false            | false          | true      |
| Incomplete range pair                        | false            | false          | true      |
| Truncated nonce                              | false            | false          | true      |
| Nonce exceeds unsigned 32-bit range          | false            | true           | false     |
| Nonce encoding exceeds unsigned 64-bit width | false            | true           | false     |
| Duplicate empty ranges                       | false            | true           | false     |

All cases reported setup, recognized outcome, counter agreement and normal termination as true. Authentication was false in every case. The final scalars were `evidenceComplete=true`, `parserAgreement=false`, `authenticatedTwoMemberProofPerformed=false` and `daveGateMet=false`. Exit code zero means the diagnostic completed, not that the DAVE gate passed.

The [whitepaper frame check](https://daveprotocol.com/#protocol-frame-check) requires supplemental data smaller than the entire frame, distinct non-overlapping ranges, and range bounds within the interleaved media. The pinned [frame parser](https://github.com/Snazzah/davey/blob/a1e2e741bea06bc3b7167a5c3792844b8975993c/davey/src/cryptor/frame_processors.rs) instead permits equality and validates ranges against the entire frame. Its nonce reader also lacks an explicit encoding-width bound before the parser casts the result to `u32`. The measurements confirm disagreement; they do not justify weakening the approved rules.

## Work deliberately left unperformed

The early-failure policy stopped work before a dynamic signer or two matching live members were created. Valid welcome joining, authenticated media roundtrips, reset roundtrips, delayed activation, both returning reply wrappers, CJS/ESM application activation and the same-stream decoder guard remain unverified. The combined Task 3 activation test command was not run because its new activation suite was not created. Existing reset/resume diagnostics cannot substitute for those missing proofs.

No production code, dependency, native API, MLS negotiation, retry timing or capture behavior changed in this task. The untracked diagnostic runner is excluded from the final build's tracked-files archive. No generator or diagnostic runner was added to the production image.

## Evidence appendix

- Evaluation date: 2026-10-14.
- Task baseline: `2f60091ee7af20caee2d1824ae52977325b31407`.
- Runtime measured: Node `v24.15.0`, Linux, Davey `0.1.12`, native `@discordjs/opus` loaded and exercised.
- Native source reference: Davey `a1e2e741bea06bc3b7167a5c3792844b8975993c`. This is a source reference for the installed package, not a claim that the package was rebuilt from source in this task.
- OpenMLS version in the feasibility source pin: `0.8.1`. No Rust build was needed for this evaluation.
- Local image: `chronote-voice-process-exit-base`, `sha256:87d37996d268a8005fae7bd346db74b64b677b5ebe400e2cf2c194968f634e7b`.
- Public fixture: `test/audio/fixtures/davePublicControls.cjs`, derived from the upstream MIT-licensed Davey session test. Its SHA-256 matched the image copy: `724807f62cb75fa05d9bf5fea79e1c84d48285686f5fa46c60942565ec77f9bb`.
- Local diagnostic runner SHA-256: `c6c7e6e6bcac57731f9b1b4586d555339551ab3514f07867f3330335968b78f3`. The internal Task 3 report records its retained path and executable command. The temporary runner is not part of the shipped repository.
