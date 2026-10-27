/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { fixture } from "../fixtures/productionManifest.js";
import { pausedPreparationFixture } from "../fixtures/productionPausedPreparation.js";
import { preparationRoleProposal } from "../../scripts/deployment/production-paused-preparation-policy.cjs";
function request() {
  const m = fixture();
  m.operationId = "00000000-0000-4000-8000-000000000001";
  const value = pausedPreparationFixture(m).request;
  for (const object of value.sourceObjects)
    object.encryption = { serverSideEncryption: "AES256" };
  return value;
}
const identity = { repositoryId: "1", repositoryOwnerId: "2" };
test("preparation proposal names exact read partitions, original keys and private capture namespace", () => {
  const r = request();
  r.sourceObjects[1].versionId = "pinned-v1";
  const proposal = preparationRoleProposal(r, identity),
    statements = proposal.permissions.Statement;
  expect(proposal.unresolved).toEqual([]);
  expect(proposal.roleArn).toBe(r.preparationRoleArn);
  expect(proposal.matcherInputs).toMatchObject({
    ...identity,
    repository: "Chronote-gg/Chronote",
    workflow: ".github/workflows/prepare-production-paused-drafts.yml",
    runAttempt: "1",
    sourceCommit: r.scope.sourceCommit,
  });
  expect(proposal.trust.Statement[0]).toMatchObject({
    Effect: "Allow",
    Action: "sts:AssumeRoleWithWebIdentity",
    Principal: {
      Federated: `arn:aws:iam::${r.scope.accountId}:oidc-provider/token.actions.githubusercontent.com`,
    },
    Condition: {
      StringEquals: {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub":
          "repo:Chronote-gg/Chronote:ref:refs/heads/master",
      },
      StringLike: { "sts:RoleSessionName": "paused-preparation-*-1" },
    },
  });
  expect(
    statements.find((s) => s.Sid === "PreparationPersonalQuery"),
  ).toMatchObject({
    Action: ["dynamodb:Query"],
    Resource: [r.resourceArns.personalJob, r.resourceArns.personalSegment],
    Condition: {
      "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["one", "two"] },
    },
  });
  expect(statements.find((s) => s.Sid === "PreparationSource0")).toMatchObject({
    Action: ["s3:GetObject", "s3:GetObjectVersion"],
    Resource: `arn:aws:s3:::${r.scope.bucket}/${r.sourceObjects[0].key}`,
  });
  expect(statements.find((s) => s.Sid === "PreparationSource1")).toMatchObject({
    Action: ["s3:GetObjectVersion"],
    Condition: { StringEquals: { "s3:VersionId": "pinned-v1" } },
  });
  const namespace = `production-introduction-preparation/${r.scope.operationId}/${r.scope.sourceCommit}`;
  for (const sid of ["PreparationCaptureWrite", "PreparationCaptureRead"])
    expect(statements.find((s) => s.Sid === sid).Resource).toBe(
      `arn:aws:s3:::${r.storeBinding.bucket}/${namespace}/*`,
    );
  expect(
    statements
      .flatMap((s) => s.Action)
      .filter((a) =>
        /^(iam:|ecs:|dynamodb:(Put|Update|Delete|BatchWrite|TransactWrite))/.test(
          a,
        ),
      ),
  ).toEqual([]);
  expect(
    statements.filter((s) => s.Action.includes("s3:PutObject")),
  ).toHaveLength(1);
  expect(
    statements.some((s) => s.Resource === r.resourceArns.deploymentControl),
  ).toBe(false);
});
test("general-purpose source KMS grants use the approved exact key and object context only", () => {
  const r = request(),
    key = r.resourceArns.personalJobKmsKeyArn;
  r.sourceObjects[0].encryption = {
    serverSideEncryption: "aws:kms",
    sseKmsKeyId: key,
    bucketKeyEnabled: false,
  };
  const statement = preparationRoleProposal(
    r,
    identity,
  ).permissions.Statement.find((s) => s.Sid === "PreparationSourceKey0");
  expect(statement).toMatchObject({
    Action: ["kms:Decrypt"],
    Resource: key,
    Condition: {
      StringEquals: {
        "kms:ViaService": `s3.${r.scope.region}.amazonaws.com`,
        "kms:EncryptionContext:aws:s3:arn": `arn:aws:s3:::${r.scope.bucket}/${r.sourceObjects[0].key}`,
      },
    },
  });
});
test("missing source encryption or KMS key is an unresolved proposal input, never a wildcard grant", () => {
  const r = request();
  delete r.sourceObjects[0].encryption;
  r.sourceObjects[1].encryption = {
    serverSideEncryption: "aws:kms",
    bucketKeyEnabled: false,
  };
  const proposal = preparationRoleProposal(r, identity);
  expect(proposal.unresolved).toEqual([
    { key: r.sourceObjects[0].key, field: "encryption" },
    { key: r.sourceObjects[1].key, field: "encryption.sseKmsKeyId" },
  ]);
  expect(
    proposal.permissions.Statement.filter((s) =>
      s.Sid.startsWith("PreparationSourceKey"),
    ),
  ).toEqual([]);
});
test.each([
  (r) => (r.sourceObjects[0].key += "*"),
  (r) =>
    (r.resourceArns.personalJob = r.resourceArns.personalJob.replace(
      r.scope.accountId,
      "999999999999",
    )),
  (r) =>
    (r.sourceObjects[0].encryption = {
      serverSideEncryption: "aws:kms",
      sseKmsKeyId:
        "arn:aws:kms:us-west-2:999999999999:key/00000000-0000-0000-0000-000000000001",
      bucketKeyEnabled: false,
    }),
  (r) =>
    (r.sourceObjects[0].encryption = { serverSideEncryption: "aws:kms:dsse" }),
  (r) => r.cohort.push({ ...r.cohort[0], uploadId: "third" }),
])("proposal refuses unsupported or widened request scope", (change) => {
  const r = request();
  change(r);
  expect(() => preparationRoleProposal(r, identity)).toThrow();
});

test.each(
  ["personalJob", "personalSegment"].flatMap((table) =>
    ["*", "source?"].map((name) => ({ table, name })),
  ),
)(
  "consistent wildcard $table names cannot widen the proposal",
  ({ table, name }) => {
    const r = request();
    r.scope[`${table}Table`] = name;
    r.resourceArns[table] =
      `arn:aws:dynamodb:${r.scope.region}:${r.scope.accountId}:table/${name}`;
    expect(() => preparationRoleProposal(r, identity)).toThrow();
  },
);
