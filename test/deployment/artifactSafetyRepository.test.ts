/** @jest-environment node */
import { createMockArtifactSafetyRepository } from "../../src/repositories/artifactSafetyRepository";
import { artifactSafetyFixture } from "./fixtures/artifactSafetyFixture";
import { history } from "./controlFixtures";
import type { DeploymentControlRecord } from "../../src/types/deploymentControl";
import type { ArtifactSafetyRecord } from "../../src/types/artifactSafety";
import type { ArtifactSafetyWrite } from "../../src/services/artifactSafetyRules";

function fixture() {
  const f = artifactSafetyFixture();
  const records = new Map<string, DeploymentControlRecord>([
    [JSON.stringify(["ENV", "CONTROL"]), structuredClone(f.ctl)],
    [JSON.stringify(["ENV", "RUNTIME#old"]), structuredClone(f.source)],
  ]);
  const artifacts = new Map<string, ArtifactSafetyRecord>([
    [f.expected.sk, structuredClone(f.expected)],
  ]);
  const histories = new Map([
    [
      history.guildId,
      [
        {
          ...history,
          status: "complete" satisfies "complete",
          audioS3Key: "stored",
        },
      ],
    ],
  ]);
  const repository = createMockArtifactSafetyRepository({
    records,
    artifacts,
    histories,
  });
  const input: ArtifactSafetyWrite = {
    purpose: "consume",
    expected: f.expected,
    next: { ...f.expected, revision: 3, state: "consumed", consumedAt: 120 },
    context: { kind: "preparing", control: f.ctl, runtime: f.source },
    now: 120,
  };
  return { ...f, records, artifacts, histories, repository, input };
}

test("two consumers cannot both advance a single source into warming", async () => {
  const f = fixture();
  expect(
    await Promise.all([
      f.repository.write(f.input),
      f.repository.write(f.input),
    ]),
  ).toEqual(["applied", "stale"]);
  expect(await f.repository.read(f.source.identity)).toMatchObject({
    state: "consumed",
    revision: 3,
  });
  expect(f.records.get(JSON.stringify(["ENV", "CONTROL"]))).toMatchObject({
    deployment: { phase: "warming" },
  });
});

test("changed saved ownership refuses the proof atomically", async () => {
  const f = fixture();
  const authority = {
    owner: {
      guildId: history.guildId,
      meetingId: history.meetingId,
      ownerInstanceId: "old",
      executionVersion: 1,
    },
    historyKey: history.channelId_timestamp,
    checkpoint: null,
    status: "complete",
    completionDecision: null,
    audioS3Key: "stored",
    chatS3Key: null,
    transcriptS3Key: null,
  };
  f.expected.proof.snapshot.authorities = [authority];
  if (f.input.next.state !== "consumed") throw new Error("Invalid fixture");
  f.input.next.proof = structuredClone(f.expected.proof);
  f.artifacts.set(f.expected.sk, structuredClone(f.expected));
  f.histories.get(history.guildId)![0].executionVersion = 2;
  expect(await f.repository.write(f.input)).toBe("stale");
  expect(await f.repository.read(f.source.identity)).toMatchObject({
    state: "sealed",
  });
  expect(f.records.get(JSON.stringify(["ENV", "CONTROL"]))).toMatchObject({
    deployment: { phase: "preparing" },
  });
});

test("missing legacy capability stays unsupported rather than becoming a fabricated proof", async () => {
  const f = fixture();
  f.artifacts.clear();
  expect(await f.repository.read(f.source.identity)).toBeUndefined();
  expect(await f.repository.write(f.input)).toBe("stale");
});
