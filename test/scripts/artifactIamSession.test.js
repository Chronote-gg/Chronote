/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect, jest } from "@jest/globals";
import { artifactIamFixture } from "../fixtures/deployment/artifactIamPlan.js";
import { artifactIamBinding } from "../../scripts/deployment/validate-artifact-iam-plan.cjs";
import {
  prepareArtifactIamSession,
  assertArtifactIamVersionCapacity,
} from "../../scripts/deployment/artifact-iam-session.cjs";
const mockGuardState = { caller: null, send: null };
jest.mock("../../scripts/deployment/coordinator-aws.cjs", () => ({
  awsCli: async () => mockGuardState.caller,
}));
jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: class {
      async send(command) {
        return mockGuardState.send(command.input);
      }
    },
  };
});
import { runGuard } from "../../scripts/deployment/production-writer-guard.cjs";
import { unmarshall } from "@aws-sdk/util-dynamodb";
const context = (environment = "sandbox") => {
  const f = artifactIamFixture(environment);
  f.invocation.scope = "artifact-preservation-iam";
  f.variables.TERRAFORM_AWS_ROLE_ARN = `arn:aws:iam::123456789012:role/${environment === "sandbox" ? "meeting-notes-sandbox" : "meeting-notes-prod"}-github-terraform`;
  f.variables.DEPLOYMENT_CONTROL_TABLE = `meeting-notes-${environment === "sandbox" ? "sandbox" : "prod"}-DeploymentControlTable`;
  f.variables.PRODUCTION_APPLY_ROLE_ARN =
    "arn:aws:iam::123456789012:role/reviewed-apply";
  return { ...f, binding: artifactIamBinding(f) };
};
test.each(["sandbox", "production"])(
  "%s sessions have exact writes and no pruning",
  (environment) => {
    const f = context(environment);
    for (const phase of ["plan", "apply"]) {
      const result = prepareArtifactIamSession({ ...f, phase });
      expect(Buffer.byteLength(result.policy)).toBeLessThanOrEqual(2048);
      const statements = JSON.parse(result.policy).Statement;
      const iamWrites = statements.filter((s) =>
        []
          .concat(s.Action)
          .some((a) => /^iam:(Create|Put|Delete|Attach|Update|Set)/.test(a)),
      );
      expect(iamWrites).toEqual(
        phase === "plan"
          ? []
          : [
              {
                Effect: "Allow",
                Action: "iam:CreatePolicyVersion",
                Resource: `arn:aws:iam::123456789012:policy/${f.binding.prefix}-bot-transcripts-s3-policy`,
              },
              {
                Effect: "Allow",
                Action: "iam:PutRolePolicy",
                Resource: f.binding.deploymentRoleArn,
              },
            ],
      );
      expect(result.policy).not.toMatch(
        /DeletePolicyVersion|AttachRolePolicy|CreateRole|UpdateAssumeRolePolicy|secretsmanager:GetSecretValue/,
      );
      expect(result.principalArn).toBe(
        environment === "production" && phase === "apply"
          ? f.variables.PRODUCTION_APPLY_ROLE_ARN
          : f.variables.TERRAFORM_AWS_ROLE_ARN,
      );
    }
  },
);
test.each(["scope", "workspace", "account", "role", "phase"])(
  "session refuses changed %s",
  (fault) => {
    const f = context();
    f.phase = "apply";
    if (fault === "scope") f.invocation.scope = "full";
    if (fault === "workspace") f.invocation.workspace = "default";
    if (fault === "account") f.binding.accountId = "000000000000";
    if (fault === "role") f.variables.TERRAFORM_AWS_ROLE_ARN += "-other";
    if (fault === "phase") f.phase = "other";
    expect(() => prepareArtifactIamSession(f)).toThrow();
  },
);
test.each([0, 4, 5, 6, "malformed"])(
  "capacity validates %s versions without delete",
  async (count) => {
    const f = context();
    const aws = jest.fn(async () =>
      count === "malformed"
        ? {}
        : {
            Versions: Array.from({ length: count }, (_, i) => ({
              VersionId: `v${i + 1}`,
              IsDefaultVersion: i === 0,
            })),
          },
    );
    const run = () =>
      assertArtifactIamVersionCapacity({
        aws,
        binding: f.binding,
        changes: [
          { address: "aws_iam_policy.transcripts_s3_policy", action: "update" },
        ],
      });
    if (count === 4)
      await expect(run()).resolves.toMatchObject({
        kind: "artifact-iam-version-capacity-v1",
        count: 4,
      });
    else await expect(run()).rejects.toThrow(/HOLD/);
    expect(aws.mock.calls).toHaveLength(1);
    expect(aws.mock.calls[0].slice(0, 3)).toEqual([
      "iam",
      "list-policy-versions",
      {
        PolicyArn: `arn:aws:iam::123456789012:policy/${f.binding.prefix}-bot-transcripts-s3-policy`,
      },
    ]);
  },
);
test("installed policy no-op needs no version capacity", async () => {
  const aws = jest.fn();
  await expect(
    assertArtifactIamVersionCapacity({
      aws,
      binding: context().binding,
      changes: [],
    }),
  ).resolves.toMatchObject({ needed: false });
  expect(aws).not.toHaveBeenCalled();
});

test("actual Production writer guard reads only its ENV partition through the session", async () => {
  const f = context("production"),
    role = f.variables.PRODUCTION_APPLY_ROLE_ARN;
  const statements = JSON.parse(
    prepareArtifactIamSession({ ...f, phase: "apply" }).policy,
  ).Statement;
  mockGuardState.caller = {
    Account: f.binding.accountId,
    Arn: `arn:aws:sts::${f.binding.accountId}:assumed-role/${role.split("/").at(-1)}/run`,
  };
  const reads = [];
  mockGuardState.send = async (input) => {
    const key = unmarshall(input.Key);
    reads.push({ table: input.TableName, key });
    const arn = `arn:aws:dynamodb:${f.binding.region}:${f.binding.accountId}:table/${input.TableName}`;
    const allowed = statements.some(
      (s) =>
        s.Action === "dynamodb:GetItem" &&
        s.Resource === arn &&
        s.Condition?.["ForAllValues:StringEquals"]?.[
          "dynamodb:LeadingKeys"
        ]?.includes(key.pk),
    );
    if (!allowed)
      throw Object.assign(new Error("Denied"), {
        name: "AccessDeniedException",
      });
    return {};
  };
  const env = {
    DEPLOYMENT_ENVIRONMENT: "production",
    DEPLOYMENT_ACCOUNT_ID: f.binding.accountId,
    AWS_REGION: f.binding.region,
    DEPLOYMENT_GUARD_ROLE_ARN: role,
    DEPLOYMENT_CONTROL_TABLE: f.variables.DEPLOYMENT_CONTROL_TABLE,
  };
  await expect(runGuard(env, true)).resolves.toEqual({ status: "allowed" });
  expect(reads.length).toBeGreaterThan(0);
  for (const read of reads)
    expect(read).toEqual({
      table: f.variables.DEPLOYMENT_CONTROL_TABLE,
      key: { pk: "ENV", sk: "INTRODUCTION" },
    });
  const grant = statements.find(
    (s) =>
      s.Action === "dynamodb:GetItem" &&
      s.Resource.endsWith(":table/" + f.variables.DEPLOYMENT_CONTROL_TABLE),
  );
  expect(grant.Condition).toEqual({
    "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["ENV"] },
  });
  expect(
    statements
      .filter((s) =>
        []
          .concat(s.Action)
          .some((a) => /^dynamodb:(Put|Update|Delete)/.test(a)),
      )
      .every((s) =>
        s.Resource.endsWith(":table/meeting-notes-terraform-state-locks"),
      ),
  ).toBe(true);
});
test("Production guard decryption is bounded to its application key, service and table", () => {
  const f = context("production");
  f.variables.ARTIFACT_APP_KMS_KEY_ARN =
    "arn:aws:kms:us-east-1:123456789012:key/22222222-2222-4222-8222-222222222222";
  f.binding = artifactIamBinding(f);
  const prepared = prepareArtifactIamSession({ ...f, phase: "apply" });
  const grant = JSON.parse(prepared.policy).Statement.find(
    (s) => s.Action === "kms:Decrypt" && s.Resource === f.binding.kmsKeyArn,
  );
  expect(grant).toEqual({
    Effect: "Allow",
    Action: "kms:Decrypt",
    Resource: f.binding.kmsKeyArn,
    Condition: {
      StringEquals: {
        "kms:ViaService": "dynamodb.us-east-1.amazonaws.com",
        "kms:EncryptionContext:aws:dynamodb:tableName":
          f.variables.DEPLOYMENT_CONTROL_TABLE,
      },
    },
  });
  expect(Buffer.byteLength(prepared.policy)).toBeLessThanOrEqual(2048);
});

test("realistic capture selectors fit every phase without adding metadata object reads", () => {
  for (const environment of ["sandbox", "production"])
    for (const phase of ["plan", "apply"]) {
      const f = context(environment);
      f.storage.bucket = `${f.binding.prefix}-private-evidence-${f.binding.accountId}`;
      f.binding = artifactIamBinding(f);
      const prepared = prepareArtifactIamSession({ ...f, phase });
      expect(Buffer.byteLength(prepared.policy)).toBeLessThanOrEqual(2048);
      const metadata = JSON.parse(prepared.policy).Statement[0];
      for (const action of [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetObjectAcl",
        "s3:GetObjectRetention",
        "s3:GetObjectLegalHold",
        "s3:SelectObjectContent",
      ])
        expect(
          metadata.Action.some((pattern) =>
            new RegExp("^" + pattern.replaceAll("*", ".*") + "$", "i").test(
              action,
            ),
          ),
        ).toBe(false);
    }
});

test("maximum valid bucket selector lengths still fit the Production session", () => {
  const f = context("production");
  f.storage.bucket = "p".repeat(63);
  f.tfvars.TRANSCRIPTS_BUCKET = "t".repeat(63);
  f.binding = artifactIamBinding(f);
  expect(
    Buffer.byteLength(
      prepareArtifactIamSession({ ...f, phase: "apply" }).policy,
    ),
  ).toBeLessThanOrEqual(2048);
});
