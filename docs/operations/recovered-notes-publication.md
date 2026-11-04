# Publish recovered notes

Use this installed operator workflow for version-2 stored-only snippet recoveries.
Archived meetings are skipped automatically. Preview and reconciliation are
read-only; apply requires approval of the exact saved plan digest.

## One-time setup and release acceptance

Use Node 24.22.1 and the repository's locked, patched dependencies. Set
`CHRONOTE_OPERATOR_PROFILES` to a private JSON configuration. It contains a
`profiles` map keyed by environment name, plus `stateDirectory` and
`releasesPath`. A profile contains accountId, region, historyTable, activeTable,
controlTable, bucket, archiveWriters (cluster/service pairs for every archive
writer/control reader), and optionally tokenSecretId. Credential values do not
belong in this file or Git. Select an operator AWS profile explicitly with
`AWS_PROFILE`, without conflicting access-key environment variables. A managed
container role is also supported. Root account credentials are refused.

Release workflows maintain compatible immutable-image metadata and upload a
`recovery-publication-release-*` artifact. Install that JSON at releasesPath when
installing/updating the operator release. Its absence or unknown images produces
a normal tool-update/runtime blocker. The source checkout intentionally does not
invent compatible production images. A compatible completed deployment enrolls
the environment automatically. Release metadata accumulates previously supported
images from the deployment-control record, without per-meeting PRs.

Before initial production use, separately deploy and verify the archive guard and
incompatible-deployment reservation across supported writers. Prove the command
workflow in Sandbox with synthetic data. These are release acceptance tasks,
not checks the operator repeats by hand for every recovery. This runbook does not
authorize deployment or publication.

## Preview, approve, apply

Save a private selection JSON array of `{guildId, channelId_timestamp}` entries,
or `{bundle: "relative/path/to/import-bundle.json"}` references. Bundles contribute
only their selected meeting keys. One batch supports up to 25 unique meetings;
normal longer notes paginate automatically. Preview also checks the projected
DynamoDB transaction and item sizes, including room for final message pointers
and verified receipts. An oversized batch asks for fewer meetings. A meeting
that cannot fit registration is blocked before claiming or posting; no stored
history is deleted to make it fit.

```text
node -r ts-node/register/transpile-only scripts/publish-recovered-meeting.ts first-publication preview --environment production --selection PRIVATE_SELECTION --out NEW_PRIVATE_DIRECTORY
```

Review preview.html: exact posts, destinations, skip/block results and conditional
record changes. Approve its digest, then run:

```text
node -r ts-node/register/transpile-only scripts/publish-recovered-meeting.ts first-publication apply --preview PRIVATE_DIRECTORY/preview.json --expect-sha256 APPROVED_DIGEST
node -r ts-node/register/transpile-only scripts/publish-recovered-meeting.ts first-publication status --preview PRIVATE_DIRECTORY/preview.json
```

The tool handles its checks automatically. Archived rows and verified prior
publication are successful no-ops. An eligible blocked row prevents sending the
batch; explicitly change the selection and preview again to exclude it. Apply
never silently includes newly unarchived rows or substitutes another destination.
It retains original language, partial-recording notices and safe mentions. It
creates notes posts, verifies each by GET, and registers their IDs conditionally.
Automatic delivery and Notion remain held.

## Interrupted runs and ordinary blockers

```text
node -r ts-node/register/transpile-only scripts/publish-recovered-meeting.ts first-publication reconcile --preview PRIVATE_DIRECTORY/preview.json --out NEW_RESOLUTION_DIRECTORY
```

Reconcile performs reads only. Where positive evidence permits it, its preview.json
contains a finalize, release or continuation plan. Review and approve its digest,
then use the same apply command. Finalize/release send no Discord messages;
continuation sends only positively unsent pages. Existing verified pages are not
resent. No new script or PR is required for these supported resolutions.

| Result                                            | Next action                                         |
| ------------------------------------------------- | --------------------------------------------------- |
| Archived/already published                        | None                                                |
| Permission missing                                | Server owner fixes access; rerun preview            |
| Source or destination drift                       | Refresh preview and approve it                      |
| Mixed/unavailable runtime                         | Retry after a compatible stable deployment          |
| Unknown build                                     | Install the corresponding operator release metadata |
| Known IDs, unregistered post                      | Review/apply reconcile's finalization plan          |
| Known-unsent abandoned claim                      | Review/apply reconcile's release plan               |
| Unknown send with no positive message-ID evidence | Keep blocked and investigate; never blindly retry   |

Positive stopped-run evidence for local commands is an owner-only exit record
written at the actual Node process exit event. A crash without an exit record
cannot be inferred stopped merely from elapsed time or an absent search result.
Uncertain submissions remain protected even with a stopped-run record. A provider
response/request trace identifying the actual message is needed for any later
forensic recovery that lacks an ID; no force-clear is exposed here.

Exit codes: 0 successful/verified no-op, 1 invalid input or runtime error,
2 actionable blocked/known-unsent, 3 partial/uncertain. Console output contains
compact status, not transcript or provider payloads. Private before-bindings and
attempt receipts remain available for diagnosis. Discord sends are not atomic
across messages/meetings. A timeout can keep archive changes and incompatible
rollback blocked until reconciliation, potentially indefinitely if evidence is lost.

## Verification boundary

Local tests use synthetic content and loopback DynamoDB only. They are distinct
from serving-version acceptance, Sandbox delivery proof and production publication.
Do not call a source commit or successful preview proof that a customer received
notes. Record live acceptance only after it has actually run under its authority.

## Implementation decisions and review

The implementation uses one atomic batch claim for all selected meetings and its
run pin. This closes the gap between acquiring separate meeting claims, at the
cost of limiting a batch to 25 meetings. The same transaction builder handles
claims, page receipts and settlement.

The source adapter validates the stored version-2 manifest directly. AWS identity
comes from STS because recovery manifests do not contain an account identity.
Only the existing private-file helpers are reused from the earlier importer;
unrelated recovery artifacts are not part of this feature.

Normal compatible releases enroll the publication protocol and maintain its image
catalog. Initial production introduction retains its separate authority. Missing
positive process-exit evidence blocks transfer, even if the process appears gone.
These limits avoid guessing about an unknown runtime or send.

One independent whole-branch review identified two defects. Regression tests
reproduced both before their fixes:

- A canonical edit begun after a first-publication claim could invalidate final
  registration. First-publication ownership now excludes canonical edits through
  the shared repository guard. Legacy repair still preserves newer canonical
  edits, covered by the real DynamoDB integration suite.
- Replaying a successfully finalized resolution returned an evidence-change
  error. An exact approved replay now verifies the existing publication and
  returns success without sending again. Although originally graded minor, this
  was treated as important because interrupted operators must be able to retry.

GitHub review also identified aggregate transaction overflow and final registration
rows that could exceed the item limit after sending. Preview and acquisition now
check capacity, including future verified receipts and every final message pointer.
The DynamoDB transaction builder checks actual writes too. Reproducing regressions
cover both failures and a successful near-limit publication. These checks follow
[AWS transaction limits](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).

A related CLI regression verifies that successful release and release replay
return exit code 0. No independent-review findings were deferred or left
unjudged. The fix pass also shares source snapshots, pin schemas and test setup,
and moves archive storage and deployment publication checks into their own
modules to meet the existing quality limits without raising thresholds.

Native execution used one implementation context and one independent reviewer.
The tradeoff is shared implementation context across tasks; regression tests and
whole-branch review provide the final independent check. Hosted Sandbox acceptance,
deployment and real Discord publication remain separate work.

### Local verification evidence (2026-11-03)

The final unchanged source passed 580 Jest suites (6,665 tests), all 50 selected
loopback DynamoDB integration tests, backend compilation, operator CLI typecheck,
touched-file ESLint, Prettier, CJS syntax checks and `git diff --check`.
The complete unit suite ran with two workers and coverage collection disabled.
The integration suites were `firstPublicationWorkflow`, `controlTransactions`
and `meetingPublicationExclusion`, using the dedicated deployment test config.
All provider data in these tests was synthetic. This evidence does not include
hosted Sandbox acceptance, a deployment or actual Discord delivery.
