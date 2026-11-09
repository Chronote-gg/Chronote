import { excludedChecks } from "../../../scripts/deployment/terraform-meeting-model.cjs";
import { artifactPreservationPlan } from "./artifactPreservationPlan.js";
export const artifactPolicy = "aws_iam_policy.sandbox_artifact_authority[0]";
export const artifactAttachment =
  "aws_iam_role_policy_attachment.sandbox_artifact_authority[0]";
export const artifactRole = "aws_iam_role.sandbox_deploy[0]";
export const artifactBinding = {
  environment: "sandbox",
  accountId: "123456789012",
  region: "us-east-1",
};
export const artifactArn =
  "arn:aws:iam::123456789012:policy/meeting-notes-sandbox-artifact-authority";
export function sandboxArtifactPlan() {
  const plan = JSON.parse(
    JSON.stringify(artifactPreservationPlan()).replaceAll(
      "meeting-notes-prod",
      "meeting-notes-sandbox",
    ),
  );
  plan.resource_changes.pop();
  for (const state of [
    plan.resource_changes[0].change.before,
    plan.resource_changes[0].change.after,
  ])
    Object.assign(state, {
      arn: "arn:aws:iam::123456789012:policy/meeting-notes-sandbox-bot-transcripts-s3-policy",
      id: "arn:aws:iam::123456789012:policy/meeting-notes-sandbox-bot-transcripts-s3-policy",
      description:
        "Allow ECS tasks to upload and read transcripts in the transcripts bucket",
      attachment_count: 2,
      policy_id: "ANPASYNTHETIC",
      tags: {},
      tags_all: {
        Project: "meeting-notes",
        Environment: "sandbox",
        ManagedBy: "terraform",
        Service: "chronote",
      },
    });
  const resource = (address, after, unknown = {}) => ({
    address,
    mode: "managed",
    change: {
      actions: ["create"],
      before: null,
      after,
      after_unknown: unknown,
    },
  });
  plan.resource_changes.push(
    resource(
      artifactPolicy,
      {
        name: "meeting-notes-sandbox-artifact-authority",
        path: "/",
        tags: {},
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "ArtifactAuthorityChecks",
              Effect: "Allow",
              Action: ["dynamodb:ConditionCheckItem"],
              Resource:
                "arn:aws:dynamodb:us-east-1:123456789012:table/meeting-notes-sandbox-MeetingHistoryTable",
            },
          ],
        }),
      },
      Object.fromEntries(
        [
          "arn",
          "id",
          "attachment_count",
          "name_prefix",
          "policy_id",
          "tags_all",
        ].map((key) => [key, true]),
      ),
    ),
  );
  plan.resource_changes.push(
    resource(
      artifactAttachment,
      { role: "meeting-notes-sandbox-github-deploy" },
      { id: true, policy_arn: true },
    ),
  );
  const role = resource(artifactRole, {
    name: "meeting-notes-sandbox-github-deploy",
    arn: "arn:aws:iam::123456789012:role/meeting-notes-sandbox-github-deploy",
    path: "/",
    max_session_duration: 10800,
    inline_policy: [],
    permissions_boundary: null,
    assume_role_policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "ChronoteSandboxGitHubOIDC",
          Effect: "Allow",
          Action: "sts:AssumeRoleWithWebIdentity",
          Principal: {
            Federated:
              "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
          },
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub":
                "repo:Chronote-gg/Chronote:environment:sandbox",
              "token.actions.githubusercontent.com:repository_id": "12345",
              "token.actions.githubusercontent.com:repository_owner_id":
                "67890",
            },
            StringLike: {
              "token.actions.githubusercontent.com:ref": [
                "refs/heads/master",
                "refs/heads/codex/*",
              ],
            },
          },
        },
      ],
    }),
  });
  role.change.actions = ["no-op"];
  role.change.before = JSON.parse(JSON.stringify(role.change.after));
  plan.resource_changes.push(role);
  Object.assign(plan, {
    format_version: "1.2",
    terraform_version: "1.17.1",
    applyable: true,
    complete: false,
    errored: false,
    variables: Object.fromEntries(
      Object.entries({
        environment: "sandbox",
        project_name: "meeting-notes",
        aws_region: "us-east-1",
      }).map(([key, value]) => [key, { value }]),
    ),
    configuration: {
      root_module: {
        resources: [
          {
            address: artifactAttachment.replace("[0]", ""),
            expressions: {
              policy_arn: {
                references: [
                  artifactPolicy + ".arn",
                  artifactPolicy,
                  artifactPolicy.replace("[0]", ""),
                ],
              },
            },
          },
        ],
      },
    },
    checks: excludedChecks.map((address) =>
      address.to_display === "aws_iam_role.sandbox_deploy"
        ? {
            address,
            status: "pass",
            instances: [
              {
                address: { to_display: artifactRole, instance_key: 0 },
                status: "pass",
              },
            ],
          }
        : { address, status: "unknown" },
    ),
  });
  return plan;
}
