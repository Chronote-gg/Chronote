# Sandbox delivery plan source model

The delivery guard may classify aggregate unknown checks and computed GSI warm
throughput only for the audited Sandbox model below. The permitted effects remain
the two delivery attributes, `UpdateDeliveryDueIndex`, and the exact MeetingHistory
`DescribeTable` addition, or their completed no-op state. A failed check is never
an excluded check. This model does not authorize a plan, Apply or deployment.

## Source and installation boundary

`terraform-meeting-model.cjs` pins the filenames and SHA-256 content digests of all
23 top-level `_infra/*.tf`, `*.tf.json` and `.terraform.lock.hcl` files through
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
record must identify Terraform 1.17.1 and installed AWS 6.69.1. The checked lock
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

## Computed GSI representation

In [AWS provider v6.69.1 table.go](https://github.com/hashicorp/terraform-provider-aws/blob/v6.69.1/internal/service/dynamodb/table.go#L607-L629),
`warmThroughputSchema` is both optional and computed, as are its read/write unit
fields. The GSI schema uses it too. It is writable when configured, so a computed
mask by itself cannot justify ignoring it.
The same version's [GSI update comparison](https://github.com/hashicorp/terraform-provider-aws/blob/v6.69.1/internal/service/dynamodb/table.go#L2104-L2121)
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

Any top-level Terraform or lock edit requires reviewing and updating the source
contract before this exceptional native shape can pass. That deliberate refusal
is preferable to inferring transitive safety from incomplete configuration JSON.
The strict path still accepts plans whose effects are completely known without
using the exception. Public fixtures are constructed from the existing synthetic
provider fixture and source addresses; they contain no private saved plan data.
