"use strict";
const { canonicalHash } = require("./production-manifest.cjs");
const { isDeepStrictEqual: same } = require("node:util");
const { refuse } = require("./production-launcher-schema.cjs");
function document(value) {
  if (typeof value === "string") return JSON.parse(decodeURIComponent(value));
  if (!value || !Array.isArray(value.Statement)) refuse();
  return value;
}
async function pages(aws, operation, input, field) {
  const values = [],
    seen = new Set();
  let marker;
  do {
    const result = await aws(
      "iam",
      operation,
      { ...input, ...(marker ? { Marker: marker } : {}) },
      "@",
    );
    if (
      !Array.isArray(result[field]) ||
      typeof result.IsTruncated !== "boolean"
    )
      refuse();
    values.push(...result[field]);
    marker = result.IsTruncated ? result.Marker : undefined;
    if (result.IsTruncated && (!marker || seen.has(marker) || seen.size >= 100))
      refuse();
    if (marker) seen.add(marker);
  } while (marker);
  if (
    new Set(values.map((v) => (typeof v === "string" ? v : v.PolicyArn)))
      .size !== values.length
  )
    refuse();
  return values;
}
function assertDelegation(value, expected, declaration) {
  const collector = declaration.roles.find(
    (r) => r.purpose === "collector",
  ).arn;
  for (const statement of document(value).Statement) {
    if (statement.Effect !== "Allow") continue;
    if (statement.NotAction) refuse();
    const actions = Array.isArray(statement.Action)
      ? statement.Action
      : [statement.Action];
    const delegates = actions.some((action) => {
      if (typeof action !== "string" || !/^[a-zA-Z0-9:*?]+$/.test(action))
        refuse();
      return new RegExp(
        "^" +
          action.toLowerCase().replace(/\*/g, ".*").replace(/\?/g, ".") +
          "$",
      ).test("sts:assumerole");
    });
    if (
      delegates &&
      (!["introduction", "collector"].includes(expected.purpose) ||
        !same(actions, ["sts:AssumeRole"]) ||
        !same(statement.Resource, collector) ||
        !same(statement.Condition, {
          StringLike: {
            "sts:RoleSessionName": [
              "introduction-content-*-1-0",
              "introduction-content-*-1-1",
            ],
          },
        }))
    )
      refuse();
  }
}
async function policy(aws, arn, expected, declaration, grants = true) {
  const before = (
    await aws(
      "iam",
      "get-policy",
      { PolicyArn: arn },
      "{Policy:Policy.{Arn:Arn,DefaultVersionId:DefaultVersionId}}",
    )
  ).Policy;
  if (before?.Arn !== arn || !before.DefaultVersionId) refuse();
  const value = await aws(
    "iam",
    "get-policy-version",
    { PolicyArn: arn, VersionId: before.DefaultVersionId },
    "@",
  );
  if (
    value.PolicyVersion?.VersionId !== before.DefaultVersionId ||
    value.PolicyVersion.IsDefaultVersion !== true
  )
    refuse();
  if (grants)
    assertDelegation(value.PolicyVersion.Document, expected, declaration);
  const after = (
    await aws(
      "iam",
      "get-policy",
      { PolicyArn: arn },
      "{Policy:Policy.{Arn:Arn,DefaultVersionId:DefaultVersionId}}",
    )
  ).Policy;
  if (!same(before, after)) refuse();
  return {
    arn,
    versionId: before.DefaultVersionId,
    documentHash: canonicalHash(document(value.PolicyVersion.Document)),
  };
}
function assertEcsTrust(s) {
  if (
    s.Effect !== "Allow" ||
    s.Action !== "sts:AssumeRole" ||
    !same(s.Principal, { Service: "ecs-tasks.amazonaws.com" }) ||
    s.NotPrincipal ||
    s.NotAction
  )
    refuse();
}
function assertOidcConditions(s, expected, declaration) {
  const collector = expected.purpose === "collector";
  const equals = s.Condition?.StringEquals;
  const required = {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": `repo:${declaration.scope.repository}:${collector ? "ref:refs/heads/master" : "environment:production"}`,
  };
  if (
    !equals ||
    Object.entries(required).some(([key, value]) => !same(equals[key], value))
  )
    refuse();
  const constraints = {
    ...required,
    "token.actions.githubusercontent.com:ref": "refs/heads/master",
    "token.actions.githubusercontent.com:environment": "production",
    "token.actions.githubusercontent.com:repository_id":
      declaration.scope.repositoryId,
    "token.actions.githubusercontent.com:repository_owner_id":
      declaration.scope.repositoryOwnerId,
    "token.actions.githubusercontent.com:workflow":
      expected.purpose === "apply"
        ? "Terraform Apply"
        : ["collector", "introduction"].includes(expected.purpose)
          ? "Production introduction"
          : "Meeting Notes Bot Deploy",
  };
  if (
    Object.entries(equals).some(([key, value]) => constraints[key] !== value) ||
    Object.keys(s.Condition).some(
      (key) =>
        !["StringEquals", ...(collector ? ["StringLike"] : [])].includes(key),
    )
  )
    refuse();
}
function assertCollectorTrust(statements, s, expected, declaration) {
  if (
    !same(s.Condition.StringLike, {
      "sts:RoleSessionName": "introduction-read-*-1",
    })
  )
    refuse();
  const delegate = statements.find((entry) => entry !== s);
  const intro = declaration.roles.find((r) => r.purpose === "introduction").arn;
  if (
    delegate.Effect !== "Allow" ||
    delegate.Action !== "sts:AssumeRole" ||
    !same(delegate.Principal, {
      AWS: `arn:aws:iam::${declaration.scope.accountId}:root`,
    }) ||
    !same(delegate.Condition, {
      ArnEquals: { "aws:PrincipalArn": [intro, expected.arn] },
      StringLike: {
        "sts:RoleSessionName": [
          "introduction-content-*-1-0",
          "introduction-content-*-1-1",
        ],
      },
    }) ||
    delegate.NotPrincipal ||
    delegate.NotAction
  )
    refuse();
}
function assertTrust(trust, expected, declaration) {
  const statements = document(trust).Statement;
  const collector = expected.purpose === "collector";
  if (statements.length !== (collector ? 2 : 1)) refuse();
  if (["task", "execution"].includes(expected.purpose))
    return assertEcsTrust(statements[0]);
  const federated = statements.filter(
    (s) => s.Action === "sts:AssumeRoleWithWebIdentity",
  );
  if (federated.length !== 1) refuse();
  const [s] = federated;
  if (
    s.Effect !== "Allow" ||
    !same(s.Principal, { Federated: declaration.oidcProviders[0].arn }) ||
    s.NotPrincipal ||
    s.NotAction ||
    s.Resource ||
    s.NotResource
  )
    refuse();
  assertOidcConditions(s, expected, declaration);
  if (collector) assertCollectorTrust(statements, s, expected, declaration);
}
async function readRole(aws, expected, declaration) {
  const RoleName = expected.arn.split("/").at(-1);
  const select = async () => {
    const r = await aws("iam", "get-role", { RoleName }, "@");
    if (r.Role?.Arn !== expected.arn || r.Role.RoleId !== expected.roleId)
      refuse();
    const { Arn, RoleId, AssumeRolePolicyDocument, PermissionsBoundary } =
      r.Role;
    return { Arn, RoleId, AssumeRolePolicyDocument, PermissionsBoundary };
  };
  const before = await select();
  assertTrust(before.AssumeRolePolicyDocument, expected, declaration);
  const names = async () =>
    (
      await pages(aws, "list-role-policies", { RoleName }, "PolicyNames")
    ).sort();
  const attachments = async () =>
    (
      await pages(
        aws,
        "list-attached-role-policies",
        { RoleName },
        "AttachedPolicies",
      )
    )
      .map((p) => p.PolicyArn)
      .sort();
  const inlineNames = await names(),
    arns = await attachments(),
    inline = [],
    attached = [];
  for (const PolicyName of inlineNames) {
    const r = await aws(
      "iam",
      "get-role-policy",
      { RoleName, PolicyName },
      "@",
    );
    if (r.RoleName !== RoleName || r.PolicyName !== PolicyName) refuse();
    assertDelegation(r.PolicyDocument, expected, declaration);
    inline.push({
      name: PolicyName,
      documentHash: canonicalHash(document(r.PolicyDocument)),
    });
  }
  for (const arn of arns)
    attached.push(await policy(aws, arn, expected, declaration));
  const boundaryArn = before.PermissionsBoundary?.PermissionsBoundaryArn;
  if (
    before.PermissionsBoundary &&
    before.PermissionsBoundary.PermissionsBoundaryType !== "Policy"
  )
    refuse();
  const boundary = boundaryArn
    ? await policy(aws, boundaryArn, expected, declaration, false)
    : null;
  for (const entry of inline) {
    const reread = await aws(
      "iam",
      "get-role-policy",
      { RoleName, PolicyName: entry.name },
      "@",
    );
    if (canonicalHash(document(reread.PolicyDocument)) !== entry.documentHash)
      refuse();
  }
  if (
    !same(inlineNames, await names()) ||
    !same(arns, await attachments()) ||
    !same(before, await select())
  )
    refuse();
  const actual = {
    purpose: expected.purpose,
    arn: before.Arn,
    roleId: before.RoleId,
    trustHash: canonicalHash(document(before.AssumeRolePolicyDocument)),
    inline,
    attached,
    boundary,
  };
  if (!same(actual, expected)) refuse();
}
async function readIamSettings(aws, declaration) {
  for (const role of declaration.roles) await readRole(aws, role, declaration);
  for (const expected of declaration.oidcProviders) {
    if (
      expected.arn !==
      `arn:aws:iam::${declaration.scope.accountId}:oidc-provider/token.actions.githubusercontent.com`
    )
      refuse();
    const actual = await aws(
      "iam",
      "get-open-id-connect-provider",
      { OpenIDConnectProviderArn: expected.arn },
      "@",
    );
    if (
      !same(
        {
          arn: expected.arn,
          url: actual.Url,
          clientIds: actual.ClientIDList?.sort(),
          thumbprints: actual.ThumbprintList?.sort(),
        },
        expected,
      )
    )
      refuse();
  }
}
module.exports = { readIamSettings };
