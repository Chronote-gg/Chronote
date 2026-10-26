# Recover a consumed Sandbox deployment in preparing

This operator action adopts one existing registered candidate after a failed historical carryforward. It does not replay carryforward or register a replacement. The original logical deployment, operation UUID, archive and pending lost-owner incident stay intact. A separate linked recovery receipt records the actual new executor and one fresh coordinator epoch and lease.

Use this only under an approved recovery plan and an exclusive operator window. That window is operational exclusion, not an IAM fence against every credential holder. Production and historical incident settlement are excluded.

## Required source and provider evidence

Before execution, complete focused regressions, native transaction tests, independent review, exact-head CI and hosted-feedback checks. Merge readiness remains subject to the repository's separate observation window.

Read and bind the actual preparing Control, immutable carryforward archive, original pending source-loss receipt and existing source. Require an expired original coordinator lease, a terminal failed original workflow at the archived tooling source, one serving generation/member, source-only acknowledged routing, an empty spare pool, fresh source-owned readiness and native protection. Refuse an acknowledged candidate or definition, pending tasks, ambiguous registrations, changed history, routing markers or a competing writer.

Completely enumerate active family registrations. Require exactly one with the original operation's candidate ID, exact pinned ARN, original execution principal and registration time inside that original execution. Compare the untouched registration input against the original prepared definition. Verify the prepared object's original raw hash first. Only ordering of environment entries with unique names may differ. Reject duplicate names or any other changed field, entry shape, value or array order. Do not reconstruct the observed registration with a helper that overwrites its image, candidate ID or timeout.

## Private recovery proof

Preserve the original `SANDBOX_CARRYFORWARD_MANIFEST` and its checksum. Its initial-consumption expiry is historical evidence, not a new authority grant. Do not replace or refresh that original packet. The new proof supplies the recovery source and a fresh bounded execution expiry:

```json
{
  "version": 1,
  "kind": "sandbox_preparing_recovery",
  "operationId": "<original consumed UUID>",
  "sourceCommit": "<exact reviewed recovery source>",
  "originalManifestSha256": "<original canonical checksum>",
  "controlSha256": "<current exact controlAuthority checksum>",
  "archiveSha256": "<original complete archive checksum>",
  "recoverySha256": "<complete pending source-loss receipt checksum>",
  "logicalRunToken": "<original carryforward execution token>",
  "definitionArn": "<unique existing registration>",
  "definitionSha256": "<raw untouched taskDefinitionInput checksum>",
  "approveBefore": 0
}
```

The placeholders and zero expiry are deliberately non-executable. Use exported pure helpers and a read-only actual-principal metadata adapter to compute the final private proof and binding. Never spoof STS, OIDC or a workflow session to run the executable wrapper on a host.

Create a separate temporary environment secret, `SANDBOX_PREPARING_RECOVERY_PROOF`, only after proving it absent. Retain its ownership metadata and encrypted transport receipt. Never overwrite a foreign secret or the original frozen manifest. Preserve the cloud/environment protection settings.

## Inspect, execute once, then reconcile

1. Dispatch `sandbox-identity.yml` at the exact reviewed source with `continuation_action=inspect-preparing`, the original `carryforward_manifest_sha256` and new `preparing_recovery_proof_sha256`. The inspection must be read-only. Match its binding checksum to the independent current host inspection.
2. Refresh the actual source, authority, registration, writer inventory and private-proof lifetime. Dispatch one `recover-preparing` with those same proof checksums and `continuation_binding_sha256`. Require attempt 1 and the existing Sandbox environment, OIDC identity and concurrency gates. Record dispatch intent before the API call; reconcile an unknown dispatch instead of repeating it.
3. The claim atomically checks Control, archive, original pending receipt and source admission proof; appends deterministic `CARRYFORWARD#<UUID>` / `PREPARING_RECOVERY`; increments epoch/lease and acknowledges the pinned existing definition. Logical lineage and generation/membership remain unchanged. A lost claim response is accepted only by exact receipt and Control readback, without another write.
4. Require the source to publish its own readiness for the new epoch. The normal guarded handoff must keep the adopted ARN pinned, forbid registration, retain current protection and live writer checks, and genuinely retire the outgoing source. Unknown acknowledgment or any later refusal preserves the consumed receipt and uncertainty. Never reset the UUID or redispatch recovery.
5. Verify actual serving definition/image/settings, generation, healthy readiness, protection and acknowledged routing, outgoing retirement with all seven zero work counts and native convergence, and unchanged original archive/incident/lost runtime. Remove only operation-owned temporary transport after reconciliation. Keep private proof, archive and receipts.

Only verified runtime activation permits the dependent billing cases. Provider, hosted persistence, signed-in UI and wall-clock expiry evidence remain separate. This action grants no introductory-history exception, tax-registration authority or recording-content access.

During warming, source or candidate ALB health may lag application readiness. A bounded health wait is allowed only before promotion, while the exact recorded phase is warming, the source route is acknowledged and no candidate promotion marker exists. Both targets must pass the normal health checks before promotion. Any other refusal or uncertain listener acknowledgment stops the operation.
