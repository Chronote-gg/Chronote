/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { sourceLossFixture } from "../deployment/fixtures/sourceLossFixture";
import { retainedSourceLossFixture } from "../deployment/fixtures/retainedSourceLossFixture";
import { carryforwardFixture } from "../deployment/fixtures/carryforwardFixture";
import { preparingRecoveryFixture } from "../deployment/fixtures/preparingRecoveryFixture";
import { recoverSandbox } from "../../scripts/deployment/recover-sandbox.cjs";
import { recoverRetainedSandbox } from "../../scripts/deployment/recover-retained-sandbox.cjs";
import { carryforwardSandbox } from "../../scripts/deployment/carryforward-sandbox.cjs";
import { recoverPreparingSandbox } from "../../scripts/deployment/recover-preparing-sandbox.cjs";

const operations = [
  ["source-loss", sourceLossFixture, recoverSandbox, "recover"],
  [
    "retained-source-loss",
    retainedSourceLossFixture,
    recoverRetainedSandbox,
    "recover",
  ],
  ["carryforward", carryforwardFixture, carryforwardSandbox, "carryforward"],
  ["preparing", preparingRecoveryFixture, recoverPreparingSandbox, "recover"],
];
const mutations = new Set([
  "put-item",
  "update-item",
  "transact-write-items",
  "register-task-definition",
  "update-service",
  "modify-listener",
  "stop-task",
]);

test.each(operations)(
  "%s recovery keeps real identity, endpoint and production-scope refusals before writes",
  async (_name, fixture, operation, mode) => {
    for (const refusal of [
      "root",
      "production_role",
      "foreign_account",
      "endpoint",
      "production_scope",
    ]) {
      const f = await fixture();
      const original = f.aws.getMockImplementation();
      if (["root", "production_role", "foreign_account"].includes(refusal)) {
        f.aws.mockImplementation(async (service, action, input) => {
          const result = await original(service, action, input);
          if (service !== "sts") return result;
          if (refusal === "root")
            return { ...result, Arn: `arn:aws:iam::${result.Account}:root` };
          if (refusal === "production_role")
            return {
              ...result,
              Arn: result.Arn.replace("sandbox", "production"),
            };
          return { ...result, Account: "999999999999" };
        });
      }
      if (refusal === "endpoint")
        f.options.env.AWS_ENDPOINT_URL_DYNAMODB = "http://127.0.0.1:9";
      if (refusal === "production_scope") {
        delete f.options.validateScope;
        f.options.env.CONTINUATION_ENVIRONMENT = "production";
      }
      const before = f.aws.mock.calls.length;
      await expect(operation({ ...f.options, mode })).rejects.toThrow();
      const calls = f.aws.mock.calls.slice(before);
      expect(calls.filter(([, action]) => mutations.has(action))).toEqual([]);
      if (refusal === "endpoint") expect(calls).toEqual([]);
      else expect(calls.some(([service]) => service === "sts")).toBe(true);
    }
  },
);
