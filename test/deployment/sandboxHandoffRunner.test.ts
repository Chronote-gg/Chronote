import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSandboxHandoffPlan,
  planGeneratedDescendantRemoval,
  runCli,
} from "../../scripts/deployment/verify-sandbox-handoff.cjs";
function fixture() {
  const runId = randomUUID();
  const artifact = {
    sourceCommit: "a".repeat(40),
    imageDigest: `sha256:${"b".repeat(64)}`,
    taskDefinition: "generated:1",
  };
  return {
    environment: "sandbox",
    accountId: "123456789012",
    region: "us-east-1",
    cluster: "generated-sandbox",
    service: "generated-sandbox",
    tablePrefix: "generated-sandbox-",
    bucket: "generated-sandbox",
    fixture: {
      runId,
      guildId: "generated-guild",
      voiceChannelId: "generated-voice",
      textChannelId: "generated-text",
      ownerUserId: "generated-owner",
      prefix: `generated/handoff/${runId}/`,
      checksums: ["c".repeat(64)],
    },
    old: artifact,
    candidate: artifact,
    rollback: artifact,
  };
}
test("explicit Sandbox dry-run reports only unexecuted stages and content checksums", () => {
  const plan = buildSandboxHandoffPlan(fixture());
  expect(plan).toMatchObject({
    providerMutations: 0,
    providerAcceptance: "UNKNOWN",
    identityVerification: "UNKNOWN",
    cleanupRoute: "MISSING",
    fixtureChecksums: ["c".repeat(64)],
  });
  expect(plan.stages).toHaveLength(10);
  expect(
    plan.stages.every(
      (stage: { outcome: string }) => stage.outcome === "NOT_RUN",
    ),
  ).toBe(true);
});
test.each([
  {},
  { environment: "production" },
  { bucket: "production" },
  { candidate: undefined },
])("refuses missing or non-Sandbox scope %j", (patch) => {
  expect(() =>
    buildSandboxHandoffPlan(
      Object.keys(patch).length ? { ...fixture(), ...patch } : {},
    ),
  ).toThrow();
});
test("refuses execution and a fixture-prefix mismatch", () => {
  expect(() => runCli(["--execute"])).toThrow();
  const input = fixture();
  input.fixture.prefix = `generated/handoff/${randomUUID()}/`;
  expect(() => buildSandboxHandoffPlan(input)).toThrow();
});
function cleanupFixture() {
  const prefix = fixture().fixture.prefix;
  const owner = {
    meetingId: "generated-meeting",
    ownerInstanceId: "generated-runtime",
    executionVersion: 1,
  };
  const meetingFixture = {
    guildId: "generated-guild",
    channelId: "generated-voice",
    meetingId: owner.meetingId,
    reservedAt: "2026-10-14T12:00:00.000Z",
  };
  const artifactFolder = `${prefix}${meetingFixture.guildId}/${meetingFixture.channelId}_${meetingFixture.meetingId}_2026-10-14T12-00-00.000Z/`;
  const settled = {
    owner,
    outcome: "verified_settled",
    receipt: "generated-ack",
  };
  const keys = [
    `${artifactFolder}checkpoints/v1/1-owner/manifest.json`,
    `${artifactFolder}checkpoints/v1/1-owner/completed.pcm`,
    `${artifactFolder}checkpoints/v1/1-owner/orphan.pcm`,
    `${artifactFolder}notes.txt`,
  ];
  return {
    scope: "generated-local",
    prefix,
    fixture: meetingFixture,
    history: {
      owner,
      status: "complete",
      checkpoint: { artifactFolder },
      receipt: "generated-history-ack",
    },
    capture: settled,
    recovery: settled,
    currentWork: settled,
    enumeration: { complete: true, keys, receipt: "generated-complete-list" },
  };
}
test.each(["capture", "recovery", "currentWork"] as const)(
  "refuses active, uncertain or absent %s proof and preserves every generated object",
  (domain) => {
    const input = cleanupFixture();
    const objects = new Map(
      input.enumeration.keys.map((key) => [key, Buffer.from("generated")]),
    );
    for (const outcome of [
      "active",
      "uncertain",
      "unknown",
      "absent",
      "expired",
    ])
      expect(() =>
        planGeneratedDescendantRemoval({
          ...input,
          [domain]: { ...input[domain], outcome },
        }),
      ).toThrow();
    expect(objects.size).toBe(4);
  },
);
test("generated completed and orphan descendants are covered only after independent settlement receipts", () => {
  const input = cleanupFixture();
  const unrelated = `${input.prefix}${input.fixture.guildId}/generated-voice_sibling-meeting_2026-10-14T12-00-00.000Z/keep.pcm`;
  const objects = new Map(
    [...input.enumeration.keys, unrelated].map((key) => [
      key,
      Buffer.from("generated"),
    ]),
  );
  expect(() =>
    planGeneratedDescendantRemoval({
      ...input,
      enumeration: { ...input.enumeration, keys: [...objects.keys()] },
    }),
  ).toThrow("exact generated fixture folder");
  expect(objects.size).toBe(5);
  const plan = planGeneratedDescendantRemoval(input);
  expect(plan).toMatchObject({
    liveDeletionAuthorized: false,
    liveOwnershipFence: false,
  });
  expect(plan.keys).toEqual(input.enumeration.keys);
  for (const key of plan.keys) objects.delete(key);
  expect([...objects.keys()]).toEqual([unrelated]);
});
test("refuses incomplete enumeration, foreign keys, wrong history attempt and nonterminal history", () => {
  const input = cleanupFixture();
  expect(() =>
    planGeneratedDescendantRemoval({
      ...input,
      enumeration: { ...input.enumeration, complete: false },
    }),
  ).toThrow();
  for (const key of [
    "other/file",
    `${input.prefix}../escape`,
    `${input.history.checkpoint.artifactFolder}folder\\escape`,
    `${input.history.checkpoint.artifactFolder}../escape`,
    input.history.checkpoint.artifactFolder,
  ])
    expect(() =>
      planGeneratedDescendantRemoval({
        ...input,
        enumeration: { ...input.enumeration, keys: [key] },
      }),
    ).toThrow();
  expect(() =>
    planGeneratedDescendantRemoval({
      ...input,
      capture: {
        ...input.capture,
        owner: { ...input.capture.owner, executionVersion: 2 },
      },
    }),
  ).toThrow();
  expect(() =>
    planGeneratedDescendantRemoval({
      ...input,
      history: { ...input.history, status: "processing" },
    }),
  ).toThrow();
});

test("binds the canonical checkpoint folder to the reviewed meeting identity", () => {
  const input = cleanupFixture();
  for (const fixture of [
    { ...input.fixture, meetingId: "sibling-meeting" },
    { ...input.fixture, guildId: "other-guild" },
    { ...input.fixture, channelId: "other-channel" },
    { ...input.fixture, reservedAt: "2026-10-14T12:01:00.000Z" },
    { ...input.fixture, guildId: "../escape" },
  ])
    expect(() =>
      planGeneratedDescendantRemoval({ ...input, fixture }),
    ).toThrow();
  const siblingFolder = input.history.checkpoint.artifactFolder.replace(
    "generated-meeting",
    "sibling-meeting",
  );
  expect(() =>
    planGeneratedDescendantRemoval({
      ...input,
      history: {
        ...input.history,
        checkpoint: { artifactFolder: siblingFolder },
      },
      enumeration: {
        ...input.enumeration,
        keys: [`${siblingFolder}completed.pcm`],
      },
    }),
  ).toThrow("exact reviewed meeting fixture");
  expect(() =>
    planGeneratedDescendantRemoval({
      ...input,
      history: { ...input.history, checkpoint: undefined },
    }),
  ).toThrow();
  expect(() =>
    planGeneratedDescendantRemoval({
      ...input,
      prefix: "production/",
    }),
  ).toThrow();
});

test("CLI reads only the explicit generated config and returns an unexecuted plan", () => {
  const path = join(tmpdir(), `chronote-h7-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(fixture()), { flag: "wx" });
  try {
    expect(runCli(["--dry-run", "--config", path])).toMatchObject({
      mode: "dry-run",
      providerMutations: 0,
      providerAcceptance: "UNKNOWN",
    });
  } finally {
    unlinkSync(path);
  }
});
