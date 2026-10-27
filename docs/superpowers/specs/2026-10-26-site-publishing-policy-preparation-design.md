# Site publishing policy preparation

## Outcome and scope

Prepare the narrow IAM policy needed before site publishing can move from static credentials to the existing deployment roles. This source-only slice adds no role, changes no workflow and grants no live permission. Existing publishing keeps its current behavior until a later reviewed migration and installation.

BASIC asked to continue activation preparation after merging PR453 and to defer cleanup. The implementation choice below is the controller's call within that preparation scope, not a claim that BASIC approved infrastructure installation.

## Approach and tradeoff

Use one site-specific managed policy per production or Sandbox Terraform environment, attached only to that environment's existing backend deployment role. Keep the seven-role A inventory and all current backend inline policies unchanged. Every future session of an attached role gains these site capabilities after Apply; the grant is not limited to one publishing job.

Appending inline statements would mix the site boundary into backend permissions and consume the role's shared inline-policy budget. Dedicated site roles would isolate principals but require a larger identity-inventory change. Both alternatives are deferred. The managed policy keeps this slice independently reviewable and fits the [managed-policy size limit](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html).

## Exact permission boundary

Create `_infra/site-publishing.tf` with `aws_iam_policy.site_publishing` and `aws_iam_role_policy_attachment.site_publishing`. Create them only for `prod` and `sandbox`; select the existing `production_deploy` or `sandbox_deploy` role. Use existing Terraform resource references, not new target inputs.

| Purpose                                            | Actions                                                      | Resources and restrictions                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Bucket inventory and docs preflight                | `s3:ListBucket`                                              | Only frontend and docs bucket ARNs                                                                                |
| Upload, sync deletion and failed multipart cleanup | `s3:PutObject`, `s3:DeleteObject`, `s3:AbortMultipartUpload` | Only objects beneath those two buckets                                                                            |
| Publish invalidation                               | `cloudfront:CreateInvalidation`                              | Only frontend and docs distribution ARNs                                                                          |
| Existing docs preflight and waiter                 | `cloudfront:GetDistribution`, `cloudfront:GetInvalidation`   | Only the docs distribution ARN                                                                                    |
| SSE-KMS upload and multipart completion            | `kms:GenerateDataKey`, `kms:Decrypt`                         | Only `app_general`; exact caller account, regional S3 service and the two site object encryption-context prefixes |

The current uploads are local files to S3. Do not add object-body reads, ACLs, version deletion, bucket configuration, distribution configuration, wildcard actions or unrelated storage access. Both site buckets currently disable S3 Bucket Keys; do not widen encryption context to bucket roots for hypothetical future support.

The [S3 API permission mapping](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html) binds listing, upload, deletion and multipart cleanup to their specific actions. [Multipart SSE-KMS](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html) requires the two key operations. [CloudFront authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudfront.html) supports the named distribution resources.

## Proof and limits

Use backend-free Terraform plans with all providers mocked. Assert exact actions, resources, attachment identity, KMS conditions and managed-policy size. Exercise production and Sandbox with distinct realistic fixture ARNs, plus no policy outside the two environments. The exact allowlists must exclude foreign sites, recording storage, cross-environment resources and direct or wrong-service KMS use.

Preserve role trust, existing policies, bucket/key/distribution configuration, dependency locks and all workflows byte for byte. No provider account call, Terraform state access, Apply, workflow dispatch, real recording, paid generation or credential change is authorized.

A remains unsupported for activation: site jobs still use static credentials. Merged Sandbox preparation replaces its static Plan/Apply route with restricted OIDC source for `meeting-update-delivery`; installation, effective access and hosted acceptance remain unproved. General Sandbox Apply remains unsupported, and Production Plan retains its static credential route. Future credential migration must also address the tfvars renderer copying temporary AWS key IDs into managed configuration. These separate identity and workflow changes do not belong in this policy slice.

The managed policy must remain within 6,144 non-whitespace characters. Actual attachment, key/bucket policies, effective permissions, policy-count quotas and publishing success require separate private plans, approval and acceptance. The two new resources are outside the existing four-target prerequisite exception; do not extend that exception or the bootstrap module to install them. This policy does not prove admission closure, production availability, notes quality, latency or cost neutrality.
