/** @jest-environment node */
import { test, expect, jest } from "@jest/globals";
import {
  assertNormalWriter,
  assertPrerequisitePlan,
} from "../../scripts/deployment/production-writer-guard.cjs";
const config = {
  environment: "production",
  accountId: "123456789012",
  region: "us-east-1",
  roleArn: "arn:aws:iam::123456789012:role/guard",
  table: "app-DeploymentControlTable",
};
const caller = {
  Account: config.accountId,
  Arn: "arn:aws:sts::123456789012:assumed-role/guard/run",
};
const invoke = (read, extra = {}) =>
  assertNormalWriter({ config, caller, read, ...extra });
test("normal writer permits absent hold but refuses held, malformed and unreadable state", async () => {
  await expect(invoke(async () => undefined)).resolves.toEqual({
    status: "allowed",
  });
  for (const hold of [
    {},
    { recordType: "production_introduction", deployment: { state: "held" } },
  ])
    await expect(invoke(async () => hold)).rejects.toThrow();
  await expect(
    invoke(async () => {
      throw { name: "AccessDeniedException" };
    }),
  ).rejects.toThrow();
});
test("missing configuration and root or foreign identities refuse before reads", async () => {
  const read = jest.fn();
  for (const patch of [{ roleArn: "" }, { accountId: "" }, { table: "" }])
    await expect(
      assertNormalWriter({ config: { ...config, ...patch }, caller, read }),
    ).rejects.toThrow();
  await expect(
    assertNormalWriter({
      config,
      caller: { ...caller, Arn: "arn:aws:iam::123456789012:root" },
      read,
    }),
  ).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
const plan = () => ({
  resource_changes: [
    {
      mode: "managed",
      address: "aws_kms_key.app_general",
      change: { actions: ["no-op"] },
    },
    {
      mode: "managed",
      address: "aws_dynamodb_table.deployment_control_table",
      change: { actions: ["create"], after: { name: config.table } },
    },
  ],
});
test("missing-table exception proves actual exact table create, not empty or other plan", () => {
  expect(() => assertPrerequisitePlan(plan(), config.table)).not.toThrow();
  const empty = plan();
  empty.resource_changes.pop();
  expect(() => assertPrerequisitePlan(empty, config.table)).toThrow();
  const wrong = plan();
  wrong.resource_changes[1].change.after.name = "other";
  expect(() => assertPrerequisitePlan(wrong, config.table)).toThrow();
});
