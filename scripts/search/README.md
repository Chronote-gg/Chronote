# Search resource configuration and recovery

No command here grants deployment authority. Terraform still uses its existing private saved-plan bundle, digest, source checks and native environment approval. `meeting-search` is a Sandbox-only scope; production remains excluded.

## Local validation

```powershell
node scripts/search/build-projection.mjs
yarn jest test/scripts/configureS3Search.test.ts test/scripts/terraformSearchPlan.test.js test/scripts/searchPlanSession.test.js test/scripts/terraformBundle.test.js test/scripts/terraformApplySource.test.js test/scripts/terraformDispatch.test.js test/scripts/terraformWorkflow.test.js --runInBand --coverage=false
terraform -chdir=_infra fmt -check
terraform -chdir=_infra validate
```

On Windows the dispatch guard tests require Git Bash on `PATH`, rather than the WSL launcher without an installed distribution.

## Sandbox deployment prerequisites

All switches default off. Before requesting a Plan, install and read back the default-off Sandbox search permission policies through the [separate bootstrap verifier](../../_infra/sandbox-bootstrap/README.md#optional-search-provisioning-permission-installation). Their metadata and KMS-context allowlists include only the new `MeetingSearchState` table, named search resources and required existing dependency metadata. The source includes these reviewable grants; it does not install or apply them.

Use environment Actions variables `TFVAR_ENABLE_MEETING_SEARCH=true`, `TFVAR_SEARCH_GENERATION=g1`, and initially leave `TFVAR_ENABLE_SEARCH_PROJECTION`, `TFVAR_SEARCH_ENABLED` and `TFVAR_ASK_AGENT_ENABLED` false. Run the existing Terraform Plan workflow with environment/workspace `sandbox` and scope `meeting-search`; approve and apply its exact private saved plan through the existing Apply workflow. Review derived data costs before enabling projection.

```powershell
gh workflow run terraform-plan.yml --ref <reviewed-ref> -f github_environment=sandbox -f terraform_workspace=sandbox -f plan_scope=meeting-search
```

The actual locked AWS provider schema (6.71.0) was inspected with `terraform providers schema -json`. It supports native vector buckets/indexes and non-filterable metadata, but omits index mode and text-search configuration. Terraform therefore owns both indexes, while the pinned official `@aws-sdk/client-s3vectors` 3.1170.0 configuration step owns only those two missing fields. No `local-exec` or custom HTTP transport is used.

After approved provisioning, substitute the two exact ARNs from `search_index_arns`:

```powershell
# Read-only drift check. Expected to fail before the first text configuration.
yarn ts-node scripts/search/configure-s3-search.ts <meeting-index-arn> <transcript-index-arn>
# Separately authorized configuration write, never a Terraform approval substitute.
yarn ts-node scripts/search/configure-s3-search.ts --apply <meeting-index-arn> <transcript-index-arn>
```

The command reads before writing, refuses incompatible immutable settings or unexpected text fields, patches only missing ENHANCED/text configuration and waits at most two minutes per index for `search_text` ACTIVE. Subsequent invocations without `--apply` detect drift and never write. The configuration role needs only GetIndex, UpdateIndexMode and UpdateMetadataConfiguration on the two exact index ARNs. Serving has query/read rights; the projection role has vector writes but no index-configuration permissions.

Publish the updated privacy policy and What's New notice before the first new indexing or embedding processing. Then review a second saved Plan with `TFVAR_ENABLE_SEARCH_PROJECTION=true`. The Plan workflow bundles the Lambda, and the saved-plan digest includes `search_projection.zip`. The stream uses partial-batch responses, bounded retries, a failure queue retained for fourteen days and a five-minute reconciliation schedule. Reconciliation scans canonical source keys and durable intents with persisted checkpoints, so recovery is not limited to the stream's retention. Each invocation handles bounded pages, rather than promising an entire backfill in one invocation.

After authorization, a manual reconciliation page uses the same handler:

```powershell
aws lambda invoke --function-name <projection-function> --payload '{}' --cli-binary-format raw-in-base64-out <receipt.json>
```

Keep serving flags off until full source/state scans, oldest-history retrieval, deletion recovery, denied-access cases, embedding failures and real provider query acceptance pass. Enabling serving requires a separately reviewed runtime task-definition update and backend deployment; the search provisioning scope deliberately excludes the ECS runtime. A configured resource or a successful invoke does not prove backfill or user acceptance.

## Rollback and generations

Disable `SEARCH_ENABLED` and `ASK_AGENT_ENABLED` through the approved runtime configuration/deploy route. Preserve canonical recordings, conversations, search-state intents and indexes. Do not disable `ENABLE_MEETING_SEARCH` to stop serving: storage uses `prevent_destroy` and refuses that destructive plan. `SEARCH_RETAINED_GENERATIONS` retains `g1` by default; retain every prior generation there when selecting a new `SEARCH_GENERATION`, configure/backfill it, then validate before switching serving. Explicit deletion of obsolete generations requires its own reviewed change.
