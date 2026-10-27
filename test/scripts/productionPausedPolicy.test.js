/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import {
  preservationPolicy,
  assertPausedPolicy,
  fixtureDenials,
} from "../../scripts/deployment/production-paused-policy.cjs";
function fixture(purpose = "introduction") {
  const manifest = completeManifest();
  const identities = ["one", "two"].map((uploadId) => ({
    uploadId,
    ownerUserId: "owner",
    sourceCount: 1,
  }));
  const objects = identities.map((row) => ({
    ...row,
    key: `personal-media-uploads/owner/${row.uploadId}/0.wav`,
    versionId: "v1",
  }));
  const request = {
    resourceArns: {
      personalJobKmsKeyArn: manifest.acceptance.storageKeyArn,
      personalSegmentKmsKeyArn: manifest.acceptance.storageKeyArn,
    },
  };
  const scope = { manifest, identities, objects, request };
  const policy = preservationPolicy(scope, purpose);
  const role = {
    purpose,
    arn:
      purpose === "introduction"
        ? manifest.identity.roleArn
        : manifest.acceptance.collectorRoleArn,
    roleId: "role",
    attached: [],
    boundary: null,
    inline: [
      { name: "paused-desktop-draft-preservation-v1", document: policy },
    ],
  };
  return { scope, role, policy };
}
test.each(["introduction", "collector"])(
  "matches exact %s versioned and keyed preservation grants",
  (purpose) => {
    const f = fixture(purpose);
    expect(assertPausedPolicy(f.scope, [f.role], purpose)).toMatchObject({
      roleId: "role",
      purpose,
    });
    const objectGrants = f.policy.Statement.filter((s) =>
      s.Sid.startsWith("PreservedObject"),
    );
    expect(objectGrants).toHaveLength(2);
    expect(
      objectGrants.every((s) => s.Action.join() === "s3:GetObjectVersion"),
    ).toBe(true);
    expect(
      f.policy.Statement.some((s) => s.Action.includes("dynamodb:PutItem")),
    ).toBe(purpose === "introduction");
    expect(
      f.policy.Statement.some((s) =>
        s.Action.includes("dynamodb:ConditionCheckItem"),
      ),
    ).toBe(purpose === "introduction");
  },
);
test.each([
  ["missing Query", (f) => f.policy.Statement.shift()],
  [
    "third ID",
    (f) =>
      f.policy.Statement[0].Condition["ForAllValues:StringEquals"][
        "dynamodb:LeadingKeys"
      ].push("three"),
  ],
  [
    "wildcard object",
    (f) =>
      (f.policy.Statement.find((s) => s.Sid === "PreservedObject0").Resource +=
        "*"),
  ],
  [
    "version cross product",
    (f) =>
      (f.policy.Statement.find(
        (s) => s.Sid === "PreservedObject0",
      ).Condition.StringEquals["s3:VersionId"] = ["v1", "v2"]),
  ],
  ["wrong principal", (f) => (f.role.arn += "-other")],
  ["wrong table", (f) => (f.policy.Statement[0].Resource[0] += "-other")],
  [
    "missing marker",
    (f) =>
      (f.policy.Statement = f.policy.Statement.filter(
        (s) => s.Sid !== "PausedMarkerRead",
      )),
  ],
  [
    "unknown Deny",
    (f) =>
      f.role.inline.push({
        name: "deny",
        document: {
          Statement: [
            { Effect: "Deny", Action: ["s3:GetObjectVersion"], Resource: "*" },
          ],
        },
      }),
  ],
  ["boundary", (f) => (f.role.boundary = {})],
  ["attachment", (f) => f.role.attached.push({})],
  ["extra document field", (f) => (f.policy.extra = true)],
])("refuses %s", (_name, change) => {
  const f = fixture();
  change(f);
  expect(() => assertPausedPolicy(f.scope, [f.role], "introduction")).toThrow();
});
test("collector refuses marker writes and altered known fixture denial", () => {
  const f = fixture("collector");
  f.role.inline.push({
    name: "extra",
    document: {
      Statement: [
        { Effect: "Allow", Action: ["dynamodb:PutItem"], Resource: "*" },
      ],
    },
  });
  expect(() => assertPausedPolicy(f.scope, [f.role], "collector")).toThrow();
  f.role.inline.pop();
  const denies = fixtureDenials(f.scope.manifest);
  f.role.inline.push({
    name: "bounded-fixture-collection",
    document: { Statement: denies },
  });
  expect(() =>
    assertPausedPolicy(f.scope, [f.role], "collector"),
  ).not.toThrow();
  denies[0].NotAction = "s3:GetObject";
  expect(() => assertPausedPolicy(f.scope, [f.role], "collector")).toThrow();
});
test.each(["null", "v*", ""])(
  "refuses unsupported object version %s",
  (version) => {
    const f = fixture();
    f.scope.objects[0].versionId = version;
    expect(() => preservationPolicy(f.scope, "introduction")).toThrow();
  },
);
