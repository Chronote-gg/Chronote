# Meeting lifecycle and deployment simplification

Status: Draft for owner review
Date: 2026-11-11
Tracks: #609 (meeting starts available throughout deployments), #119 (multi-instance), #490, #541, #564, #493, #64
Supersedes: `2026-10-12-deployment-drain-and-interruption-design.md`, `adr-20261020-production-legacy-introduction.md`, `adr-20261025-production-interruption-contract.md`, `adr-20261028-production-cold-cutover.md`, and open PRs #596 and #597

## Intent

Chronote should be a small bot that records a meeting, finishes it, and lets the next one start. Deploying it should be an ordinary ECS update that takes minutes and needs nobody to intervene.

Today one imperfect meeting can block its server, hold a worker open, and refuse every deployment, including the deployment that carries the fix. This design removes the mechanisms that make that possible instead of adding expiries to each of them.

## Why the current system gets stuck

Three properties compound.

1. Ambiguous outcomes become durable states with no expiry and no automatic resolution: a per-server voice record left `joining` or `uncertain`, an in-memory work counter that is never settled, a `needs_reconciliation` recovery disposition, a blocked local cleanup, a finalization that keeps renewing its lease, and a deployment control record left mid-phase.
2. Those per-meeting states feed worker-wide and deployment-wide gates. A deployment requires zero work counters and a valid cleanup receipt for every local directory on the serving task.
3. The gates guard the only repair path. Replacing the task is what clears in-memory counters and local disk, and a deployment is what ships a fix.

The warm handoff the machinery was built for does not happen in production. The service runs one task. The old runtime renewed a ten-minute protection every minute; when ECS refused those renewals, which it did during deployments once a second task was running, the old runtime closed admission about eight minutes after its last successful renewal, and ECS could stop it about two minutes later. It did not exit by itself. The exact rule ECS applies is not documented. In practice a deployment is "wait until idle, then swap", carried by a coordinator, a runtime protocol and a recovery framework.

Measured effect: production deployments went from reliably succeeding to mostly failing or being cancelled once the coordinator was introduced. Of the last 60 merged pull requests, 29 repair the machinery itself.

## Goals

- A captured meeting always reaches a terminal state on its own: notes delivered, or a visible failure with the saved audio kept.
- A server can start a new meeting as soon as its previous capture has ended, whatever happened to that capture.
- One server's failure never affects another server, the worker, or a deployment.
- Meeting starts stay available at every moment of a normal deployment (#609).
- A deployment needs no manual step. The only thing it ever waits for is a previous deployment's worker finishing a live recording, and that wait is bounded and can be skipped.
- Nothing in the design assumes exactly one worker (#119).
- Every wait has a deadline. Every failure that needs a human raises an alarm that emails the owner.
- Substantially less code and fewer tests than today.

## Non-goals

- Continuing a live recording on another worker after its worker dies. The meeting ends where the worker died.
- Running more than one worker in steady state, autoscaling, or load-aware placement. This pass makes them possible and lists what remains.
- Splitting the bot and the API into separate services.
- Changing transcription, notes, prompts, billing rules or the portal.
- Reworking the checkpoint publisher's behaviour under memory pressure (#500, #566).
- Removing the now-unused infrastructure (spare target group, weighted listener, coordinator IAM, the voice alarms). That is a later cleanup.
- Returning to the old protocol after cutover. Problems are fixed forward.

## Anti-goals

These would make the work a failure even if it functions.

- Any new durable state that only a human or a one-off tool can clear.
- Any deployment step that can be refused by a meeting, a counter, a lease or a local file.
- A second implementation of notes generation or delivery.
- A new recovery or reconciliation framework, or a new operator tool per incident.
- A check that proves bookkeeping instead of an outcome a customer can see.

## Rules the design follows

1. S3 is the truth for audio. A piece is safe when its upload succeeded.
2. The MeetingHistory row is the truth for the meeting. Its terminal status is written before anything is posted.
3. The per-server lease is the only lock on recording, and it covers capture only. Everything that changes the bot's presence in a server (voice, nickname) happens while the lease is held.
4. A worker that no longer holds a lease does nothing visible in that server.
5. Local disk is a cache. No decision depends on it.
6. A worker's death is a normal event. Shutdown is a tidy version of the same path.
7. Each step is idempotent and skips itself when its durable output exists.
8. Every wait has a deadline, including each DynamoDB request (3 seconds to connect, 10 seconds to answer, from `LIFECYCLE`).

## Design

Every duration below is a named constant in `LIFECYCLE` (`src/services/lifecycleTiming.ts`) or in `scripts/deployment/deploy.cjs`.

### Workers and who takes new meetings

Every worker is the same program. On start it writes one registry item and refreshes it with its heartbeat every 10 seconds:

- `instanceId`, `release`, `ready`, `heartbeatAt`, `captures`, `finishing`, `protectedUntil`, `taskArn`.
- `instanceId` is random per process. On ECS it never comes from the environment, so a value set in the task definition cannot give two tasks the same id; outside ECS `BOT_INSTANCE_ID` may fix it.
- `release` is the ECS task definition revision, read from the task metadata endpoint. Outside ECS it comes from `WORKER_RELEASE` and defaults to 0.
- `ready` is true while the Discord client is connected, the web server is listening and the worker has read the registry at least once. It is live, not latched: a worker that loses its gateway connection stops being eligible until it reconnects. Shutdown writes `ready: false` first.

The registry lives in the existing deployment control table under its own partition key (`WORKERS`). That table also holds product items (auto-record suppression, paused desktop drafts, publication items), which are untouched.

A worker is **eligible** when it is ready, not shutting down, and no other worker with a heartbeat in the last 30 seconds is ready on a higher release. Workers on the same release are all eligible. Each worker re-reads the registry on its heartbeat and keeps the answer in memory, so eligibility costs no request at decision time. If a registry read fails the worker keeps its last view, because the lease, not the registry, is what prevents two captures. An eligible worker logs a fixed line at most once a minute, which the "no worker eligible" alarm watches.

Only eligible workers start meetings, answer general commands, and run shared background jobs. A worker that is not eligible is draining: it keeps the meetings it is recording and nothing else.

`/health` returns 200 once the worker's first `ready: true` registry write has succeeded, and stays 200 afterwards, so a later Discord outage does not make ECS replace the task. Before that it fails, so the load balancer sends no traffic to a booting task and ECS does not stop the old task early. Both places that answer `/health` (the boot-time health server and the web server) read the same latch, and other routes keep answering 503 during boot. The service's health check grace period is five minutes, set both in Terraform and by the deployment script on every rollout.

Consequences:

- During a deployment the old worker stays eligible until the new one is actually ready, so there is no moment when nobody accepts a start.
- If the new worker never becomes ready, ECS never stops the old one.
- For up to one heartbeat two workers may both be eligible. The lease decides.

This replaces serving generations, promotion, roles, retirement acknowledgments, work counters and the artifact handshake.

### Starting a meeting

A start writes, in one transaction, the per-server lease conditioned on "absent or expired", the initial MeetingHistory row, and the existing auto-record suppression check. A transaction cancelled by a concurrent start is retried under the same token after a short pause, up to three attempts, and a start whose outcome is still unknown is classified by reading the lease. The loser of a race backs off before touching voice.

The row is written with `lifecycleVersion: 2`, which marks it as belonging to this design, and with `executionVersion: 1`, which the checkpoint layout uses and nothing changes afterwards. The id of the "recording started" message is saved to the row as soon as it is posted, so that whichever worker finishes the meeting can replace that message and its End button.

After the lease is acquired the order is: start lease renewal, request task protection (recording sessions only), join voice, build the session. Renewal starts first because the lease lasts 30 seconds and a start may take as long. Each session carries an ownership signal that is aborted only when the lease is lost to another meeting, never on a normal close, the cap or shutdown.

A start has 30 seconds to reach the point of receiving audio, and that deadline also bounds the lease acquisition. If it does not, the worker tears down, releases the lease, marks the row `failed` and tells the requester.

A start is refused only for product reasons (limits, permissions), or because a capture is live in that server. No refusal depends on a previous meeting's leftovers.

The durable voice record is removed. A start always joins fresh. Discord keeps one voice state per bot per server, so a new join is authoritative.

### Capture

Capture and checkpoint publishing are unchanged: audio is cut into pieces of at most 30 seconds per speaker (`LIFECYCLE.checkpointSegmentMs`) and uploaded during the meeting, with a manifest and a pointer on the history row. The checkpoint format and its object layout do not change, so meetings recorded before this change remain readable.

The lease lasts 30 seconds and is renewed every 10 seconds while capture is live. It is never renewed past the maximum meeting duration plus 15 minutes, whatever the in-process state says.

A renewal that fails with an error is unknown, not lost: the worker keeps recording and keeps trying. A renewal that fails its condition makes the worker read the lease:

- If the lease is absent or expired and lapsed less than the adoption grace ago (`LIFECYCLE.abandonedGraceSeconds`, 120 seconds), the worker takes it again and carries on. Past the grace the finisher may already have adopted the meeting, so the lease is lost, as in the next case.
- If the lease names another meeting, the server now belongs to someone else. The worker aborts the session's ownership signal, stops receiving without sending a voice leave, writes `processing` with an interrupted capture and no finish claim, and drops the meeting. Another worker finishes it from the pieces saved before the lease was lost. Pieces not yet saved at that point are dropped: saving a checkpoint requires holding the lease, and the unsaved tail is at most the last piece per speaker plus whatever accumulated while the worker was stalled.

### Ending capture

Ending capture ("close") is the same sequence for a stop button, an empty channel, the duration cap, a capture error, and worker shutdown:

1. Confirm the lease with a conditional renewal. If the server belongs to another meeting, follow the lost-lease path under Capture instead: no flush, no leave, and the lease is left to its holder.
2. Stop receiving, send the voice leave, restore the nickname (bounded to 5 seconds).
3. Flush remaining pieces and the final context (participants, attendance, tags, chat context, completed snippet transcripts), bounded to 60 seconds. A close at shutdown uses at most 45 seconds, and less when the shutdown deadline is nearer.
4. In one write, set the history row to `processing` with the capture end time, the end reason, the captured duration, the completion policy snapshot with its decision when the snapshot settles it, and this worker's finish claim. The write is attempted up to three times, each bounded to 10 seconds; a close at shutdown makes one attempt.
5. In a `finally`: retire the checkpoint capture (its timers and publisher stop and it is detached from the meeting), delete the lease, drop the meeting from memory, identified by meeting and not by server, and clear task protection when no other capture is live. When no local finish follows, the meeting's audio encoder is ended here, bounded to 5 seconds.

A failure anywhere in close still frees the server, and the meeting is finished from whatever reached S3. If step 4 never succeeded, the finisher adopts the row once its grace has passed (see Finisher loop).

Transcripts completed after close are not checkpointed. If the local finish fails, the recovery loader transcribes the pieces that have no saved transcript.

Writing the duration at close means the weekly limit counts a meeting as soon as its capture ends, including meetings that are later finished by another worker. Writing the completion decision at close means a retried finish, or a finish by another loader, can never reverse a live auto-record cancellation.

After close the server can start another meeting immediately, while the first is still being processed. Nothing after close may identify a meeting by its server alone: buttons, tag edits, the live meeting API and in-memory lookups are keyed by meeting.

A worker that is draining or shutting down omits the finish claim in step 4, so an eligible worker finishes the meeting through the recovery loader. A draining worker therefore only ever waits on capture, never on processing. When the flush in step 3 did not complete and no finish claim is written, the capture is recorded as interrupted: the meeting is then finished from a checkpoint that lacks the unsaved tail, and its notes must say so. With a claim the capture stays complete, because the local finish holds the audio in memory.

### Finish: one pipeline for normal end and recovery

`finish` (`src/services/meetingFinish.ts`) is the only code that saves and delivers a meeting's result. There are two loaders and one pipeline.

- The **normal loader** runs on the worker that closed the capture, for that worker's first attempt only. It uses what that worker holds: the in-memory transcript compile and final pass as today, the chat log, and the locally mixed recording. It asserts that transcription succeeded; a failure is retried through the recovery loader.
- The **recovery loader** runs for every other attempt. It rebuilds the same input from the history row and the checkpoint in S3, transcribes pieces that had not been transcribed, and renders the mix from the pieces. This code is shared with processing retry.

Both produce the same input: the notes input (`MeetingNotesInput`), the transcript, the capture coverage, the completion policy, and optionally a local recording path. A completion decision already on the row is final. When an interrupted meeting has no recorded decision and none can be resolved from the saved snapshot, the recovery loader proceeds to notes; the no-speech rule still applies.

The recovery loader also runs the automatic auto-record cancellation check, which before this change ran only on the normal path. It runs only for an auto-recording that was not dismissed, whose stored decision is undecided, whose capture ended complete and which had no chat messages. It applies the stored policy's duration, word and chat limits and then asks the cancellation model, with the role's default model configuration, about the plain text of the stored transcript segments. In every other case, and when the check cannot run or fails, recovery proceeds to notes: a failed or uncertain check never cancels. Two limits are accepted: a server's override of the cancellation model is not applied on recovery, because the checkpoint does not freeze it, and a meeting with any chat message is not evaluated on recovery, because the checkpoint keeps formatted chat context rather than the messages.

A worker claims a meeting by a conditional write on its history row (`finish.owner`, `finish.expiresAt`, `finish.attempts`, `finish.nextAttemptAt`, `finish.phase`), pinned to the status and finish state it read. The owner string is unique per attempt. The claim is renewed every 30 seconds while the attempt runs and is reclaimable two minutes after its holder dies. One attempt may hold the claim for at most 45 minutes. The claim never touches the server's lease. An attempt can also be aborted from outside, by shutdown: it then schedules no retry, counts no attempt and leaves its claim for shutdown to hand back.

Pipeline steps, each skipped when its output is already recorded:

1. Evaluate cancellation first: an auto-recording cancelled at close takes the cancelled path whatever was captured. Then, for a recovery input with no saved audio at all, end `failed` without a notice. A live capture with no speech is an empty recording, not a failure, and so is a recovered one whose checkpoint itself records that the capture ended complete (nobody spoke, the recording ended normally and another worker finishes it). The row's own capture state is not enough for that: it also says complete when the final flush failed under a finish claim.
2. Upload the chat log and the transcript and record their keys.
3. Generate notes and summary, with the existing mention validation.
4. Save notes, summary, processing outcomes, the capture coverage when the row has none, and the terminal status in one conditional write.
5. Deliver to Discord.
6. After delivery settles: the quick follow-ons (user index, usage, analytics and the weekly limit notice under their existing rules), then Notion automation, then the combined recording upload (best effort), then release the claim and delete the local directory.

Analytics and the weekly limit notice run at most once; the weekly limit notice is sent only for a normal-loader input in the same attempt. A re-claimed row whose delivery had already settled re-runs only the follow-ons that guard themselves and uploads a missing recording once. When delivery is to be retried, the recording is uploaded before the claim is released, because the local recording may not survive to the next attempt.

Delivery renders from the saved row and posts through REST using the channel recorded on the row, so it does not depend on which worker runs it. It edits the meeting's summary message (or, without one, its start message) in place, which is naturally idempotent. Each notes message carries the meeting's start time as its embed timestamp, which the notes correction parser already passes through untouched. Recorded chunk ids are a floor: with recorded ids, delivery reads forward from the last one; with none, it reads the channel's most recent messages newest first, up to three pages of 100, stopping at the capture end, and resumes after the last chunk already present. Message ids are recorded per chunk. A meeting with no usable speech goes through the same summary card, carrying the no-speech notice, so it shares the marker, readback and retry rules.

Outcomes:

- A normally ended meeting becomes `complete`.
- A meeting whose capture ended abnormally (the recorded capture says so) becomes `interrupted`, as today, with notes from the audio that was saved. The notes say that the recording was interrupted, and the summary shows the capture end time when it is known.
- No usable speech follows the existing rule: the summary card with the no-speech notice, no notes.
- Auto-record cancellation and voice-only sessions with no recording keep their existing behaviour.
- A meeting with no saved audio at all ends as `failed` without a notice, unless its checkpoint records a complete capture (see step 1). This covers a start that died before recording anything.
- If steps 2 to 4 fail, the meeting is retried after 1, 5 and 15 minutes. After the fourth failure it becomes `failed`: one notice says processing failed and the saved audio is kept, and an alarm fires. The give-up writes a processing record with the failing stage marked failed (transcription for a load or transcription failure, notes for a generation failure or notes generated but not stored), so the existing portal retry finds it eligible. A cancelled input's give-up writes none. A portal retry that then succeeds and stores notes sets the status to `complete` or `interrupted` from the recorded capture, in the same write; the regenerated notes are stored and shown in the portal, not posted.
- If delivery fails for a temporary reason, including any unexpected throw while delivering, the meeting keeps its terminal status and stays visible in the portal. Delivery is retried after 1, 5 and 15 minutes, then hourly until 24 hours after its first failure, then marked failed with an alarm. A permanent Discord error (channel deleted, bot removed, permission denied) marks delivery failed at once, without an alarm.

Delivery is at least once. The channel read makes a duplicate unlikely; a rare duplicate is accepted in exchange for never needing a human to decide whether to send.

While a `lifecycleVersion: 2` row's delivery is pending, a notes correction is saved and held (`initial_publication_unsettled`); delivery completing releases it, and a delivery that gives up releases it as unpublished. A row whose finish marker is present is not eligible for the portal processing retry (`processing_in_progress`).

An operator finish may run with `deliver: false`: it saves the result, posts nothing, releases a held correction as unpublished and leaves the row reading as settled and unpublished, so the portal retry, later corrections (stored, not sent) and archiving follow their normal rules. On a row from before this design that means removing its leftover `recovery` value in the same claim-conditioned write; the delivery-done marker is never written for notes that were not posted.

No new status values are introduced. `needs_reconciliation` is no longer written and execution versions are no longer changed. The `recovery` value that a normal completion writes today is still written when delivery completes, because notes correction and the portal retry read it. Existing rows that carry them are read normally. A meeting finished by the recovery loader has no raw chat log object, only the chat context from its checkpoint.

### Finisher loop

Each eligible worker scans MeetingHistory every 60 seconds for rows written by this design (`lifecycleVersion: 2`) that are not terminal, or are terminal with a finish map left (delivery pending). It runs at most two finishes at once. For each row, in order:

1. Skip a row this process is still capturing or finishing.
2. Skip a row whose claim is held, even past 24 hours, because an attempt is itself capped.
3. Mark `failed` without a post a row that is still not terminal 24 hours after its capture began, write a processing record so the portal retry can pick it up, and log it for the alarm.
4. Skip a row whose retry time has not arrived, or whose server's lease names the same meeting and is unexpired. The lease is also a liveness clock: a starting or `in_progress` row whose lease expired less than two minutes ago is skipped, because a healthy worker renews every few seconds and retakes a lapsed lease.
5. Adopt a starting or `in_progress` row whose last write is more than two minutes old. The adopt step reads the checkpoint manifest only, never the audio pieces, and refuses while the later of the row's last write and the capture end the manifest shows is within the two minutes. It writes the capture as interrupted, with `endReason: "unknown"`, and takes the claim in the same write. The capture end is the last confirmed capture when the manifest's coverage is exact. When it is not (any piece with a cursor adjustment makes it unknown), an end is estimated for the duration only, from each audio piece's last observed arrival or else its known intervals, kept between the capture start, the row's last write and now; the stored capture end and coverage stay unknown, and the notes say so. No saved audio gives duration 0.
6. Claim a `processing` row, or a row with a finish map.

A non-terminal row more than four hours old is logged for the stuck alarm on every scan, including a row this process is finishing and a row past 24 hours whose claim is held.

A scan pass is abandoned after 45 seconds, and a lease read inside it after 10, so one hung call cannot stop the loop; an attempt the pass already started keeps running under its own claim and cap. A pass that reads the table through logs a completed-scan line, at most once a minute per worker, with the counts of rows seen and taken.

Rows without the marker are never touched by the loop. They are handled under stranded meetings.

The scan reads the whole table. That is a deliberate simplification with a known ceiling; an index on open meetings is the upgrade when the table grows.

### Commands and buttons with two workers

Every connected worker receives every interaction. Interactions fall into three classes (`src/botInteractionScope.ts`):

- **Owner controls** (the End button, `/leave`, **Stop recording**) go to the worker holding the server's live lease. With no live lease, one eligible worker replies `The recording has ended. Notes will follow.`
- **Session-scoped interactions** (`/say`, `/tts`, tag edits, image generation, anything that reads the live session) go to the holder when a lease is live, and to their normal handler on an eligible worker when none is.
- Everything else is handled by an eligible worker.

The handler claims the interaction receipt and then responds: a defer, or the modal for the buttons that open one. The receipt is a one-item transaction with its own token per attempt, so the SDK's retry of a lost response replays as success. A transaction conflict is retried as a new attempt, up to three attempts in all, and lands as ours or fails its condition as theirs; a claim still contested after the third attempt counts as not held. A worker that does not hold the receipt never responds, and claim errors and timeouts are logged without a notice. The lease read (1 second) and the receipt claim (1.5 seconds) share Discord's three seconds.

Portal and MCP controls keep their existing paths: an end request recorded on the lease, and the control command queue targeted at the owner. A draining worker polls only for commands addressed to it while it holds a meeting. A command addressed to a worker that is no longer fresh in the registry is claimed by an eligible worker, which reads the lease: while the lease is live for that meeting the command is left for its holder, and otherwise a stop is answered as ended. An executed command always gets its terminal write attempted, so it runs at most once: a start interrupted by shutdown ends `failed` and must be requested again, and a stop enqueued without a meeting id is pinned to the live meeting's id from the lease.

Auto-record starts are evaluated by eligible workers only. Channel-empty and bot-disconnected handling stay with the recording worker. A worker re-evaluates occupied auto-record channels when it first becomes eligible.

Install and removal side effects (the onboarding message and analytics events) run on eligible workers only and are claimed with a receipt, so two workers cannot both send them. Those claims have a 30 second bound, because guild events have no response deadline.

### Local files

A meeting's directory is deleted when its finish releases the claim as done on that worker. A recovery mix directory is deleted when its attempt ends, whatever the outcome. An hourly sweep deletes any directory that is older than six hours and does not belong to a capture or finish live in this process. Cleanup receipts, provenance, authorization and retained directories are removed.

### Task protection and shutdown

Protection covers recording captures only; a voice-only session neither requests nor holds it. A worker asks ECS for task protection before it joins voice, with an expiry ten minutes past the latest moment any of its leases may be renewed. It retries once a minute while a capture is live and the call has not succeeded, and it publishes `protectedUntil` in its registry item. It never extends protection without an unexpired recording lease, so protection cannot outlive the lease cap whatever the process believes. When its last capture closes it clears protection, retrying until the call succeeds. A refused or failed call is logged and counted and is never a reason to stop.

Because protection always expires by itself shortly after the longest possible capture, ECS bounds every drain without help from the worker.

Whether ECS grants protection to a second task at desired count 1 is not settled by its documentation. The design is safe either way because of the one-drain rule under Deployment: a deployment does not start while an older worker is still draining, so a deployment never stops a worker that is recording. Platform retirement and health check replacement can still stop any task, protected or not, and the meeting is then finished like any other abandoned capture.

On SIGTERM a worker runs its shutdown in bounded stages and exits within 90 seconds, inside the container's 120 second stop timeout:

1. Write `ready: false` to the registry (3 seconds).
2. Stop the pollers, the finisher loop and the local sweep, and wait for an aborted start to release its lease (3 seconds).
3. Close every live capture as interrupted, without a finish claim. This stage gets what the capped stages leave: at least 65 seconds, and 71 when the earlier stages finish at once.
4. Abort the finish attempts this process runs, wait up to 5 seconds for them to stop, then hand their claims back without counting an attempt (8 seconds).
5. Drain in-flight billing operations, release the renewal recovery lease, and wait for a personal upload poll in progress (3 seconds).
6. Close the web server and the Discord client (3 seconds).

The last 5 seconds are kept for the telemetry flush and the exit. Meetings the worker was recording or finishing are picked up by another worker on its next scan.

### Deployment

The same workflow serves production and Sandbox.

1. Continuous integration passes and the image is built and pushed, as today.
2. Preflight: the service exists, and the listener's full-weight target group is the one the service is bound to.
3. One drain at a time: if a task on an older revision is still running, wait for it to exit. That task is recording a live meeting, and its protection expires by itself within 145 minutes of that meeting's start, so the wait is bounded by ECS and not by the worker's own state. The wait gives up at 160 minutes, which fails the run and raises an alarm. Once the older task is gone, the step waits up to five more minutes for any worker with a live capture to report protection, then proceeds regardless. The drain wait and the rollout run in one backend job under a concurrency group per environment that is never cancelled in progress, so no other run can roll out between them; the job assumes its role again after the wait and times out at 240 minutes.
4. Register a new task definition revision with the new image and update the service to it, stating the intended deployment configuration explicitly: minimum 100 percent, maximum 200 percent, the circuit breaker off, a five-minute health check grace period, and the early-success setting with deferred cleanup of the old revision that the service already uses, which AWS recommends when old tasks are protected. The workflow does not change the load balancer binding, the listener or the desired count.
5. Wait up to 15 minutes for a registry item on the new release that is ready with a fresh heartbeat.
6. On success, run the existing post-deploy jobs. The old task drains on its own and the workflow does not wait for it.
7. On failure of step 4 or 5, roll back and fail the run. If the service never left the previous image, rollback changes nothing; otherwise it registers another revision with the previous image and updates the service to it. Revisions therefore only ever increase. The old worker never stopped accepting meetings. A cancelled or timed-out job does not roll back.

An optional dispatch input skips the wait in step 3 and stops older tasks with `StopTask` instead. Their live meetings end at their last saved piece and are finished by an eligible worker. This needs `ecs:StopTask` on the deployment role, which an owner grants at Terraform apply; until then the same effect is one operator `StopTask`. Only the owner dispatches it.

Before the one-way cutover marker exists (see First deployment), the script treats the old runtime as still in charge. Both the drain wait and rollback read the marker first, with three tries. With the marker absent, the drain wait does not wait for tasks on older revisions and refuses the retire input without stopping anything, and rollback changes nothing in ECS and fails with instructions to fix forward. With the marker unreadable, rollback also changes nothing; the drain wait without the retire input waits for older tasks as after the cutover, and with it fails the step and stops nothing.

Rolling back on purpose means deploying the earlier commit again, which registers a higher revision. Pointing the service at a lower revision by hand is not supported.

The coordinator, the handoff protocol, the quiet gate, the artifact seal, legacy attestation, break-glass, the introduction and cutover tooling, and their workflows are deleted.

### Background jobs

Jobs that already claim their work (the finisher, control commands, processing retry, personal uploads, meeting update delivery) run on eligible workers; each poller checks eligibility on every tick. A draining worker polls only for control commands addressed to it.

Renewal recovery runs on eligible workers under a single-runner job lease: one item in the deployment control table, taken by a conditional write at the start of every poll, lasting 600 seconds, renewed by each poll of its holder and released at shutdown. Two workers therefore never poll at once. Within a billing operation, an unknown outcome aborts that operation, so its later mutations are refused.

### Alarms

Added in the same change, each with the existing email topic as its action:

- A meeting written by this design has been non-terminal for more than four hours, or was marked failed by the 24-hour rule.
- A meeting reached `failed` after retries, or delivery failed after 24 hours.
- Task protection calls are failing while a capture is live (three in five minutes).
- No worker has been eligible for five minutes.
- No eligible worker completed a finisher scan for ten minutes (it also fires when no worker is eligible).
- Renewal recovery skipped its polls on lease errors for three periods in a row.
- A deployment waited the full 160 minutes for a drain.

The log alarms match fixed lines in `src/metrics.ts`. The code publishes the lines and the drain metric regardless. The alarm resources need a Terraform apply by the owner and nothing else depends on them.

## Data compatibility

- MeetingHistory, the lease table and the checkpoint format keep their shapes. `lifecycleVersion` and the `finish` and delivery fields are additions. Fields this design stops using are left in place and ignored.
- Existing deployment control items are not deleted.
- The portal sees the same status values as today.

## What is removed

By area:

- Deployment coordinator, handoff and routing scripts, and the introduction, cutover, paused-draft, acceptance and Sandbox bootstrap tooling under `scripts/deployment/`, with their workflows. The Terraform plan and apply helpers stay.
- Runtime lifecycle, work admission, deployment control transactions, the artifact safety, cleanup receipt and attestation services, and their in-process halves: production fixture mode and artifact producer tracking.
- The durable voice ledger, the interruption and reconciliation services, the recording delivery intent, and the code that bumps execution versions.
- The separate recovery service and worker, replaced by the recovery loader and the finisher loop.
- The operator publication tools (first publication, recovery Discord publication) and `recover-meeting-artifacts`.
- Their tests, the tests that parse source files as syntax trees, and tests of scripts nothing invokes.

The pull request description carries the measured line and file counts.

The deployment admission check is embedded in the database writes of features this design does not otherwise change. Each of these loses that check and keeps its own conditions, which already make it idempotent:

- Interaction receipts.
- Stripe webhook receipts and the billing writes that carry the same check.
- The control command queue.
- Processing retry.
- Meeting update delivery.
- Personal upload admission, including its use of paused-draft code.
- Notes correction and Notion writes.

A write that was a one-item transaction stays one where a lost response followed by a retry would otherwise read as refused and strand state (the Stripe receipt admit, the interaction receipt, the control command write). These are behaviour-preserving edits, but they touch the money path and need the same review care as a billing change.

The `production-writer-guard` step that gates Terraform apply and the post-deploy jobs reads coordinator state. It is removed from those workflows, which keep working exactly as before otherwise.

The work handle that today threads through about 40 function signatures is replaced by a plain shutdown `AbortSignal`.

## Documentation

`AGENTS.md` keeps the policy and points at `docs/engineering/invariants.md` for the lifecycle rules; `.github/copilot-instructions.md`, `README.md`, `_infra/README.md` and `docs/engineering/` describe the new deployment. `docs/deployment-handoff.md`, `docs/production-introduction.md` and the Sandbox bootstrap documents are replaced by one deployment document, `docs/deployment.md`. One ADR records this decision. The public docs change where they describe what happens to meetings during updates and after an interruption, with a What's New entry, so the change is not `docs-exempt`.

## First deployment

The first deployment replaces a worker that still runs the old protocol, and the two must not process the same meeting. `docs/deployment.md` holds the operator procedure.

- The backend job of the first deployment is approved at a moment when the old runtime is idle, checked by a person after the approval request appears.
- While any old-protocol runtime record has a fresh heartbeat, or while those records cannot be read, a new worker is ready but not eligible. It takes no meetings, runs no finisher, and never asks for protection. This is the only place the new code reads old state, and it is removed in the following release.
- The new workflow updates the service. An operator then stops the old task, at an idle moment after the new worker reports ready.
- When every old-protocol heartbeat has been stale for two minutes, the new worker writes a cutover marker to the registry and becomes eligible. The marker is permanent: once it exists no worker enters standby again, whatever the old records say. Starts are unavailable from the stop until the cutover, about two to four minutes, once.
- Until the old task is actually stopped, an old runtime that came back to life could process a meeting the new worker had closed, producing a second notes post. Stopping the old task is therefore part of the procedure and not optional.
- If ECS refuses the old runtime's protection renewals while the new worker stands by, the old runtime closes admission about eight minutes after its last successful renewal and may then be stopped by ECS at a moment nobody chose.
- If the new worker never becomes ready, nothing is rolled back or stopped: the service stays on the failed revision and ECS keeps retrying it while the old runtime serves. The fix is a new deployment of a fixed commit, which the drain wait does not hold.
- From then on the old voice records are ignored, so a server locked out by one can start meetings again.
- The finisher only touches rows it wrote, so nothing left over from the old runtime is processed or posted by this deployment.

There is no return to the old protocol after this point. The mitigation is that everything is proven in Sandbox first, and that the new deployment path cannot be blocked, so a fix can always ship.

## Stranded meetings

Existing unfinished meetings are handled once, deliberately, and never by the automatic loop (`scripts/stranded-meetings.ts`, run as `yarn meetings:stranded`).

- `list` writes every row without the marker whose status is `starting`, `in_progress` or `processing`, with whether a live lease still names it and what its checkpoint manifest claims, to a new owner-only directory, and prints only the count. A terminal unmarked row left with a finish map (by an operator run whose delivery did not complete) is not listed, though `finish` accepts it.
- `finish` runs the recovery loader and `finish` for a named meeting, with an explicit choice of `--post` or `--no-post`. It refuses a meeting whose live lease names it, runs its own bounded retries, restores a row that still needs processing exactly as it found it when it cannot finish or is interrupted, and exits 0 only when the meeting finished.

The ledger of affected meetings, the per-meeting decisions and any customer contact belong in the private operations repository and need the owner's authorization.

## Testing

One shared harness (`test/scenarios/harness/`): local DynamoDB, an in-memory object store, a fake Discord gateway, voice receiver and REST surface that records posts, a fake transcription and text provider, a fake ECS agent, and workers started through the production `startWorker` in separate module registries with a chosen release. Speech is delivered as jittered 20 millisecond frames, so saved coverage reads unknown as it does in production. The scenario suites run with `yarn test:integration` against local DynamoDB.

Each scenario asserts what a customer would see. Worker-level scenarios start real workers against fakes for Discord, voice, storage and the model provider and a real local DynamoDB, with timers scaled to seconds; the module-level suites drive one stage with real repositories against local DynamoDB.

| Scenario                                                                                                  | Worker level                                                         | Module level                                                   |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1. Start, speak, end: notes once, lease gone, a second start succeeds                                     | `meeting.integration.test.ts` "scenario 1"                           | `close.integration.test.ts`, `worker.integration.test.ts`      |
| 2. A second meeting starts while the first is processed; controls reach the right meeting                 | `meeting.integration.test.ts` "scenario 2"                           | `close.integration.test.ts`                                    |
| 3. A worker dropped mid-capture: finished from S3, marked interrupted, server free, duration counted      | `failure.integration.test.ts` "scenario 3"                           | `finisher.integration.test.ts` "scenario 3", adoption tests    |
| 4. Dropped after the terminal save, before posting: posted once                                           | `failure.integration.test.ts` "scenario 4"                           | `delivery.integration.test.ts`, `finisher.integration.test.ts` |
| 5. Dropped between two notes messages: the rest posted, none repeated                                     | `failure.integration.test.ts` "scenario 5"                           | `delivery.integration.test.ts`, `finisher.integration.test.ts` |
| 6. Discord rejects temporarily, then permanently                                                          | `failure.integration.test.ts` "scenario 6"                           | `delivery.integration.test.ts`                                 |
| 7. Transcription or notes keep failing: retries, then `failed` with one notice, retryable                 | `failure.integration.test.ts` "scenario 7" (notes and transcription) | `finish.integration.test.ts`                                   |
| 8. Two workers receive the same start: one meeting                                                        | `meeting.integration.test.ts` "scenario 8"                           | `lease.integration.test.ts`                                    |
| 9. A newer worker becomes ready: the older drains, its controls still reach it, the newer one finishes it | `deployment.integration.test.ts` "scenario 9"                        | `worker.integration.test.ts`                                   |
| 10. SIGTERM during capture                                                                                | `deployment.integration.test.ts` "scenario 10"                       | `worker.integration.test.ts`                                   |
| 11. A worker stalls past its lease: retake, or yield without a leave                                      | `failure.integration.test.ts` "scenario 11" (both cases)             | `lease.integration.test.ts`, `close.integration.test.ts`       |
| 12. A start that never reaches receiving audio                                                            | `failure.integration.test.ts` "scenario 12"                          | `start.integration.test.ts`                                    |
| 13. A start that dies before saving audio ends silently                                                   | `failure.integration.test.ts` "scenario 13"                          | `start.integration.test.ts`, `finish.integration.test.ts`      |
| 14. Old-protocol record fresh, then stale, then fresh again                                               | `deployment.integration.test.ts` "scenario 14"                       | `registry.integration.test.ts`                                 |
| 15. Protection never extended past the lease cap                                                          | `failure.integration.test.ts` "scenario 15"                          |                                                                |

What the worker-level suites prove:

- **End to end:** scenarios 1, 2, 4, 5, 8, 9 (every clause, including a stop press only the recording worker answers, a portal stop to the draining worker, and two live recordings across a hand-over), 10 (and a finish aborted by shutdown and resumed elsewhere with no attempt counted), 12, 13 and 15.
- **In part:** 3 (adoption, the early-end notice, the freed server and the weekly limit through a real refusal are proven; the notes state no end time; the duration is precise only because scenario pieces seal every second, and in production it can be short by up to one 30 second piece per speaker); 6 (temporary then permanent rejection; the 24 hour give-up with its alarm is not exercised with real workers); 7 (retry schedule, single notice and alarm; "retryable from the portal" is an eligibility check, and no retry is performed); 11 (a worker cut off from DynamoDB, not a frozen process); 14 (a seeded old-format heartbeat row, not a running old runtime).

Added worker-level scenarios: an End press where no worker is recording gets exactly one reply; an End press while a dead worker's lease is unexpired gets no reply until it expires; two eligible workers see the same auto-record join at the same instant; a manual meeting with no speech; an auto-recording cancelled before anyone speaks; a portal stop through the control queue; a portal stop addressed to a draining worker; a hand-over while the older worker holds two recordings; a finish attempt aborted by SIGTERM while generating and after the terminal save, resumed elsewhere with no attempt counted; no eligible worker; a worker that dies before its first piece is sealed; a storage failure during the final save, finished by another worker; a storage failure at close on the only eligible worker, finished by that worker under the claim its close wrote; a worker that dies before close, so the row has no completion decision; a worker that dies with a portal stop pending; a protection request refused once and then granted. Module-level suites also cover a stop during a start (`stopDuringStart.integration.test.ts`) and the normal-loader path with real checkpoints (`lifecycle.integration.test.ts`).

Not covered at worker level: a personal meeting, the duration limit ending a meeting, a control-queue start, a notes correction while delivery is pending, the weekly-limit notice, a hanging (not rejected) upload, a gateway disconnect. Workers run in bot mode only, so the web server, the health route and the API pollers are not exercised end to end, and no test signals the real entry point. The storage acceptance test merged from the main branch needs the application and MinIO Docker images and is proven only by CI.

Unit tests remain where a function has real branching (eligibility, claim conditions, backoff, delivery resume, the finisher's row classification and capture end estimate, the shutdown budget). Tests of removed modules go with them.

Sandbox acceptance before merge, with real Discord:

- Two consecutive meetings in one server.
- A deployment during a live meeting: the old worker finishes its capture, an eligible worker finishes it, a meeting in a second server starts on the new worker during the drain, and a stop button pressed during the drain reaches the old worker.
- A second deployment queued during that drain waits and then completes.
- `StopTask` mid-meeting: partial notes arrive and the server can start again.
- An hour at desired count 2, to observe duplicate handling.
- The first-deployment procedure, rehearsed against the old runtime in Sandbox, including a simulated failed first attempt.

The Sandbox deploy role has no Terraform scope for its `PutMetricData` and `StopTask` grants, so until an owner closes that gap a Sandbox rehearsal cannot exercise the retire input or the drain alarm.

## Things Sandbox must answer

- Whether ECS grants protection to a second task at desired count 1. The design does not depend on the answer; it decides only whether a recording that starts during a drain is protected or merely safe.
- Whether a protected old task stays registered with the load balancer for the length of a drain.
- Whether protection stops ECS from replacing a task that fails its health check. AWS documentation does not say.
- How long a dead worker's voice presence lingers before Discord removes it.
- That every worker receives every interaction. The interaction receipt exists because duplicate acknowledgments were seen during overlaps.
- How real DynamoDB behaves for concurrent receipt transactions: N concurrent claims from separate clients against one item, recording the cancellation codes seen, with exactly one winner. DynamoDB Local serialises transactions and never returned a conflict.
- Whether Discord echoes the embed timestamp at millisecond precision, which delivery's readback matches on.
- Whether `update-service` accepts the grace period as `rollout` sends it, and whether the first Terraform plan after the change shows a diff for the absent circuit breaker block or the early-success settings.
- Whether the "no worker eligible" alarm's timing holds up against log ingestion delay.
- Real audio timing: whether real 20 millisecond voice frames produce cursor adjustments, as production data suggests, and that an adopted meeting's estimated duration is then right.
- Scenario 11 with a really frozen process, rather than a worker cut off from DynamoDB.
- In the first-deployment rehearsal: that a running old runtime holds the new worker in standby; whether the old runtime's task is protected at that moment; whether ECS refuses its protection renewals while the new worker stands by unprotected; that a failed first attempt leaves the old runtime serving, ECS not stopping it, and a second attempt not held by the drain wait; and whether the `sandbox` GitHub environment requires approval.

## Known costs of this pass

- While an old worker drains, both tasks are in the target group, so some portal requests reach the older code, and a live transcript view served by the non-recording worker shows status only. Splitting the API into its own service removes this.
- A deployment that arrives during a drain waits for it, up to the length of a meeting. A fix that cannot wait uses the retire input.
- A recording that starts on the new worker during a drain may be unprotected until the drain ends.
- A meeting that ends on a draining worker is finished by the new worker from S3. Its notes are the same, but it has no raw chat log object, and its final transcription pass runs on a mix rendered from the pieces.
- A meeting whose worker died, and whose saved coverage is unknown (the usual case, since jitter makes it unknown), counts an estimated duration and its notes say the exact end time is unknown. The estimate can be short by up to one 30 second piece per speaker, and the portal and Notion show the duration as unknown while the weekly limit counts the estimate.
- An End press gets no reply while a dead worker's lease is still unexpired, up to 30 seconds, because only the lease holder may answer it.
- A worker that dies within the first 30 seconds of speech, before any piece is sealed and saved, leaves the meeting `failed` with nothing posted.
- On a lost lease the unsaved tail is dropped. A close at shutdown whose flush takes longer than its bound loses its unsaved tail too, and the meeting is finished as interrupted.
- A failed local finish repeats transcription for snippets that completed after close.
- A meeting whose transcription keeps failing costs up to four attempts before it is marked failed.
- A control-queue start interrupted by shutdown must be requested again.
- With no recorded chunk ids and 300 or more messages posted in the channel after a crash, an unsaved chunk falls outside the readback and is posted again. A summary message created just before a crash, with its id unsaved, can be posted again.
- An analytics event or a weekly limit notice can be lost in a crash within milliseconds of delivery settling.
- Renewal recovery pauses for up to ten minutes after the worker holding its job lease dies.
- A failed first deployment leaves ECS retrying the failed revision until the owner deploys a fix.

## Deferred, in the order they should come

1. Bot and API as separate services.
2. Steady state with more than one worker: live transcript served through the owner, shared rate limits, and a per-worker capture limit that the registry's `captures` count already supports. Known gaps at that point: two eligible same-release workers can both post an auto-record failure notice for one join; a shutting-down worker ignores controls for captures it is closing; a stop pressed on one worker milliseconds before another worker's lease write lands is missed; a worker whose registry reads keep failing still advertises itself as ready.
3. Scaling on capture count.
4. Per-meeting memory budget and publisher behaviour under pressure (#500, #566).
5. Continuing a live recording on another worker.
6. Discord sharding, when server count requires it.

Smaller follow-ups, by area:

- **Finish.** A claim cut off by the 45 minute cap or by claim loss is not counted as an attempt, so a deterministic over-long attempt repeats until the 24 hour rule. A wedged attempt hides its row from that worker's loop until restart (the stuck alarm still fires). The recovery loader renders the mix twice. The recorded processing outcome reflects only the last attempt. `meetingFinish.ts` should shed its delivery settlement or row-shaping helpers when it next grows.
- **Close.** An undecided auto-recording whose flush failed on a draining worker is recorded as interrupted and so proceeds to notes without the cancellation check. Two waits in the final transcript compile take no signal, and the normal loader's wait for the encoder is unbounded. At shutdown the capture-end write gets one attempt even when the stage has time for more. When lease confirmation errors and the lease runs out with nobody else taking the server, the bot can stay in the voice channel with its recording nickname until Discord drops it, with no metric.
- **Deployment.** Rollback compares images, so a redeploy of the same image digest on a new revision that fails readiness is not rolled back; compare revisions instead. The Sandbox plan validator cannot tell a parked Sandbox from a running one. A Terraform scope for the Sandbox deploy role's grants.
- **Interactions.** The session-scope guard test works per file. Settings-only `/tts` subcommands stay silent on an eligible worker while another worker holds a live lease. On the ended branch about half a second of Discord's three remains.
- **Operations.** A metric filter for the line that logs a worker held in standby by an unreadable legacy heartbeat (the "no worker eligible" alarm already fires in that state). Removing the legacy standby read in the following release, and the unused infrastructure after it.
- **Billing (pre-existing, not changed here).** A pre-existing race in renewal recovery reconciliation, tracked privately. A pre-existing gap in how an interrupted webhook handler is re-admitted, tracked privately.
- **Open questions for review.** Whether a successful portal retry of a meeting the pipeline gave up on should post its regenerated notes (they are stored, not posted, as before this change); the portal copy for `processing_in_progress` during a 24 hour delivery backoff.

## Decisions made without the owner

The owner asked to skip the design questions. These are the calls that were made in their place.

- A meeting whose worker dies ends there, with partial notes, and is not rejoined.
- Notes can be posted twice in rare cases, in exchange for never blocking on an uncertain send.
- A server may start a new meeting while its previous one is still being processed.
- A meeting still unfinished after 24 hours is marked failed without a post.
- Existing stranded meetings are never finished or posted automatically.
- The first deployment has a start gap of about two to four minutes and needs one operator `StopTask` at an idle moment.
- A worker that is being replaced hands its meetings' processing to the new worker instead of finishing them itself.
- There is no rollback to the old protocol after cutover.
- A deployment waits for a previous deployment's live recording unless told to retire it.
- Bot and API stay in one task for now.
- Infrastructure that becomes unused is left in place for one release.
- Whether to grant `ecs:StopTask` to the deployment role is left to the owner at Terraform apply.
- On a lost lease, unsaved pieces are dropped and close does not flush: saving a checkpoint is fenced by the lease, and the case needs a stall longer than the lease and another start in the same server during it.
- The checkpoint capture is retired when close frees the server: fencing post-close content writes on the finish claim would add a second fencing rule.
- A close at shutdown flushes for at most 45 seconds and makes one capture-end write attempt, so it fits the shutdown budget.
- The completion policy snapshot and decision are written by close's capture-end write, not at start: the transition validator accepts a completion policy only with a checkpoint revision proof, which a start does not have.
- Cancellation is evaluated first, and a silent live capture is an empty recording, not a failure: that is today's behaviour.
- After delivery settles the order is quick follow-ons, Notion, recording upload, release: no new stored state, at the cost of an analytics event or limit notice lost in a crash within milliseconds of the settle.
- A `lifecycleVersion: 2` row with delivery pending holds corrections, and giving up releases them as unpublished: a correction must not be posted ahead of the notes it corrects.
- The pipeline's give-up writes a processing record, so the existing portal retry can pick the meeting up.
- A finish attempt can be aborted from outside (shutdown) without counting an attempt: a deployment should not use up a meeting's retries.
- The finisher uses the lease as a liveness clock for adoption: a meeting's row does not move while pieces are saved, so its last write alone could adopt a live capture.
- Adoption reads the checkpoint manifest only: downloading pieces inside the scan would stall it on one bad checkpoint.
- For an adopted meeting whose exact coverage is unknown, the capture end is estimated for the duration only: otherwise it would count zero minutes toward the weekly limit, and the stored end and coverage stay truthfully unknown.
- A held finish claim is skipped before the 24 hour rule: an attempt is itself capped, so cutting it off would only race it.
- Abandoned rows get a processing record, so the portal retry can pick them up.
- An interrupted meeting with no recorded completion decision proceeds to notes: holding such meetings for a person is the state that stranded meetings before.
- A lease that lapsed longer ago than the adoption grace is lost, not retaken: past the grace the finisher may have adopted the meeting, and a retake would record into a row that is no longer capturing.
- A flush that did not complete with no local finish to follow records the capture as interrupted: the notes are then built from less than was recorded and must say so.
- A recovered recording with no audio is an empty recording only when its checkpoint records a complete capture: nobody spoke. Without that proof it stays `failed` with nothing posted, since a false "nobody spoke" is worse than silence.
- A successful portal retry of a meeting the pipeline gave up on settles its status; whether its notes are then posted is left to the owner.
- An operator finish without posting removes an old row's leftover `recovery` value: nothing else makes such a row read as settled without claiming its notes were published.
- The shared DynamoDB client and the control command client have a 3 second connection and a 10 second request deadline, and a timed-out request is retried like any transport error: one hung request must not stop the registry heartbeat or hold a finish slot. One call can therefore take about 30 seconds in the worst case.
- Shutdown runs in the stages and bounds above: every step but capture closing is capped, so a hung step can only take time from capture closing.
- `/health` latches after the first ready registry write: a Discord outage must not make ECS replace a healthy task.
- On ECS the worker's instance id never comes from the environment: a value in the task definition would be shared by every task.
- Interactions are routed in two live-session classes, owner controls and session-scoped interactions: a session interaction answered by a worker that does not hold the session would say there is no meeting during a drain.
- The interaction receipt is a one-item transaction with a token per attempt, a conflict is retried, and a worker that does not hold the receipt never responds: a plain write lost retried writes, and a loser that replied could make the winner's reply fail.
- Guild install and removal side effects are claimed by receipt, so two workers cannot both send them.
- A control command for a worker that is gone is answered by an eligible worker from the lease, instead of waiting out its expiry.
- An executed control command runs at most once: a start interrupted by shutdown ends failed and must be requested again.
- The drain wait and the rollout run in one job under one concurrency group: two jobs could both pass the wait and break the one-drain rule.
- Before the cutover marker exists, rollback changes nothing and the drain wait neither waits for nor retires the old runtime: ECS does not adopt running tasks on a previous revision, and a revision built from the new task definition cannot boot the old code.
- Revisions only ever increase: rollback registers a new revision with the previous image.
- Renewal recovery runs under a single-runner job lease: two overlapping polls could read an invoice in an order that records a payment wrongly.
- An unknown billing outcome inside an operation stops that operation's later mutations, as before this change.
- A recovered meeting with no usable speech gets the same summary card with the no-speech notice as a live one, where it used to get plain text: one delivery path for both sources.
- Voice-only sessions can now be ended by a portal or control-queue stop, because every session ends through the same close.
- Two pre-existing billing issues are left for the owner to decide, both tracked privately: one in renewal recovery reconciliation and one in how an interrupted webhook handler is re-admitted.
- The recovery loader runs the automatic auto-record cancellation check for an undecided, completely captured auto-recording with no chat messages, and proceeds to notes in every other case and on any failure: a meeting finished from S3 should be cancelled the same way as one finished locally, and a failed check must never cancel.
