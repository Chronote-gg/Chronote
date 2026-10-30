import { privateCaptureFixture } from "./privateCapture.js";
import sitePolicyFixture from "./sandboxSitePolicy.json";
export const policyAddress = "aws_iam_policy.site_publishing[0]";
export const attachmentAddress =
  "aws_iam_role_policy_attachment.site_publishing[0]";
export const roleAddress = "aws_iam_role.sandbox_deploy[0]";
export const policyName = "meeting-notes-sandbox-site-publishing";
export const roleName = "meeting-notes-sandbox-github-deploy";
export const policyArn = `arn:aws:iam::123456789012:policy/${policyName}`;
export function siteVariables() {
  return {
    AWS_ACCOUNT_ID: "123456789012",
    AWS_REGION: "us-east-1",
    SANDBOX_BACKEND_DEPLOY_ROLE_ARN: `arn:aws:iam::123456789012:role/${roleName}`,
    FRONTEND_BUCKET: "synthetic-sandbox-frontend",
    DOCS_BUCKET: "synthetic-sandbox-docs",
    FRONTEND_DISTRIBUTION_ID: "ESYNTHETICFRONTEND",
    DOCS_DISTRIBUTION_ID: "ESYNTHETICDOCS",
    TFVAR_frontend_distribution_id: "ESYNTHETICFRONTEND",
    TFVAR_docs_distribution_id: "ESYNTHETICDOCS",
  };
}
export function permissionBinding() {
  const vars = siteVariables();
  return {
    environment: "sandbox",
    accountId: vars.AWS_ACCOUNT_ID,
    region: vars.AWS_REGION,
    kmsKeyArn: privateCaptureFixture().binding.kmsKeyArn,
    frontendBucket: vars.FRONTEND_BUCKET,
    docsBucket: vars.DOCS_BUCKET,
    frontendDistributionId: vars.FRONTEND_DISTRIBUTION_ID,
    docsDistributionId: vars.DOCS_DISTRIBUTION_ID,
    deploymentRoleArn: vars.SANDBOX_BACKEND_DEPLOY_ROLE_ARN,
  };
}
export function sitePolicy() {
  return structuredClone(sitePolicyFixture);
}
const resource = (address, after, action = "no-op") => ({
  address,
  mode: "managed",
  change: {
    actions: [action],
    before: action === "create" ? null : JSON.parse(JSON.stringify(after)),
    after,
    after_unknown: {},
  },
});
export function sitePermissionsPlan(action = "create") {
  const b = permissionBinding();
  const policy = resource(
    policyAddress,
    {
      name: policyName,
      name_prefix: null,
      path: "/",
      description: "",
      tags: {},
      tags_all: {
        Project: "meeting-notes",
        Environment: "sandbox",
        ManagedBy: "terraform",
        Service: "chronote",
      },
      policy: JSON.stringify(sitePolicy()),
      arn: policyArn,
      id: policyArn,
      attachment_count: 0,
      policy_id: "ANPASYNTHETIC",
    },
    action,
  );
  const attachment = resource(
    attachmentAddress,
    { role: roleName, policy_arn: policyArn, id: "synthetic-attachment" },
    action === "update" ? "no-op" : action,
  );
  if (action === "create") {
    for (const key of [
      "arn",
      "id",
      "attachment_count",
      "policy_id",
      "name_prefix",
    ]) {
      if (key !== "name_prefix") delete policy.change.after[key];
      policy.change.after_unknown[key] = true;
    }
    delete attachment.change.after.id;
    attachment.change.after_unknown.id = true;
    delete attachment.change.after.policy_arn;
    attachment.change.after_unknown.policy_arn = true;
  }
  if (action === "update") policy.change.before.policy = "{}";
  return {
    format_version: "1.2",
    errored: false,
    checks: [],
    resource_drift: [],
    resource_changes: [
      resource("aws_s3_bucket.frontend", {
        bucket: b.frontendBucket,
        arn: `arn:aws:s3:::${b.frontendBucket}`,
      }),
      resource("aws_s3_bucket.docs", {
        bucket: b.docsBucket,
        arn: `arn:aws:s3:::${b.docsBucket}`,
      }),
      resource("aws_kms_key.app_general", { arn: b.kmsKeyArn }),
      resource(roleAddress, { name: roleName, arn: b.deploymentRoleArn }),
      policy,
      attachment,
    ],
    configuration: {
      root_module: {
        resources: [
          {
            address: attachmentAddress.replace("[0]", ""),
            expressions: {
              policy_arn: {
                references: [
                  "aws_iam_policy.site_publishing[0].arn",
                  policyAddress,
                  "aws_iam_policy.site_publishing",
                ],
              },
            },
          },
        ],
      },
    },
    variables: {
      environment: { value: "sandbox" },
      project_name: { value: "meeting-notes" },
      aws_region: { value: b.region },
      frontend_distribution_id: { value: b.frontendDistributionId },
      docs_distribution_id: { value: b.docsDistributionId },
    },
  };
}
