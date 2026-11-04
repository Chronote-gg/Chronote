/** @jest-environment node */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, jest, test } from "@jest/globals";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createCoordinator } from "../../scripts/deployment/coordinator.cjs";
import { createBreakGlass } from "../../scripts/deployment/break-glass.cjs";
import * as artifactTypes from "../../src/types/artifactSafety";
import * as legacyArtifactBuilders from "../../src/services/legacyArtifactAttestation";
import {
  env,
  fixture,
  oldIdentity,
} from "../deployment/fixtures/coordinatorFixture";
import {
  legacyFixture,
  sha256,
} from "../deployment/fixtures/legacyAttestationFixture";
import { dispatchEnv } from "../deployment/fixtures/breakGlassFixture";
import { attestation } from "../deployment/fixtures/legacyArtifactFixture";

type Fixture = ReturnType<typeof legacyFixture>;
const WRITES = [
  "put-item",
  "update-item",
  "transact-write-items",
  "register-task-definition",
  "update-service",
];
const manifestHash = (f: Fixture) => sha256(f.body.toString());
function breakGlass(f: Fixture, extra: Record<string, string> = {}) {
  const recordPath = join(mkdtempSync(join(tmpdir(), "break-glass-")), "r");
  const coordinator = createCoordinator({
    ...f.options,
    env: {
      ...env,
      ...dispatchEnv,
      BREAK_GLASS: "1",
      HANDOFF_QUIET_OVERRIDE: "1",
      BREAK_GLASS_MANIFEST_SHA256: manifestHash(f),
      BREAK_GLASS_RECORD_PATH: recordPath,
      ...extra,
    },
    warn: () => undefined,
  });
  return { coordinator, recordPath };
}
/** Operations after `from` that write anything to production. */
const writesSince = (f: Fixture, from: number) =>
  f.calls.slice(from).filter((call) => WRITES.includes(call.operation));
/** A legacy fixture whose source row was replaced by the protocol runtime's own. */
function modernFixture() {
  const f = legacyFixture();
  f.state.artifacts.set("old", fixture().state.artifacts.get("old")!);
  return f;
}

test("a legacy break-glass deploy records its audit item before any production mutation", async () => {
  const f = legacyFixture();
  await f.attest();
  const from = f.calls.length;
  const { coordinator, recordPath } = breakGlass(f);
  await expect(coordinator.prepare()).resolves.toEqual({ kind: "warming" });
  expect(writesSince(f, from)[0].operation).toBe("put-item");
  const record = f.state.audits.get("BREAK_GLASS#run-2");
  expect(record).toEqual({
    pk: "ENV",
    sk: "BREAK_GLASS#run-2",
    recordType: "break_glass",
    schemaVersion: 1,
    runToken: "run-2",
    runId: "41521247472",
    runAttempt: "1",
    commitSha: dispatchEnv.GITHUB_SHA,
    actor: "BASIC-BIT",
    triggeringActor: "BASIC-BIT",
    reason: "voice leave fix",
    manifestSha256: manifestHash(f),
    manifestUri: env.ATTESTATION_MANIFEST_URI,
    attestationKind: "operator_attested_legacy",
    attestationExpiresAt: 1000 + 6 * 60 * 60,
    sourceInstanceId: "old",
    sourceTaskId: "old",
    skippedChecks: [
      "ci",
      "deploy_docs",
      "handoff_quiet_wait",
      "runtime_preservation_seal",
    ],
    recordedAt: 1000,
  });
  expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual({
    sk: "BREAK_GLASS#run-2",
    commitSha: dispatchEnv.GITHUB_SHA,
    actor: "BASIC-BIT",
    triggeringActor: "BASIC-BIT",
    reason: "voice leave fix",
    manifestSha256: manifestHash(f),
    skippedChecks: record?.skippedChecks,
    recordedAt: 1000,
  });
  expect(f.state.artifacts.get("old")?.state).toBe("consumed");
  expect(f.state.launched).toBe(true);
});

test.each([
  ["absent", () => undefined, /no operator attestation/],
  [
    "mismatched",
    () => ({ BREAK_GLASS_MANIFEST_SHA256: "0".repeat(64) }),
    /does not match/,
  ],
  [
    "expiring",
    (f: Fixture) => {
      f.state.artifacts.get("old")!.attestation!.expiresAt = 1200;
    },
    /expires within five minutes/,
  ],
  [
    "bound to another source task",
    (f: Fixture) => {
      f.state.artifacts.get("old")!.attestation!.taskId = "other";
    },
    /another source task/,
  ],
  [
    "dispatched by someone else",
    () => ({ GITHUB_TRIGGERING_ACTOR: "someone" }),
    /Only BASIC-BIT/,
  ],
])(
  "an attestation %s refuses before Control or the service is written",
  async (reason, change, message) => {
    const f = legacyFixture();
    if (reason !== "absent") await f.attest();
    const extra = change(f) ?? {};
    const from = f.calls.length;
    await expect(breakGlass(f, extra).coordinator.prepare()).rejects.toThrow(
      message,
    );
    expect(writesSince(f, from)).toEqual([]);
    expect(f.state.ctl.deployment).toBeUndefined();
    expect(f.state.audits.size).toBe(0);
  },
);

test("the standard path never sets break-glass and writes no audit item", async () => {
  const f = legacyFixture();
  await f.attest();
  await expect(f.coordinator.prepare()).resolves.toEqual({ kind: "warming" });
  expect(f.state.audits.size).toBe(0);
  expect(f.calls.some((call) => call.operation === "put-item")).toBe(false);
});

test("break-glass may replace a settled protocol runtime row with an attestation", async () => {
  const f = modernFixture();
  await expect(
    f.attest({ ATTESTATION_BREAK_GLASS: "1" }),
  ).resolves.toMatchObject({ kind: "attested", instanceId: "old" });
  expect(f.state.artifacts.get("old")).toMatchObject({
    state: "attested_legacy",
    revision: 1,
    startup: { kind: "pending" },
    attestation: { kind: "operator_attested_break_glass", taskId: "old" },
  });
  const { coordinator } = breakGlass(f);
  await expect(coordinator.prepare()).resolves.toEqual({ kind: "warming" });
  expect(f.state.artifacts.get("old")?.state).toBe("consumed");
  expect(f.state.audits.get("BREAK_GLASS#run-2")).toMatchObject({
    attestationKind: "operator_attested_break_glass",
  });
});

test("a protocol runtime mid-preparation cannot be replaced", async () => {
  const f = modernFixture();
  const row = f.state.artifacts.get("old")!;
  f.state.artifacts.set("old", {
    ...row,
    state: "draining",
    activeProducers: 1,
    request: {
      source: oldIdentity,
      coordinatorToken: "previous",
      coordinatorEpoch: 1,
      servingGeneration: 1,
      requestedAt: 1000,
      expiresAt: 1300,
    },
  } as artifactTypes.ArtifactSafetyRecord);
  await expect(f.attest({ ATTESTATION_BREAK_GLASS: "1" })).rejects.toThrow(
    /Runtime preservation is in progress/,
  );
  expect(f.writes()).toBe(0);
});

test("a standard deploy refuses a break-glass attestation before taking Control", async () => {
  const f = modernFixture();
  await f.attest({ ATTESTATION_BREAK_GLASS: "1" });
  const from = f.calls.length;
  await expect(f.coordinator.prepare()).rejects.toThrow(
    /consumed only by a break-glass deployment/,
  );
  expect(writesSince(f, from)).toEqual([]);
  expect(f.state.ctl.deployment).toBeUndefined();
  expect(f.state.artifacts.get("old")?.state).toBe("attested_legacy");
});

test("a preparation stuck on a blocked runtime closes from a break-glass attestation", async () => {
  const f = modernFixture();
  await expect(f.coordinator.prepare()).rejects.toThrow(/expired/);
  const stuck = f.state.artifacts.get("old")!;
  expect(stuck.state).toBe("requested");
  f.state.artifacts.set("old", {
    ...stuck,
    state: "blocked",
    reason: "preservation_incomplete",
  } as artifactTypes.ArtifactSafetyRecord);
  await f.attest({ ATTESTATION_BREAK_GLASS: "1" });
  f.state.ctl.coordinatorExpiresAt = 0;
  await expect(f.coordinator.cancelPreparation()).resolves.toEqual({
    kind: "cancelled",
  });
  expect(f.state.ctl.deployment?.phase).toBe("complete");
  expect(f.state.artifacts.get("old")).toMatchObject({
    state: "attested_legacy",
    attestation: { kind: "operator_attested_break_glass" },
  });
});

/** Direct admission whose audit put loses its response while `stored` is in the table. */
function persistence(stored?: Record<string, unknown>) {
  const f = legacyFixture();
  const puts: Record<string, unknown>[] = [];
  const aws = jest.fn(
    async (_service: string, operation: string, input: unknown) => {
      if (operation === "get-item")
        return stored ? { Item: marshall(stored) } : {};
      puts.push(unmarshall((input as { Item: never }).Item));
      if (stored !== undefined) throw new Error("response lost");
      return {};
    },
  );
  const row = {
    identity: oldIdentity,
    state: "attested_legacy",
    attestation: {
      ...attestation,
      manifestSha256: dispatchEnv.BREAK_GLASS_MANIFEST_SHA256,
    },
  };
  const admission = createBreakGlass({
    env: { ...dispatchEnv, BREAK_GLASS: "1", DEPLOYMENT_RUN_TOKEN: "run-2" },
    aws,
    tables: { deploymentControl: "control" },
    now: () => 1000,
    types: artifactTypes,
    legacy: legacyArtifactBuilders,
    runtime: async () => f.state.rows.old,
    lookup: async () => row,
  });
  return { admit: () => admission.admit(oldIdentity), puts };
}

test("a lost audit write response is accepted only when the stored item matches", async () => {
  const written = persistence();
  const record = await written.admit();
  expect(written.puts).toEqual([record]);
  await expect(
    persistence({ ...record, recordedAt: 999 }).admit(),
  ).resolves.toEqual(record);
  await expect(
    persistence({ ...record, reason: "another run" }).admit(),
  ).rejects.toThrow("response lost");
  await expect(persistence({}).admit()).rejects.toThrow("response lost");
});

test("without break-glass, admission only reads the outgoing row", async () => {
  const aws = jest.fn();
  const lookup = jest.fn(async () => undefined);
  const admission = createBreakGlass({ env: {}, aws, lookup } as never);
  await expect(admission.admit(oldIdentity)).resolves.toBeUndefined();
  expect(lookup).toHaveBeenCalledWith(oldIdentity);
  expect(aws).not.toHaveBeenCalled();
});
