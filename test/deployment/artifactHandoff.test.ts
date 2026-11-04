/** @jest-environment node */
import * as artifactTypes from "../../src/types/artifactSafety";
import * as artifactBuilders from "../../src/services/artifactSafetyTransactions";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { artifactSafetyFixture } from "./fixtures/artifactSafetyFixture";
import { attestation } from "./fixtures/legacyArtifactFixture";
import { createArtifactHandoff } from "../../scripts/deployment/artifact-handoff.cjs";

function fixture(now = () => 120) {
  const f = artifactSafetyFixture();
  let row: artifactTypes.ArtifactSafetyRecord | undefined = f.expected;
  const aws = jest.fn(async (_service, operation, input) => {
    if (operation === "get-item")
      return { Item: row ? marshall(row) : undefined };
    row = artifactTypes.artifactSafetyRecordSchema.parse(
      unmarshall(input.TransactItems[0].Put.Item),
    );
    if (row.state === "consumed")
      f.ctl = artifactBuilders.artifactPreparationControl(
        f.ctl,
        120,
        "warming",
      );
    return {};
  });
  const helper = createArtifactHandoff({
    artifactTypes,
    artifactBuilders,
    aws,
    tables: f.tables,
    now,
    runtime: async () => f.source,
    control: async () => f.ctl,
    renew: async () => f.ctl,
    protectedTask: async () => ({
      expirationDate: new Date(600_000).toISOString(),
    }),
    sleep: async () => {
      throw new Error("unexpected wait");
    },
    production: undefined,
  });
  return {
    ...f,
    helper,
    aws,
    setRow: (value: artifactTypes.ArtifactSafetyRecord | undefined) => {
      row = value;
    },
  };
}

test("consumes the exact sealed proof together with warming before launch", async () => {
  const f = fixture();
  expect((await f.helper.prepare(f.ctl)).deployment.phase).toBe("warming");
  expect(
    f.aws.mock.calls.filter((call) => call[1] === "transact-write-items"),
  ).toHaveLength(1);
  await expect(
    f.helper.committed(
      await f.helper.prepare({
        ...f.ctl,
        deployment: { ...f.ctl.deployment, phase: "warming" },
      }),
    ),
  ).resolves.toBeDefined();
});

test("consumption stays bound to one clock reading across a slow runtime read", async () => {
  let clock = 120;
  const f = fixture(() => clock++);
  expect((await f.helper.prepare(f.ctl)).deployment.phase).toBe("warming");
});

test("legacy capability refuses, including an emergency quiet override", async () => {
  const f = fixture();
  f.setRow(undefined);
  await expect(f.helper.prepare(f.ctl)).rejects.toThrow(/capability/);
  expect(
    f.aws.mock.calls.some((call) => call[1] === "transact-write-items"),
  ).toBe(false);
});

test("cancel is only legal before atomic proof consumption", async () => {
  const f = fixture();
  const warming = await f.helper.prepare(f.ctl);
  await expect(f.helper.cancel(warming)).rejects.toThrow();
});

test("a candidate needs its own fresh sealed startup proof", async () => {
  const f = fixture();
  await expect(f.helper.candidate(f.source.identity)).rejects.toThrow(
    /startup/,
  );
});

function attestedConsumed(f: ReturnType<typeof fixture>) {
  return artifactTypes.artifactSafetyRecordSchema.parse({
    ...f.expected,
    revision: 3,
    startup: { kind: "pending" },
    state: "consumed",
    consumedAt: 120,
    attestation: { ...attestation, verifiedAt: 100 },
  });
}

test("an attested legacy source reports operator evidence, not a runtime proof", async () => {
  const f = fixture();
  f.setRow(attestedConsumed(f));
  await expect(f.helper.sourceEvidence(f.ctl)).resolves.toBe(
    "operator_attested_legacy",
  );
  f.setRow(f.expected);
  await f.helper.prepare(f.ctl);
  await expect(f.helper.sourceEvidence(f.ctl)).resolves.toBe(
    "verified_at_launch",
  );
});

test("retirement accepts an attested legacy source that cannot verify itself", async () => {
  const f = fixture();
  const acknowledgment = {
    request: {
      identity: f.source.identity,
      authorizedGeneration: 7,
      coordinatorToken: "coordinator",
      coordinatorEpoch: 3,
    },
    retiredAt: 130,
  };
  f.setRow(attestedConsumed(f));
  await expect(
    f.helper.retired(f.source.identity, acknowledgment),
  ).resolves.toBeUndefined();
  f.setRow(
    artifactTypes.artifactSafetyRecordSchema.parse({
      ...f.expected,
      revision: 3,
      state: "consumed",
      consumedAt: 120,
    }),
  );
  await expect(
    f.helper.retired(f.source.identity, acknowledgment),
  ).rejects.toThrow(/verification/);
});

test("an expired attestation refuses before any request is written", async () => {
  const f = fixture();
  const rest = artifactTypes.artifactSafetyBaseSchema.parse(
    attestedConsumed(f),
  );
  f.setRow(
    artifactTypes.artifactSafetyRecordSchema.parse({
      ...rest,
      state: "attested_legacy",
      attestation: {
        ...rest.attestation,
        capturedAt: 0,
        verifiedAt: 0,
        expiresAt: 100,
      },
    }),
  );
  await expect(f.helper.prepare(f.ctl)).rejects.toThrow(/attestation expired/);
  expect(
    f.aws.mock.calls.some((call) => call[1] === "transact-write-items"),
  ).toBe(false);
});
