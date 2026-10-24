/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { buildMaintenancePolicy } from "../../scripts/deployment/maintenance-fence.cjs";
import legacy from "../fixtures/maintenance/legacy593a.json";
const { binding } = legacy;
function denied(action, resource, attributes) {
  return buildMaintenancePolicy(binding).Statement.some(
    (s) =>
      s.Effect === "Deny" &&
      s.Action === action &&
      s.Resource === resource &&
      (!s.Condition ||
        attributes.includes(
          s.Condition["ForAnyValue:StringEquals"]["dynamodb:Attributes"],
        )),
  );
}
test.each([
  ["PutItem", "activeMeetingTableArn", [], true],
  ["UpdateItem", "activeMeetingTableArn", ["leaseExpiresAt"], false],
  ["DeleteItem", "activeMeetingTableArn", [], false],
  ["GetItem", "activeMeetingTableArn", [], false],
  ["PutItem", "personalMediaUploadJobTableArn", ["processingStartedAt"], false],
  [
    "UpdateItem",
    "personalMediaUploadJobTableArn",
    ["processingStartedAt", "uploadId"],
    true,
  ],
  [
    "UpdateItem",
    "personalMediaUploadJobTableArn",
    ["claimExpiresAt", "updatedAt"],
    false,
  ],
  [
    "UpdateItem",
    "personalMediaUploadJobTableArn",
    ["processedSegmentCount"],
    false,
  ],
  ["UpdateItem", "billing", ["processingStartedAt"], false],
])("bounds deny %s %s", (action, table, attrs, expected) => {
  expect(
    denied(
      "dynamodb:" + action,
      binding[table] || "arn:aws:dynamodb:us-east-1:123456789012:table/billing",
      attrs,
    ),
  ).toBe(expected);
});
test.each(Object.keys(binding))("rejects missing %s", (key) => {
  const invalid = { ...binding };
  delete invalid[key];
  expect(() => buildMaintenancePolicy(invalid)).toThrow();
});
test.each([
  { accountId: "999999999999" },
  { region: "eu-west-1" },
  { operationId: "invalid" },
  { taskRoleArn: "arn:aws:iam::123456789012:user/test-prod-task" },
  { taskRoleArn: "arn:aws:iam::123456789012:role/" },
  { taskRoleArn: "arn:aws:iam::123456789012:role/path/" },
  { activeMeetingTableArn: binding.personalMediaUploadJobTableArn },
  { personalMediaUploadJobTableArn: binding.activeMeetingTableArn },
  { activeMeetingTableArn: binding.activeMeetingTableArn + "/index/test" },
])("rejects foreign or malformed binding %j", (change) => {
  expect(() => buildMaintenancePolicy({ ...binding, ...change })).toThrow();
});
test("returns identity policy for attachment only to the bound role", () => {
  expect(
    buildMaintenancePolicy(binding).Statement.every((s) => !s.Principal),
  ).toBe(true);
});
