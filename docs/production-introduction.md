# First production introduction

The first production introduction uses the **cold cutover** below ([decision](adr-20261028-production-cold-cutover.md)). The staged fence-and-drain protocol described after it remains in source but is blocked at `Post-bind human authority unavailable; preserve state` and is not the selected path. The selected A interruption and test-before-reopen contract is documented separately in [Production interruption contract](production-interruption-contract.md). Their manifests, receipts and execution authority are not interchangeable.

Use [recording handoff and recovery](deployment-handoff.md) for ordinary compatible deployments after the cutover. Use [Sandbox bootstrap tooling](sandbox-bootstrap.md) only for its literal Sandbox scope.

## Cold cutover

Production completed this cold cutover on 2026-10-29: legacy revision 239 moved to `master` on revision 240, with no in-flight work before or after the stop. The procedure is now historical for production; later releases use the ordinary deploy.

`Production Cold Cutover` (`.github/workflows/production-cutover.yml`) runs on `master`, attempt 1, in the `production` environment and the `chronote-deploy-production` concurrency group, so it never overlaps an ordinary deploy. Inputs:

- `mode`: `inspect` (default, read-only session) or `cutover`.
- `operation_id`: a fresh UUID for `cutover`. Reuse it only to resume an interrupted cutover.
- `environment`: `production`, or `sandbox` for a rehearsal.

`inspect` reports service counts, in-flight work, Control rows, listener form and spare-group targets, plus `readyForCutover`. Run it to pick a quiet window.

`cutover` does this, in order:

1. Builds and pushes the image of the run commit. The script then verifies in code that BASIC natively approved this exact run (`verifyRunApproval`) and that the AWS session is the exact deploy role session.
2. Refuses unless the Control table is empty, the listener is in the legacy single-forward or weighted 100/0 form, the spare group is empty and the legacy service is steady at one task.
3. Registers the candidate from the latest family revision with the run image, `DEPLOYMENT_CANDIDATE_ID` set to the operation id, `stopTimeout` 120, `node dist/index.js`, and the four `STRIPE_*` flags `false` (an enabled flag refuses).
4. **Pre-stop check.** The run defers (exits cleanly with a warning, leaving only the candidate definition) when any of these is in flight. A scan failure refuses, and an unknown status always counts as in flight.
   - An `ActiveMeeting` lease, unless it is both past `leaseExpiresAt` and `complete` or `cancelled` (rows awaiting TTL deletion).
   - A `MeetingControlCommand` that is not `completed` or `failed`, unless nobody ever claimed it and it is past its queue `expiresAt`. A claim can be renewed past that expiry.
   - A personal upload job that is not `complete` or `failed`, except a `pending_upload` intent past its `expiresAt`. Legacy finalization copies the upload-URL expiry onto queued jobs, so expiry is ignored for `queued` and `processing`.
   - A `pending_upload` desktop parent has no `expiresAt`. It is settled only when neither it nor any of its segments has been updated for seven days, which covers paused drafts waiting on a client. A live recording updates its segments every minute or so, and a row without a parsable timestamp counts as recent.
   - A recording segment that is not `processed` or `failed` and belongs to an in-flight job.
5. Switches the listener to the weighted 100/0 form if needed. With an empty spare group this is traffic neutral, so it runs before the point of no return.
6. Sets desired count 0 and waits up to 15 minutes for the legacy task and both groups' targets to clear.
7. **Post-stop recheck** of the same rules.
8. Initializes Control, launches the candidate, waits up to 15 minutes for readiness and promotes it, then confirms it is serving. No `ENV/INTRODUCTION` hold is written, so the ordinary deploy guard allows the next deploy.
9. **Run the ordinary deploy of master (`Meeting Notes Bot Deploy`) immediately.** Promotion writes no deployment record, so if ECS replaces the serving task before an ordinary deploy, the replacement stays a candidate and the next coordinator run fails. The cutover is complete only when that ordinary deploy has gone green after `candidate_promoted`. The workflow summary repeats this.

Phase lines in the log (`pre_stop_check`, `routing_weighted`, `stop_submitted`, `legacy_stopped`, `post_stop_recheck`, `control_initialized`, `candidate_launched`, `candidate_promoted`) show how far a run got.

### The stop window and limits

The legacy task keeps its Discord gateway until it stops, so a meeting can start after the pre-stop check. The window is the ALB deregistration delay plus the task stop timeout, not seconds. The legacy revision (`593a6d6`) runs with ECS's default 30 second stopTimeout, so a meeting that starts during the drain gets about 30 seconds after SIGTERM before SIGKILL. A separate Terraform change lowers the API target groups' deregistration delay to shrink the window.

A lease left behind after the stop exits 2 with `Work appeared during the stop window`, after service is restored with the candidate. A meeting that starts and ends cleanly inside the window leaves no lease and is not detected. If the service was already at zero when the run began (an interrupted earlier run), there is no pre-stop baseline: the run exits 2 with `No pre-stop baseline` so an operator reviews recent meetings. The recheck outcome is stored on the operation's `BOOTSTRAP#` receipt when Control is initialized, so a resumed run reports it again. A receipt without a stored outcome is also reported for review.

### Failure and resume

Never relaunch legacy, delete rows, force-expire leases or clear receipts. After a refusal, run `inspect`. A run that stopped before Control initialization can be redispatched with the same operation id from the same commit, or with a new id. Once Control exists, resume only with the same operation id. When the receipt is `initialized` or `launched` and Control is still owned by the operation at generation 0 with no members, the resume renews the bootstrap coordinator lease with one conditional update before continuing. A submitted but unacknowledged launch is never replayed.

### Prerequisites

- The production deploy role (`PRODUCTION_BACKEND_DEPLOY_ROLE_ARN`) with the routing policy attached, from Terraform.
- Production environment variables `DEPLOYMENT_LISTENER_ARN`, `DEPLOYMENT_TARGET_GROUP_A` and `DEPLOYMENT_TARGET_GROUP_B`. Ordinary deploys need them too.
- Environment protection that `verifyRunApproval` accepts: BASIC as the single required reviewer, no admin bypass, `master` as the only deployment branch and no custom protection rules.
- A Sandbox rehearsal needs Sandbox back in a pre-cutover state (empty Control table, legacy or weighted listener, one steady task), which is a separate approved reset.

## Staged fence-and-drain protocol (blocked)

This procedure covers the one-time transition from the legacy production runtime to the protected handoff protocol. BASIC approved preparation and a brief maintenance window after existing work finishes. Production execution still needs its own exact packet and approvals. Recordings must finish, valid uploads must survive, and unfinished work must remain recoverable.

**Execution is BLOCKED as of October 22, 2026.** The source-staged workflow binds a proposal and validates its private authorization envelope, then refuses at `Post-bind human authority unavailable; preserve state`. Both introduction jobs use read-only AWS sessions. The introduction CLI also refuses consequential phases without a trusted collector. Adding the collector alone must not enable execution.

A Sandbox manifest, `testOnly` receipt or standing Sandbox deployment approval cannot authorize this procedure.

## What users may experience

Preparation leaves the running application in place. During approved maintenance, the temporary role policy denies new meeting acquisition and new personal-upload processing claims. Existing owners must finish their recordings, processing, delivery and voice operations. Upload intake, valid upload URLs and finalization must remain usable where the proved legacy request contract permits them. This is a narrow admission fence, not a blanket write deny or a friendly maintenance-page guarantee.

After all active work settles and retained work is proved compatible, shutdown creates a period without a serving API or bot. Portal requests, OAuth callbacks, desktop and MCP requests, and incoming webhooks may fail. A cached static frontend may still load without a working API. No fixed downtime duration or provider retry/delivery guarantee has been accepted. Local signed-webhook tests do not establish hosted recovery or permit replaying real events.

The compatible candidate must prove readiness, protection, ownership and acknowledged routing before admission reopens. Ordinary deployments thereafter keep the old application serving while a candidate warms.

## Activation prerequisites

Keep these decisions separate from source approval:

- Approve any isolated rehearsal resources and IAM before provider rehearsal.
- Resolve Terraform confidentiality before any fresh production plan or apply. [Private Terraform delivery](terraform-private-delivery.md) is implemented in source and requires private storage for saved plans and detailed output, with exact producer source, artifact bytes, checksum and human apply approval. No archive destination, region, encryption, retention, IAM, bootstrap method or live configuration has been selected or approved. Native acceptance remains pending.
- Review the fresh production plan, saved apply artifact and exact actual-task probe scope. Source policy attachment does not prove live permissions or task-principal behavior. See [production backend deployment identity](../_infra/README.md#production-backend-deployment-identity).
- Implement and independently review a real human gate after proposal binding, approved durable private delivery, and the authenticated collector/store. Accept the exact job topology through a separately authorized harmless gate check. No environment name, hash comment, Boolean approval or alternate credential bridge substitutes for this.
- Approve the exact final maintenance packet and each phase's current-run authority. The packet must include the compatible backend and matching static frontend fallback, retained-work evidence, expiry/deadlines and recovery limits.

The October 22 environment metadata refresh found no protection rules or deployment branch policy, with administrator bypass enabled. Those settings do not supply the required approval. Refresh them before activation; the staged refusal remains required until reviewed wiring and acceptance replace it.

## Operator decision

### Can this introduction advance safely?

```mermaid
flowchart TD
  A[Prepare private packet] --> B{Dependencies and packet approved?}
  B -->|No| C[Stay blocked, preserve service]
  B -->|Yes| D[Approved fence and drain]
  D --> E{Ready before stop intent?}
  E -->|No, exact state known| F[Approved pre-stop abort]
  E -->|Yes| G[Submit stop once and activate]
  D -->|Any unknown acknowledgment| H[Preserve fence and reconcile]
  G -->|Any unknown acknowledgment| H
  G -->|All proofs acknowledged| I[Remove fence and prove restoration]
  I -->|Complete receipt and released ownership| J[Complete, normal handoff]
  I -->|Any unknown acknowledgment| H
```

This diagram describes the accepted engine contract after its activation prerequisites are met. It is not an executable cutover recipe. The current workflow cannot perform the mutating branches.

## Prepare without entering maintenance

1. Bind the reviewed source commit to the image digest and task definition. Bind the legacy task/source, existing service and roles, table routes, listener/groups, original policies/controllers, known writers, collector command and evidence store. Independently bind the fallback source, digest and definition. Candidate and fallback must both differ from legacy; an explicitly bound fallback may equal the candidate.
2. Check current and cached frontend requests against the candidate. Preserve a matching static fallback and compatible backend or a separately reviewed repair-forward decision. Backend rollback does not restore static files. Exact artifact identities and hosted compatibility are still UNKNOWN.
3. Collect read-only discovery under the exact account, role and session. Identify every producer and external writer. Include standalone recovery publication apply and reconciliation tools, which write private objects or external messages outside ECS runtime counters and the eight-table inventory. Their reconciliation mode is not a read-only collector.
4. Assemble the immutable private manifest and retain complete original captures before publishing compact references. Capture readback must match the original bytes, SHA-256 and length in the approved store. Hashes alone do not make the body available to a reviewer or prove approval.
5. Review one phase against the current durable receipt predecessor. The staged workflow accepts `phase`, `operation_id` and `manifest_sha256`, defaults to `inspect`, and permits only `master` attempt 1. It shares `chronote-deploy-production` concurrency with ordinary deployment and does not cancel a running deployment. These are source contracts, not evidence of a dispatched or approved run.

Binding freezes the proposal hash. The dependent job checks private body hash = expected delivery hash = bind output, along with exact source, operation, run, session, expiry and predecessor. The proposal currently exists only in private runner files; approved durable delivery to the reviewer remains missing. There are no cutover command examples while those dependencies are absent.

## Approved maintenance and preservation

The following sequence is implemented in the engine and requires the prerequisites above before operational use.

1. `fence` requires absent initial Control, the unchanged original service and the bound candidate definition. It installs only the operation-owned policy on the bound app role and requires fresh actual-principal denial evidence. Independent unrelated permissions stay bound to their original hash.
2. `drain` keeps the legacy runtime running. Two complete, explicitly paginated projected inventories must agree after authenticated policy, task, owner, controller, writer, effect and compatibility observations. The eight slots are leases, history, controls, uploads, segments, billing, webhooks and payments. This is not an atomic AWS snapshot or proof against arbitrary manual writers.
3. Active or uncertain work blocks shutdown. Retain terminal records and receipts. Pending or queued uploads and their segments may carry forward only with exact row-bound source input, token, schema, ownership and claim-protocol compatibility evidence that remains valid. Expired leases, terminal labels and message IDs alone do not prove settlement. Preserve all [seven producer classes and voice guards](deployment-handoff.md#ownership-preservation-and-delivery).
4. `activate` rechecks the drain, journals shutdown intent, then submits one desired-count-zero update. Only exact stopped legacy identity, no replacement, settled native inventory, unchanged bindings and still-valid original actual-principal proof allow routing and Control initialization. Do not attempt to probe a stopped task or extend the old proof's lifetime.
5. Launch only the bound compatible definition. The target uses rolling deployment, min100/max200, DEFERRED/100 early success, circuit breaker enabled and automatic rollback disabled. Fresh candidate readiness, native protection, ownership and exact acknowledged routing precede conditional promotion. The operation-owned deny stays in place until `complete`.

Keep `STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED`, `STRIPE_RENEWAL_GRACE_ENABLED`, `STRIPE_INTRO_OFFER_LEDGER_ENABLED` and `STRIPE_RENEWAL_REACTIVATION_ENABLED` disabled in the production candidate. This procedure activates no offer/history behavior and grants no authority over reserved financial fixtures.

## Abort, uncertainty and failed startup

A pre-stop `abort` is allowed only at acknowledged fence or drained stages, before shutdown submission. It requires the exact original service, fresh owned-policy evidence, removal of only this operation's policy, and subsequent permission-restoration proof. It does not delete work or erase receipts. A submitted but unacknowledged write cannot take this shortcut.

Any unknown provider-write acknowledgment stops advancement. Keep the fence and immutable submitted intent, then reconcile through read-only evidence collection. A later GET showing the desired value cannot prove the original request settled. Do not replay shutdown, listener, initialization, launch or policy removal, clear the stage, force expiry, delete leases, unprotect tasks or relaunch legacy code. Unknown private capture-write acknowledgment also stops; it does not permit automatic resume.

After shutdown, preserve the fence on failure. Only a separately approved same-operation, same-manifest recovery envelope with exact failure capture and predecessor may select the prebound compatible fallback. The engine requires a sole native PRIMARY FAILED deployment, rollback disabled, no other active deployment, settled tasks, no active owner and generation zero with no serving members. A live or protected candidate requires a separate recovery decision. The one bound fallback launch may use the same candidate definition with a native new-deployment trigger. It is not a general retry policy.

Recovery proposals currently contain `recovery: null`. Reviewed private failure-evidence delivery is missing, so the workflow cannot authorize that fallback. Even after wiring, `reconcile` reports unresolved state without provider mutation, stage clearing or replay. An expired authority refuses further execution and leaves the deny in place. A later run cannot silently renew the original proof or reopen admission.

## Complete and resume normal handoff

`complete` starts only after acknowledged promotion. It proves an idle, protected serving candidate before removing the exact owned fence, then proves restored permissions and current serving ownership. Shared-role restoration also requires complete task inventory and the bound controller/writer evidence that excludes legacy resurrection. Once the fence is removed, legitimate newly admitted work may remain active; completion must preserve it. The exact generation/member transaction releases the introduction coordinator and records completion.

Keep runtime, routing, restoration, retained-record and frontend/backend evidence together before calling the introduction complete. No automatic legacy resurrection is available. Later compatible deployments return to the ordinary coordinator's prepare, promote, runtime-owned retire and reconciliation contract. Source merge, infrastructure apply, an image tag or a successful API response alone does not establish this outcome.

## Evidence and private handoff

The exact private execution packet is not yet available. Its link belongs in the private operations handoff together with exact manifests, hashes, bindings, original captures/page chains, provider receipts, approvals, artifact fallbacks and financial limits. Do not publish packet bodies, resource or customer identities, raw histories or secret values in this repository, workflow logs or public artifacts. Private delivery options remain proposals.

| Evidence class     | Status at October 22, 2026                                                                                                                      | What remains                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Source             | Introduction engine and staged workflow accepted in task review                                                                                 | Final whole-branch validation/review and activation wiring                                                                           |
| Local              | Strict binding/refusal, local Dynamo lifecycle/carryforward, cached-client contracts and signed synthetic-webhook checks passed in scoped tasks | Synthetic ports do not prove provider behavior or hosted publication failure                                                         |
| CI                 | UNKNOWN for the final combined branch head                                                                                                      | Published exact-head checks and post-30-minute feedback audit                                                                        |
| Sandbox            | UNKNOWN for this production-introduction procedure                                                                                              | Separately approved rehearsal and acceptance; Sandbox bootstrap retains its own rules                                                |
| Production runtime | UNKNOWN                                                                                                                                         | Actual task-principal denial/restoration, complete collector/store evidence, live identity/readiness/voice/routing and retained work |
| Financial/provider | UNKNOWN                                                                                                                                         | Authorized provider acceptance and preserved-fixture evidence; no replay implied                                                     |

Historical H7/R6 observations in the [handoff guide](deployment-handoff.md#evidence-and-remaining-acceptance) are separate evidence. They do not establish this procedure's current acceptance.

## References

- [Cold cutover decision](adr-20261028-production-cold-cutover.md)
- [Staged introduction decision](adr-20261020-production-legacy-introduction.md)
- [Production role and permission limits](../_infra/README.md#production-backend-deployment-identity)
- [Ordinary handoff and recording recovery](deployment-handoff.md)
- [Separate Sandbox bootstrap](sandbox-bootstrap.md)
- Source contracts: `scripts/deployment/staged-production-manifest.cjs`, `production-evidence.cjs`, `staged-introduce-production.cjs` and `production-workflow.cjs`.
- Local lifecycle coverage: `test/deployment/productionIntroduction.integration.test.ts` and `productionCarryforward.integration.test.ts`.
