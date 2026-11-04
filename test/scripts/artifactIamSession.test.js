/** @jest-environment node */
import { Buffer } from "node:buffer";
import { test, expect, jest } from "@jest/globals";
import { artifactIamFixture } from "../fixtures/deployment/artifactIamPlan.js";
import { artifactIamBinding } from "../../scripts/deployment/validate-artifact-iam-plan.cjs";
import {
  prepareArtifactIamSession,
  assertArtifactIamVersionCapacity,
} from "../../scripts/deployment/artifact-iam-session.cjs";
const context = (environment = "sandbox") => {
  const f = artifactIamFixture(environment);
  f.invocation.scope = "artifact-preservation-iam";
  f.variables.TERRAFORM_AWS_ROLE_ARN = `arn:aws:iam::123456789012:role/${environment === "sandbox" ? "meeting-notes-sandbox" : "meeting-notes-prod"}-github-terraform`;
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
