import { privateCaptureFixture } from "./privateCapture.js";

export function artifactIamFixture(environment = "sandbox") {
  const accountId = "123456789012";
  const region = "us-east-1";
  const prefix =
    environment === "sandbox" ? "meeting-notes-sandbox" : "meeting-notes-prod";
  const storage = privateCaptureFixture().binding;
  const role = `${prefix}-github-deploy`;
  const transcriptsBucket = `${prefix}-transcripts-${accountId}`;
  const deployAddress = `aws_iam_role_policy.${environment === "sandbox" ? "sandbox" : "production"}_deploy[0]`;
  const policyArn = `arn:aws:iam::${accountId}:policy/${prefix}-bot-transcripts-s3-policy`;
  const invocation = {
    environment,
    workspace: environment === "sandbox" ? "sandbox" : "default",
  };
  const variables = {
    AWS_ACCOUNT_ID: accountId,
    AWS_REGION: region,
    ARTIFACT_APP_KMS_KEY_ARN: storage.kmsKeyArn,
    [`${environment === "sandbox" ? "SANDBOX" : "PRODUCTION"}_BACKEND_DEPLOY_ROLE_ARN`]: `arn:aws:iam::${accountId}:role/${role}`,
  };
  const tfvars = {
    project_name: "meeting-notes",
    environment: environment === "sandbox" ? "sandbox" : "prod",
    aws_region: region,
    github_environment: environment,
    ENABLE_API_ALB: true,
  };
  const resource = (address, after, action = "no-op", before = after) => ({
    address,
    mode: "managed",
    change: {
      actions: [action],
      before: structuredClone(before),
      after: structuredClone(after),
      after_unknown: {},
    },
  });
  const bucketArn = `arn:aws:s3:::${transcriptsBucket}`;
  const transcriptBefore = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:AbortMultipartUpload",
          "s3:ListBucket",
        ],
        Resource: [bucketArn, `${bucketArn}/*`],
      },
    ],
  };
  const transcriptAfter = structuredClone(transcriptBefore);
  transcriptAfter.Statement[0].Action.push("s3:GetObjectVersion");
  const deployBefore = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "Existing",
        Effect: "Allow",
        Action: ["ecs:DescribeTasks"],
        Resource: `arn:aws:ecs:${region}:${accountId}:task/${prefix}-bot-cluster/*`,
      },
    ],
  };
  const deployAfter = structuredClone(deployBefore);
  deployAfter.Statement.push({
    Sid: "ArtifactAuthorityChecks",
    Effect: "Allow",
    Action: ["dynamodb:ConditionCheckItem"],
    Resource: `arn:aws:dynamodb:${region}:${accountId}:table/${prefix}-MeetingHistoryTable`,
  });
  const policyState = {
    name: `${prefix}-bot-transcripts-s3-policy`,
    arn: policyArn,
    id: policyArn,
    path: "/",
    tags: {},
    policy: JSON.stringify(transcriptAfter),
  };
  const deployState = {
    name: `${prefix}-backend-deploy`,
    role,
    id: `${role}:${prefix}-backend-deploy`,
    policy: JSON.stringify(deployAfter),
  };
  const plan = {
    format_version: "1.2",
    terraform_version: "1.17.1",
    errored: false,
    resource_drift: [],
    checks: [],
    variables: Object.fromEntries(
      Object.entries({ ...tfvars, TRANSCRIPTS_BUCKET: "" }).map(
        ([key, value]) => [key, { value }],
      ),
    ),
    resource_changes: [
      resource("aws_iam_policy.transcripts_s3_policy", policyState, "update", {
        ...policyState,
        policy: JSON.stringify(transcriptBefore),
      }),
      resource(deployAddress, deployState, "update", {
        ...deployState,
        policy: JSON.stringify(deployBefore),
      }),
      resource("aws_s3_bucket.transcripts", {
        bucket: transcriptsBucket,
        arn: bucketArn,
      }),
      resource("aws_kms_key.app_general", { arn: storage.kmsKeyArn }),
      ...["app", "exec"].map((kind) =>
        resource(
          `aws_iam_role.ecs_task_${kind === "app" ? "app" : "execution"}_role`,
          {
            name: `${prefix}-ecs-task-${kind}-role`,
            arn: `arn:aws:iam::${accountId}:role/${prefix}-ecs-task-${kind}-role`,
          },
        ),
      ),
      resource(
        `aws_iam_role.${environment === "sandbox" ? "sandbox" : "production"}_deploy[0]`,
        {
          name: role,
          arn: variables[
            `${environment === "sandbox" ? "SANDBOX" : "PRODUCTION"}_BACKEND_DEPLOY_ROLE_ARN`
          ],
        },
      ),
      resource("aws_dynamodb_table.meeting_history_table", {
        name: `${prefix}-MeetingHistoryTable`,
        arn: `arn:aws:dynamodb:${region}:${accountId}:table/${prefix}-MeetingHistoryTable`,
      }),
      ...[
        "ecs_task_transcripts_policy",
        "ecs_task_exec_transcripts_policy",
      ].map((name, i) =>
        resource(`aws_iam_role_policy_attachment.${name}`, {
          role: `${prefix}-ecs-task-${i ? "exec" : "app"}-role`,
          policy_arn: policyArn,
        }),
      ),
      resource(
        "aws_s3_bucket_server_side_encryption_configuration.transcripts",
        {
          bucket: transcriptsBucket,
          rule: [
            {
              apply_server_side_encryption_by_default: [
                {
                  sse_algorithm: "aws:kms",
                  kms_master_key_id: storage.kmsKeyArn,
                },
              ],
            },
          ],
        },
      ),
      resource("aws_s3_bucket_versioning.transcripts", {
        bucket: transcriptsBucket,
        versioning_configuration: [{ status: "Enabled" }],
      }),
    ],
  };
  return {
    invocation,
    storage,
    variables,
    tfvars,
    plan,
    deployAddress,
    resource,
  };
}
