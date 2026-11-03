import { artifactSafetyRecordSchema } from "../../../src/types/artifactSafety";
import { control, runtime } from "../controlFixtures";
import type { ControlRecord } from "../../../src/types/deploymentControl";

export function artifactSafetyFixture() {
  const source = runtime("old");
  const ctl: ControlRecord = {
    ...control,
    deployment: {
      runToken: control.coordinatorToken,
      cluster: "cluster",
      service: "service",
      family: "family",
      tablePrefix: "test-",
      candidateId: "candidate",
      image: "image",
      runtimeMode: "all",
      phase: "preparing",
      originalGeneration: control.servingGeneration,
      originalMembers: Object.values(control.servingMembers),
      outgoing: source.identity,
      previousTaskDefinition: "previous",
      updatedAt: 100,
    },
  };
  const expected = artifactSafetyRecordSchema.parse({
    pk: "ENV",
    sk: "ARTIFACTS#old/STATE",
    recordType: "artifact_safety",
    schemaVersion: 1,
    identity: source.identity,
    revision: 2,
    heartbeatAt: 110,
    freshUntil: 170,
    startup: { kind: "active", activatedAt: 90 },
    state: "sealed",
    request: {
      source: source.identity,
      coordinatorToken: control.coordinatorToken,
      coordinatorEpoch: control.coordinatorEpoch,
      servingGeneration: control.servingGeneration,
      requestedAt: 100,
      expiresAt: 300,
    },
    proof: {
      provenAt: 110,
      expiresAt: 170,
      snapshot: {
        inventoryDigest: "a".repeat(64),
        fileCount: 0,
        byteLength: 0,
        pendingDirectories: 0,
        authorities: [],
      },
    },
  });
  if (expected.state !== "sealed") throw new Error("Invalid fixture");
  return {
    expected,
    source,
    ctl,
    tables: { deploymentControl: "control", meetingHistory: "history" },
  };
}
