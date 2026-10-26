/** @jest-environment node */
import { planCompatibleReplacement } from "../../src/services/runtimeCompatibleReplacementService";
import { control, runtime } from "../deployment/controlFixtures";
import type {
  CompatibleReplacementInput,
  RuntimeRecord,
} from "../../src/types/deploymentControl";

function fixture(): CompatibleReplacementInput {
  const old = runtime("old");
  old.readiness.expiresAt = 99;
  old.workCounts = {
    pending_admission: 0,
    recording: 1,
    finalization: 0,
    personal_processing: 0,
    recovery_processing: 0,
    voice_operation: 0,
    ancillary_delivery: 0,
  };
  const candidate = runtime("replacement", "candidate");
  candidate.workCounts = {
    pending_admission: 0,
    recording: 0,
    finalization: 0,
    personal_processing: 0,
    recovery_processing: 0,
    voice_operation: 0,
    ancillary_delivery: 0,
  };
  if (old.identity.kind !== "ecs" || candidate.identity.kind !== "ecs")
    throw new Error("fixture");
  candidate.identity.candidateId = old.identity.candidateId;
  candidate.readiness.identity = candidate.identity;
  candidate.protection.identity = candidate.identity;
  return {
    now: 100,
    candidate,
    members: [old],
    control: {
      ...structuredClone(control),
      coordinatorExpiresAt: 99,
      deployment: {
        runToken: "finished",
        cluster: "fixture",
        service: "fixture",
        family: "fixture",
        tablePrefix: "fixture",
        candidateId: "old",
        image: "fixture",
        runtimeMode: "all",
        phase: "complete",
        originalGeneration: 6,
        originalMembers: [runtime("previous").identity],
        outgoing: runtime("previous").identity,
        previousTaskDefinition: "fixture:1",
        taskDefinition: "fixture:2",
        candidate: old.identity,
        updatedAt: 90,
      },
    },
  };
}

test("compatible replacement seals only admission and preserves old ownership", () => {
  const input = fixture();
  const next = planCompatibleReplacement(input);
  expect(next.control.servingGeneration).toBe(8);
  expect(Object.keys(next.control.servingMembers)).toEqual(["replacement"]);
  expect(
    next.runtimes.find((row) => row.identity.instanceId === "old"),
  ).toEqual({ ...input.members[0], role: "draining" });
  expect(
    next.runtimes.find((row) => row.identity.instanceId === "replacement"),
  ).toMatchObject({ role: "serving", authorizedGeneration: 8 });
});

test.each([
  "missing",
  "counts",
  "warming",
  "coordinator",
  "fresh",
  "image",
  "candidate",
  "mode",
])("refuses ambiguous or incompatible %s", (kind) => {
  const input = fixture();
  if (kind === "counts") input.candidate.workCounts = undefined;
  if (kind === "missing") input.control.deployment = undefined;
  if (kind === "warming") input.control.deployment!.phase = "warming";
  if (kind === "coordinator") input.control.coordinatorExpiresAt = 101;
  if (kind === "fresh") input.members[0].readiness.expiresAt = 101;
  if (kind === "image" && input.candidate.identity.kind === "ecs")
    input.candidate.identity.imageDigest = "changed";
  if (kind === "candidate" && input.candidate.identity.kind === "ecs")
    input.candidate.identity.candidateId = "changed";
  if (kind === "mode") input.candidate.readiness.runtimeMode = "api";
  expect(() => planCompatibleReplacement(input)).toThrow();
});

test("retained API proof is not manufactured and repeat replacement remains bound", () => {
  const input = fixture();
  input.members[0].readiness.runtimeMode = "bot";
  input.candidate.readiness.runtimeMode = "bot";
  input.control.deployment!.runtimeMode = "bot";
  const api = runtime("api");
  api.readiness.runtimeMode = "api";
  input.members.push(api);
  input.control.servingMembers.api = api.identity;
  input.control.deployment!.originalMembers.push(api.identity);
  const next = planCompatibleReplacement(input);
  expect(
    next.runtimes.find((row) => row.identity.instanceId === "api")?.readiness,
  ).toEqual(api.readiness);
  const replacement = next.runtimes.find(
    (row) => row.identity.instanceId === "replacement",
  )!;
  replacement.readiness = {
    ...replacement.readiness,
    observedGeneration: 8,
    expiresAt: 100,
  };
  const freshApi = next.runtimes.find(
    (row) => row.identity.instanceId === "api",
  )!;
  freshApi.readiness.observedGeneration = 8;
  const second: RuntimeRecord = structuredClone(input.candidate);
  if (second.identity.kind !== "ecs") throw new Error("fixture");
  second.identity = {
    ...second.identity,
    instanceId: "second",
    taskArn: "fixture:second",
  };
  second.sk = "RUNTIME#second";
  second.authorizedGeneration = 8;
  second.readiness = {
    ...second.readiness,
    identity: second.identity,
    observedGeneration: 8,
  };
  second.protection.identity = second.identity;
  expect(
    planCompatibleReplacement({
      control: next.control,
      candidate: second,
      members: [replacement, freshApi],
      now: 101,
    }).control.servingGeneration,
  ).toBe(9);
});

test("a new deployment invalidates a repeated-replacement lineage receipt", () => {
  const input = fixture();
  const next = planCompatibleReplacement(input);
  next.control.deployment = {
    ...next.control.deployment!,
    runToken: "new-deployment",
    phase: "warming",
  };
  expect(() =>
    planCompatibleReplacement({ ...input, control: next.control }),
  ).toThrow();
});
