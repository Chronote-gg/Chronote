/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import { fixture } from "../deployment/fixtures/coordinatorFixture";
test.each(["prepare", "promote", "retire", "reconcile"])(
  "direct coordinator %s refuses durable introduction before mutations",
  async (phase) => {
    const f = fixture();
    const original = f.aws.getMockImplementation();
    f.aws.mockImplementation(async (service, operation, input) => {
      if (operation === "get-item" && input.Key.sk.S === "INTRODUCTION")
        return {
          Item: marshall({
            pk: "ENV",
            sk: "INTRODUCTION",
            recordType: "production_introduction",
            protocolVersion: 1,
            holdId: "hold",
            introductionId: "intro",
            manifestHash: "a".repeat(64),
            revision: 1,
            admission: { state: "held" },
            deployment: { state: "held" },
          }),
        };
      return original(service, operation, input);
    });
    await expect(f.coordinator[phase]()).rejects.toMatchObject({
      category: "introduction_held",
    });
    expect(
      f.calls.some((c) =>
        [
          "update-item",
          "transact-write-items",
          "update-service",
          "register-task-definition",
        ].includes(c.operation),
      ),
    ).toBe(false);
  },
);
