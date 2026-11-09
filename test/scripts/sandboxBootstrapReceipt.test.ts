/** @jest-environment node */
import { marshall } from "@aws-sdk/util-dynamodb";
import { createCoordinator } from "../../scripts/deployment/coordinator.cjs";
import { fixture } from "../deployment/fixtures/coordinatorFixture";

const operationId = "11111111-1111-4111-8111-111111111111";
function receipt() {
  return {
    pk: "ENV",
    sk: "INTRODUCTION",
    operationId,
    manifestSha256: "a".repeat(64),
    stage: "complete",
    principalArn:
      "arn:aws:sts::123456789012:assumed-role/fixture-sandbox-github-deploy/chronote-sandbox-" +
      BigInt("0x" + operationId.replaceAll("-", "")) +
      "-1",
  };
}
function coordinator(row: Record<string, unknown>, prefix = "fixture-sandbox") {
  const f = fixture(),
    original = f.aws.getMockImplementation()!;
  for (const entry of f.definition.containerDefinitions[0].environment) {
    if (entry.name === "DDB_TABLE_PREFIX") entry.value = prefix + "-";
  }
  f.aws.mockImplementation(async (service, operation, input) => {
    if (
      operation === "get-item" &&
      JSON.stringify(input).includes('"INTRODUCTION"')
    )
      return { Item: marshall(row) };
    return original(service, operation, input);
  });
  return {
    ...f,
    coordinator: createCoordinator({
      ...f.options,
      env: {
        ...f.options.env,
        SECRETS_PREFIX: prefix,
        CANDIDATE_IMAGE:
          "123456789012.dkr.ecr.us-east-1.amazonaws.com/fixture@" +
          "sha256:" +
          "a".repeat(64),
      },
    }),
  };
}

test.each([false, true])(
  "completed Sandbox bootstrap receipt permits normal preparation (repair=%s)",
  async (repair) => {
    const row = {
      ...receipt(),
      ...(repair
        ? {
            previousOperationId: "22222222-2222-4222-8222-222222222222",
            previousManifestSha256: "b".repeat(64),
          }
        : {}),
    };
    const f = coordinator(row),
      before = structuredClone(row);
    await f.coordinator.prepare();
    expect(f.state.launched).toBe(true);
    expect(row).toEqual(before);
    const mutations = f.calls.filter((c) =>
      [
        "delete-item",
        "put-item",
        "update-item",
        "transact-write-items",
      ].includes(c.operation),
    );
    expect(JSON.stringify(mutations)).not.toContain('"INTRODUCTION"');
  },
);

test.each([
  { stage: "routing_acknowledged" },
  { stage: "failed" },
  {
    principalArn: receipt().principalArn.replace(
      "123456789012",
      "999999999999",
    ),
  },
  { operationId: "invalid" },
  { manifestSha256: "invalid" },
  {
    principalArn: receipt().principalArn.replace(
      "fixture-sandbox",
      "foreign-sandbox",
    ),
  },
  { principalArn: receipt().principalArn.replace(/-1$/, "-2") },
  { previousOperationId: "22222222-2222-4222-8222-222222222222" },
  { unexpected: "field" },
])(
  "incomplete, malformed or foreign receipts remain blocked: %j",
  async (patch) => {
    const f = coordinator({ ...receipt(), ...patch });
    await expect(f.coordinator.prepare()).rejects.toThrow();
    expect(f.state.launched).toBe(false);
    expect(
      f.calls.some((c) =>
        [
          "register-task-definition",
          "update-service",
          "modify-listener",
        ].includes(c.operation),
      ),
    ).toBe(false);
  },
);

test("completed Sandbox receipt cannot release a non-Sandbox deployment", async () => {
  const f = coordinator(receipt(), "fixture-prod");
  await expect(f.coordinator.prepare()).rejects.toThrow();
  expect(f.state.launched).toBe(false);
});
