/** @jest-environment node */
import { test, expect } from "@jest/globals";
import {
  acknowledgmentFor,
  observationFor,
} from "../../scripts/deployment/introduction-transitions.cjs";
import { fixture } from "../fixtures/productionManifest.js";

const manifest = fixture();
const stop = manifest.actions.find((a) => a.kind === "stop_legacy");
test("retains the validated direct stop response separately from the observation", () => {
  const ack = acknowledgmentFor(manifest, stop, {
    task: { taskArn: stop.taskArn, desiredStatus: "STOPPED" },
  });
  expect(ack.facts).toEqual({
    kind: "task_stop",
    taskArn: stop.taskArn,
    desiredStatus: "STOPPED",
  });
  const observed = observationFor(manifest, stop, {
    taskArn: stop.taskArn,
    lastStatus: "STOPPED",
  });
  expect(observed.facts).toEqual({
    kind: "task_stopped",
    taskArn: stop.taskArn,
    lastStatus: "STOPPED",
  });
  expect(observed.facts).not.toEqual(ack.facts);
});
import { coordinatorRecipes } from "../../scripts/deployment/coordinator-recipes.cjs";
import { control, runtime } from "../deployment/controlFixtures";

test("promotion ACK preserves readiness and native protection at the real transaction boundary", () => {
  const candidate = runtime("new", "candidate");
  const nativeProtection = [
    {
      taskArn: candidate.identity.taskArn,
      protectionEnabled: true,
      expirationDate: new Date(500000).toISOString(),
    },
  ];
  const recipes = coordinatorRecipes({
    binding: { manifest },
    table: "control",
    coordinatorBuilders: {},
  });
  const receipt = recipes.acknowledgment(
    manifest,
    { purpose: "promote" },
    {},
    { control, historicalPromotion: { candidate, nativeProtection } },
    { operation: "transactWriteItems", input: {} },
  );
  expect(receipt.facts).toEqual({
    kind: "promotion",
    control,
    candidate,
    nativeProtection,
  });
});
