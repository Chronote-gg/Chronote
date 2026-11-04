import dependencyNames from "./artifactIamDependencyNames.json";
import { artifactIamClosure } from "../../../scripts/deployment/artifact-iam-model.cjs";
import { excludedChecks } from "../../../scripts/deployment/terraform-meeting-model.cjs";
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
    repository: "Chronote-gg/Chronote",
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
    github_owner: "Chronote-gg",
    github_repository: "Chronote",
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
    checks: [
      `aws_iam_role.${environment === "sandbox" ? "sandbox" : "production"}_deploy`,
      "var.ENABLE_API_ALB",
    ].map((name) => ({
      address: JSON.parse(
        JSON.stringify(excludedChecks.find((c) => c.to_display === name)),
      ),
      status: "pass",
      instances: [
        {
          address: {
            to_display: name.startsWith("var.") ? name : `${name}[0]`,
            ...(name.startsWith("var.") ? {} : { instance_key: 0 }),
          },
          status: "pass",
        },
      ],
    })),
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

export function completeArtifactIamFixture(environment = "sandbox") {
  const f = artifactIamFixture(environment),
    account = "123456789012",
    region = "us-east-1";
  const prefix = `meeting-notes-${environment === "sandbox" ? "sandbox" : "prod"}`;
  const known = new Set(f.plan.resource_changes.map((r) => r.address));
  for (const address of artifactIamClosure(environment)) {
    if (known.has(address)) continue;
    let after;
    if (address.startsWith("aws_dynamodb_table.")) {
      const name = `${prefix}-${dependencyNames[address.split(".")[1]]}`;
      after = {
        name,
        arn: `arn:aws:dynamodb:${region}:${account}:table/${name}`,
        region,
      };
    } else if (address.startsWith("aws_secretsmanager_secret.")) {
      const name = `${prefix}/${address.split(".")[1].replaceAll("_", "-")}`;
      after = {
        name,
        arn: `arn:aws:secretsmanager:${region}:${account}:secret:${name}-aB12cD`,
        region,
      };
    } else if (address === "aws_ecs_cluster.main") {
      after = {
        name: `${prefix}-bot-cluster`,
        arn: `arn:aws:ecs:${region}:${account}:cluster/${prefix}-bot-cluster`,
        region,
      };
    } else if (address === "aws_ecr_repository.app_ecr_repo") {
      after = {
        name: `${prefix}-bot-repo`,
        arn: `arn:aws:ecr:${region}:${account}:repository/${prefix}-bot-repo`,
        registry_id: account,
        region,
      };
    } else if (address === "aws_iam_policy.dynamodb_access_policy") {
      after = {
        name: `${prefix}-bot-dynamodb-policy`,
        arn: `arn:aws:iam::${account}:policy/${prefix}-bot-dynamodb-policy`,
      };
    } else throw new Error(`Missing fixture identity: ${address}`);
    f.plan.resource_changes.push({
      address,
      mode: "managed",
      change: {
        actions: ["no-op"],
        before: structuredClone(after),
        after: structuredClone(after),
        after_unknown: {},
      },
    });
  }
  const deploy =
    environment === "sandbox" ? "github_deploy" : "github_production_deploy";
  const org =
    environment === "sandbox"
      ? "deployment_owner"
      : "production_deployment_owner";
  for (const [address, after] of [
    [
      "data.aws_caller_identity.current",
      {
        account_id: account,
        arn: `arn:aws:sts::${account}:assumed-role/${prefix}-github-terraform/run`,
      },
    ],
    [
      `data.aws_iam_openid_connect_provider.${deploy}[0]`,
      {
        arn: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`,
        url: "token.actions.githubusercontent.com",
        client_id_list: ["sts.amazonaws.com"],
      },
    ],
    [
      "data.github_repository.repo",
      { full_name: "Chronote-gg/Chronote", name: "Chronote", repo_id: 123456 },
    ],
    [
      `data.github_organization.${org}[0]`,
      { name: "Chronote-gg", id: "654321" },
    ],
  ])
    f.plan.resource_changes.push({
      address,
      mode: "data",
      change: { actions: ["read"], before: null, after, after_unknown: {} },
    });
  return f;
}
