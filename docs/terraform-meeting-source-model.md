# Sandbox delivery plan source model

The delivery guard may classify aggregate unknown checks and computed GSI warm
throughput only for the audited Sandbox model below. The permitted effects remain
the two delivery attributes, `UpdateDeliveryDueIndex`, and the exact MeetingHistory
`DescribeTable` addition, or their completed no-op state. A failed check is never
an excluded check. This model does not authorize a plan, Apply or deployment.

## Source and installation boundary

`terraform-meeting-model.cjs` pins the filenames and SHA-256 content digests of all
25 top-level `_infra/*.tf`, `*.tf.json` and `.terraform.lock.hcl` files through
`bindingHash`. Only this source-model calculation normalizes CRLF to LF. Raw lock,
saved plan, command capture, policy and bundle bytes retain their existing checks.
Added or removed files (including overrides), symlinks and changed source refuse.
The checkout must match the native invocation's commit and its committed files.

Plan verification follows the authenticated native run and renders the exact
saved `tfplan`. Apply first verifies its producer run, private bundle and native
source relation. A later Apply commit is allowed only under the existing verified
relation proving Terraform inputs unchanged. The model then binds an opaque proof
to that exact rendering. A boolean, digest supplied by a caller, or another plan's
proof cannot enable it. Readonly init must succeed and a subsequent version JSON
record must identify Terraform 1.17.1 and installed AWS 6.71.0. The checked lock
pins the installation. Older captures without that record remain refused.

## Dependency audit

The closure is the 30 DynamoDB tables enumerated in `closure`, the DynamoDB access
policy, and `aws_kms_key.app_general`. All 32 addresses must be present, including
no-ops. Every other resource is outside this model.

The policy in `main.tf` references those tables directly. The tables in `main.tf`
and `config.tf` reference `local.name_prefix` and the KMS key. `name_prefix` depends
only on `project_name` and `environment`. The KMS key has literal settings and no
policy reference; its separately managed KMS policy is a downstream consumer, not
a dependency. Table names, keys, billing, encryption, TTL, tags and recovery are
literal except the name prefix and KMS ARN. None of the 32 resources has a lifecycle
check, count or for_each depending on an excluded variable. The sole dynamic table
exception is the processing-retry index and attributes. Its source gate is
`ENABLE_PROCESSING_RETRY_INDEX`; the plan must prove typed `false`, with exactly
the two static delivery/history GSI blocks serialized. Unknown or enabled gates
and serialized dynamic configuration refuse.

| Excluded checks                                                                                               | Audited dependency direction                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECS_DESIRED_COUNT`                                                                                           | ECS service count validation also reads `environment`; no edge from that variable's validation back into a table or KMS key.                                                  |
| `ENABLE_API_ALB`                                                                                              | Cross-variable validation reads `API_DOMAIN`; ALB counts and API URL/certificate locals feed serving resources, not this closure.                                             |
| `frontend_distribution_id`, `docs_distribution_id`                                                            | Format checks and `site_distribution_arn` feed publishing policy and CloudFront postconditions. Publishing consumes the KMS key; the key does not consume publishing.         |
| `grafana_token_rotation_days`                                                                                 | Validation, Lambda environment and EventBridge schedule are confined to rotation.                                                                                             |
| `production_acceptance_fixtures`                                                                              | Validation and acceptance folder/object locals feed the collector and its policies. These read table ARNs, with no reverse dependency.                                        |
| Four `production_introduction_*` ARN/task inputs                                                              | Their validations feed role policies and launcher-read preconditions. The introduction enabled/count/for_each locals and table lists are downstream of this closure.          |
| CloudFront `docs` and `frontend`                                                                              | Distribution postconditions compare their IDs with the publishing inputs. Neither distribution is a dependency of the tables or KMS key.                                      |
| ElastiCache `redis`                                                                                           | Count and local auth-token precondition are confined to the cache. Cache consumes KMS, not vice versa.                                                                        |
| IAM policy `site_publishing`                                                                                  | Its count/precondition and site locals are outside the closure.                                                                                                               |
| IAM roles `production_acceptance_collector`, `production_deploy`, `production_introduction`, `sandbox_deploy` | Counts/for_each and lifecycle checks use environment, introduction/acceptance inputs, GitHub identity and HTTPS routing. Their policies consume table/KMS outputs downstream. |
| IAM role policy `production_launcher_reads`                                                                   | Its lifecycle check requires declared route roles; it has no reverse edge into a table or the key.                                                                            |

The exact nine resource and ten variable identities are in `excludedChecks`.
Excluded resources must be absent from the entire change list, including keyed or
counted instances. Unknown checks may have no instances. Relevant checks require
pass, even when their resource is a no-op. New identities, malformed records,
duplicates, failed/error instances and unsupported statuses refuse.

Existing indirect files belong to CloudFront functions, Grafana dashboards and
Lambda/archive resources outside the closure. None feeds the 32 resources. There
are no modules in this root. Adding a module or any source reference that could
alter this dependency model changes the pin and requires another audit. Editing an
outside file cannot affect the pinned closure, because the audited closure does
not read it. Direct-reference absence alone is not the exclusion proof.

The processing-retry metric filter and alarm address the app log group and the
critical-alerts topic by name through `local.app_log_group_name` and
`local.critical_alerts_topic`, so they do not depend on the KMS key policy. Those
locals derive only from `name_prefix`, the region and the caller identity, and
only the log group, the topic and that filter and alarm read them. No closure
resource reads either local, the log group or the topic.

## Computed GSI representation

The official `table.go` files at v6.69.1, v6.70.0 and v6.71.0 are byte-identical. In
[AWS provider v6.71.0 table.go](https://github.com/hashicorp/terraform-provider-aws/blob/v6.71.0/internal/service/dynamodb/table.go#L619-L642),
`warmThroughputSchema` is both optional and computed, as are its read/write unit
fields. The GSI schema uses it too. It is writable when configured, so a computed
mask by itself cannot justify ignoring it.
The same version's [GSI update comparison](https://github.com/hashicorp/terraform-provider-aws/blob/v6.71.0/internal/service/dynamodb/table.go#L2256-L2272)
skips a warm-throughput update when the new configuration omits it or leaves it
empty. This guard requires actual configuration absence before using that rule.

Only after source and installed-provider proof, the exact static configuration
must declare literal `PAY_PER_REQUEST`, `GuildTimestampIndex` (guildId/timestamp,
ALL) and `UpdateDeliveryDueIndex` (updateDeliveryQueue/updateDeliveryDueAt,
KEYS_ONLY). Unique literal names bind configuration to after-state by name,
independent of array order. Throughput and capacity expressions must be entirely
absent, including null, empty and reference expressions.

Only GSI `warm_throughput` may normalize absent/empty values and the recognized
computed unknown mask. Nonempty or null before/after values refuse. Unknown keys,
projection or identity, on-demand limits, table-level warm throughput and all
other writable settings retain strict comparisons. The shared processing-retry
table validator does not receive this exception. The future numerical provider
default remains unknown; this policy proves no configured throughput change.
The delivery guard also refuses known nonempty warm values on its strict route,
even when an existing index has the same value before and after. This delivery
restriction does not change the separate processing-retry scope.

## Maintenance cost

### Worker capacity audit (2026-10-30)

The worker-capacity change adds `bot_task_cpu` and `bot_task_memory` locals,
selected only by `environment`, and uses them for the task and container CPU
and memory values. Only `aws_ecs_task_definition.app_task` reads these locals.
The task definition is outside the 32-resource delivery closure; no table,
DynamoDB access policy, KMS key or excluded check gains a dependency on it.
The closure, excluded-check identities and installed-provider requirements
remain unchanged. The source pin includes this reviewed `main.tf` edit;
the native synthetic fixtures continue to bind the actual committed source.

### Site-permissions dependency audit (2026-10-30)

The site-permissions source changes affect only deployment-role dependencies.
Both deployment roles retain their environment check and the exact input predicate
from `aws_lb_listener.api_https.count`. Comparing that predicate to the old
`length(...) == 1` guard preserves the HTTPS routing requirement while removing a
resource edge. Both branches matter because Terraform retains references from the
attachment's production/Sandbox conditional even when one role has count zero.
No role attributes, trust documents, permissions or listener settings change.
The existing Sandbox OIDC lookup now supplies its exact same-account GitHub ARN,
matching the production lookup, so it needs no account-wide discovery grant.

The source/mock regressions compare both predicates with the literal listener count
predicate, reject disabled ALB, missing domain and missing certificate/hosted-zone
inputs in both environments, and retain the hosted-zone certificate path. The
native Sandbox site mock confirms exactly six managed addresses without ALB/VPC
resources. This site graph is separate from the 32-resource meeting delivery graph.
The meeting closure still has no reverse dependency on either role or the OIDC
lookup. Its closure, excluded checks, unknown handling and installed-provider
requirements are unchanged. The source pin is refreshed only for these declared
edits to `sandbox-deployment.tf` and `production-deployment.tf`.

The checked application lock and exceptional meeting model both require AWS 6.71.0;
the model also requires Terraform 1.17.1 and post-init installation evidence.
Offline mocks use their own checked locks and the CI Terraform 1.16.0 toolchain;
they do not prove native meeting-model acceptance. The exact version refusals
stay intact, and site-policy installation acceptance remains separate.

### Weekly provider audit (2026-11-02)

The application lock advances AWS 6.70.0 to 6.71.0 and refreshes signed provider
checksums. All top-level Terraform configuration files are unchanged. The
23-file source manifest is recomputed for the new lock. The DynamoDB implementation
is byte-identical across these provider versions, including the computed GSI
schema and update comparison described above. The closure, excluded checks,
allowed effects and unknown-value refusals are unchanged. Installed-provider
records and synthetic fixtures now require 6.71.0; a regression rejects 6.70.0
records, and existing tests still reject changed source and raw lock bytes.

The production bootstrap separately advances its compatible AWS lock from 6.68.0
to 6.71.0. Its IAM role, role policy, policy, S3 bucket, versioning, public-access,
encryption and bucket-policy implementations are byte-identical between those
versions. Its offline mock tests and validation use the required Terraform 1.16.0.
The sandbox bootstrap retains its intentional exact AWS 6.69.1 pin. No live plan,
Apply, policy installation or private acceptance evidence is produced by this audit.

### Sandbox site check classification (2026-11-03)

The separate `sandbox-site-permissions` validator reuses this exact committed
Terraform source pin and check-descriptor catalog. It does not reuse the meeting
closure's exclusion decision. Only thirteen checks are outside the site graph.
The policy, both deployment roles, `ENABLE_API_ALB`, and both distribution ID
inputs must pass. The attachment references both deployment roles syntactically,
so `production_deploy` remains relevant even though its Sandbox count is zero.
A passed zero-instance role descriptor may omit instances. The Sandbox role and
policy instances must match the exact resource addresses, and variable instances
must match their unkeyed descriptors.

The managed graph is exactly the policy, attachment, Sandbox role, two site
buckets, and general KMS key. Buckets depend only on their bucket-name inputs,
`name_prefix`, caller identity and provider tags. KMS settings are literal.
The policy reads those bucket/key outputs, distribution ID inputs and caller
identity. Role trust reads GitHub identity, owner/repository and environment;
its HTTPS precondition reads `ENABLE_API_ALB`, `API_DOMAIN`, `API_CERT_ARN` and
`HOSTED_ZONE_NAME` directly. The production role has the same routing predicate.
These inputs do not depend on ECS counts, cache, Grafana rotation, acceptance
fixtures, introduction policies/tasks or launcher-read inputs. The provider
tags depend only on `project_name` and `environment`.

CloudFront postconditions read the distribution inputs downstream; the policy
uses input IDs rather than distribution resources. Cache reads KMS downstream.
Acceptance, introduction and launcher policies consume other resources, with no
reverse edge into either deployment role, site bucket, key or publishing policy.
Their six resource and seven variable checks may therefore remain unknown only
after the complete source inventory, content pin and checkout commit verify.
Each unknown descriptor must match its source declaration exactly, omit instances,
and have no resource instance in the plan. Failed checks never qualify.
The unknown-check route requires the complete nineteen-descriptor source catalog,
so omitting a relevant check cannot hide its outcome.
Added files, overrides, changed source, modules or indirect dependencies require
a fresh audit and pin. Plan and restored Apply pass the invocation source commit
to this verification; the offline CLI uses its current checkout commit.

This source classification grants no native producer, bundle, saved-plan, Apply
or deployment acceptance. It does not permit replaying a failed producer.

### Artifact-preservation permission audit (2026-11-03)

The production and Sandbox deployment policies add only `ConditionCheckItem` on
MeetingHistory. These policies consume the existing table ARN; no table, DynamoDB
access policy or KMS key depends on either deployment policy. The runtime's
transcripts policy adds only `s3:GetObjectVersion` to its existing bucket/object
scope. It introduces no reference or dependency change. That policy is outside
the 32-resource closure, and none of the closure resources reads it.

The closure, excluded checks, installed provider requirements, typed retry-index
gate and permitted delivery effects are unchanged. Refreshing the source pin for
these three reviewed Terraform files does not permit either IAM change through
the restricted meeting-delivery plan scope. Installing the new permissions still
requires its own fresh protected saved plan and approved apply.

The site graph also remains unchanged. The deployment inline policies consume
the role and table outputs; neither deployment role reads its inline policy.
The transcripts policy consumes the transcripts bucket, outside the site graph,
and adds no reference. Neither change feeds the site policy, attachment, site
buckets or general KMS key. The six-resource site closure, six required passed
checks and thirteen excluded checks therefore remain exact under the updated
whole-source pin. Neither artifact permission is allowed by the site scope.

### Ephemeral storage alarm audit (2026-11-04)

Two CloudWatch alarms were added to `_infra/notifications.tf` on
`ECS/ContainerInsights` `EphemeralStorageUtilized`, scoped by cluster and service
name. The inventory stays at 25 files, because an existing file was edited rather
than a new one added, so only the content hash moved. Neither alarm is read by the
delivery closure: both take their dimensions from the ECS cluster and service and
their action from the existing critical-alerts topic, which the no-running-tasks
alarm already references in the same way. Neither declares a `validation` block or
a `lifecycle` precondition, so the plan gains no new check descriptor and
`excludedCheck` has nothing new to refuse.

### Production alarm coverage audit (2026-11-04)

The alarm coverage change adds `alerts-voice.tf` and `alb-access-logs.tf` and
edits `api.tf`, `moved.tf` and `notifications.tf`, taking the hashed inventory
from 23 files to 25. Every added resource is a CloudWatch metric filter, a
CloudWatch alarm, or part of the `ENABLE_ALB_ACCESS_LOGS` S3 log sink. The two
voice metric filters and their alarms address the app log group and the
critical-alerts topic by name through `local.app_log_group_name` and
`local.critical_alerts_topic_arn`, exactly as the processing-retry filter does,
so they take no edge on the KMS key policy. The log bucket is deliberately
SSE-S3 rather than `app_general`, because Elastic Load Balancing refuses CMK
delivery, so it does not read the key either; it reads only `name_prefix`,
`aws_region`, caller identity and `ENABLE_API_ALB`. No table, DynamoDB access
policy or KMS key depends on any of it, and the closure remains the same 32
addresses.

`ENABLE_ALB_ACCESS_LOGS` declares no `validation` block and none of the added
resources declares a `lifecycle` pre- or postcondition, so the plan gains no
check descriptor and the nine resource and ten variable excluded-check
identities are unchanged. The `moved` block retargets the unhealthy-hosts alarm
from a count instance to a `for_each` key; both addresses are outside the
closure. Installed-provider requirements and the typed retry-index gate are
unchanged. The source pin is refreshed only for these five reviewed files.

### Artifact-preservation plan scope audit (2026-11-04)

The transcripts policy now builds its bucket ARN from `local.transcripts_bucket_name`
instead of `aws_s3_bucket.transcripts.arn`. The rendered policy document is
unchanged, because `aws_s3_bucket.transcripts` sets `bucket` from that same local,
so the two expressions produce the same string. The edit removes a resource
reference edge and adds none, as the site-permissions audit did for the listener
count predicate. The local reads only `TRANSCRIPTS_BUCKET`, `name_prefix` and the
caller identity, all of which the closure already depends on.

The purpose is the new production `artifact-preservation` plan scope, which targets
only `aws_iam_policy.transcripts_s3_policy`. With the reference removed the bucket
is no longer in that targeted graph, so the GitHub Terraform executor role needs no
read permission on the transcripts bucket at all, including `s3:ListBucket`, which
would otherwise expose transcript object keys.
`validate-artifact-preservation-plan.cjs` refuses any managed resource other than
the policy, so a reappearing bucket refresh fails the scope rather than passing
quietly.

The transcripts policy stays outside the 32-resource delivery closure and outside
the six-resource site graph, and no resource in either reads it. The closure,
excluded checks, installed-provider requirements, typed retry-index gate and
permitted delivery effects are unchanged. The whole-source pin is refreshed only
for this one reviewed `main.tf` edit. Refreshing it does not permit the IAM change
through the meeting-delivery or site scopes; the new scope has its own validator,
its own bootstrap grant and its own approved apply.

That refresh was superseded by the merge with the alarm coverage change. Both
branches edited the pin over their own file set, so neither committed value
matched the merged tree. The pin here is recomputed over the merged inventory:
master's 25 files with this audit's `main.tf` edit applied, which is the only
hashed file that differs from master. The method was validated by reproducing
both parents' committed values from their own trees before the new one was
trusted.

### Announcement delivery table audit (2026-11-04)

The operator-announcement change adds `aws_dynamodb_table.announcement_delivery_table`
in `config.tf` and the boolean `enable_announcement_delivery_table` in `main.tf`,
default `false`, with no validation block. The table is counted by that variable
and has no lifecycle check. It reads `local.name_prefix` and the general KMS key
ARN. No closure table, DynamoDB access policy, KMS key or KMS key policy reads
the new table or the variable, and neither appears in `tables` or `excludedChecks`.

With the flag off the table has no instances. The change adds no check identity
and no planned change, so the meeting closure, the site graph, the excluded
checks, the typed retry-index gate and the installed-provider requirements are
unchanged. The source pin was refreshed only for these two declared edits.

That refresh was superseded by the merge with master's weekly provider audit
(the AWS lock from 6.70.0 to 6.71.0), the ephemeral storage alarm, the alarm
coverage and the artifact-preservation plan scope changes. The pin is recomputed over the merged
inventory: master's 25 files with this audit's `config.tf` and `main.tf` edits
applied, the only hashed files that differ from master. Both parents' committed
values were reproduced from their own trees before the new one was trusted. A
later wording fix to the enablement comment in `config.tf` and the variable
description in `main.tf` moved the pin again, by the same method.

Enabling the flag is a separate reviewed change. The production bootstrap
Terraform role's inline policy allows `dynamodb:CreateTable` only on the
deployment control table, and the DynamoDB KMS encryption context only for the
control and subscription table names. Of its attached policies, only
processing-retry adds that context, for MeetingHistory alone; the site-delivery
policy grants only CloudFront actions, and the artifact-preservation and
alerting-delivery policies grant no DynamoDB or KMS action. The Sandbox role
allows neither. Both roles first need `dynamodb:CreateTable`,
`UpdateContinuousBackups` and `TagResource`/`UntagResource` on this table's ARN,
plus the DynamoDB KMS encryption context for its name. Sandbox also needs the
table in the bootstrap `table_suffixes`, so its `TableMetadata` read grant
covers it; production's `TableMetadata` already covers every
`meeting-notes-prod-*` table. This audit permits no plan, Apply or deployment.

### Recomputing the pin

There is no script for this. The pin is `bindingHash` over a map of filename to
SHA-256 of each file's bytes with CRLF normalized to LF, over exactly the
`isSource` inventory of the committed `_infra` tree at the checkout's HEAD.
Reproduce the outgoing value from the parent commit's tree first; a method that
cannot reproduce the committed pin is wrong, and a pin nobody can derive twice
is not a guard. `test/scripts/terraformMeetingNative.test.js` is the check that
matters, because `copyModelSource` runs `verifySource` against the real
committed `_infra`: it fails on a stale pin and passes on a correct one.

**This pin covers every top-level Terraform source file, so two concurrent
branches that each add or edit one will each invalidate the other's refresh.**
Each branch's pin is computed over its own file set, both are individually
correct, and whichever merges second lands a pin that does not match the merged
tree. The second merge must recompute; do not try to precompute a value valid
for both, since neither tree exists yet.

### Future source changes

Any top-level Terraform or lock edit requires reviewing and updating the source
contract before this exceptional native shape can pass. That deliberate refusal
is preferable to inferring transitive safety from incomplete configuration JSON.
The strict path still accepts plans whose effects are completely known without
using the exception. Public fixtures are constructed from the existing synthetic
provider fixture and source addresses; they contain no private saved plan data.
