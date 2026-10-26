/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { evidenceFixture } from "../fixtures/deployment/productionIntroduction.js";
import { createEvidenceCollector } from "../../scripts/deployment/production-evidence.cjs";

function legacyContext(m) {
  return {
    predecessorSha256: null,
    taskArn: m.legacyTaskArn,
    taskDefinition: m.legacyTaskDefinition,
    sourceSha: m.binding.legacySha,
    owned: true,
  };
}
function corruptObservation(fault, proof, firstRequest) {
  const mutations = {
    owner: () => {
      proof.owners = ["other"];
    },
    policy: () => {
      proof.policies.unrelatedSha256 = "0".repeat(64);
    },
    controller: () => {
      proof.controllers = ["unsupported"];
    },
    task: () => {
      proof.tasks[0].taskArn += "0";
    },
    stale: () => {
      proof.validUntil = 999;
    },
    foreign: () => {
      proof.request = { ...proof.request, operationId: "foreign" };
    },
    nonce: () => {
      proof.request = firstRequest;
    },
    effects: () => {
      proof.effectsEvidenceSha256 = null;
    },
  };
  mutations[fault]();
}

test("two complete independent rounds retain page chains and fresh nonces", async () => {
  const f = evidenceFixture(),
    e = createEvidenceCollector(f.options);
  const result = await e.drain(legacyContext(f.m));
  expect(f.calls.filter((x) => x === "scan")).toHaveLength(16);
  expect(f.proofs).toHaveLength(2);
  expect(f.proofs[0].request.nonce).not.toBe(f.proofs[1].request.nonce);
  expect(result.rounds[0].snapshot.scans.leases.pages).toHaveLength(1);
  expect(result.revisionBefore).toBe(result.revisionAfter);
});
test.each([
  ["owner", /Observation state changed/],
  ["policy", /Original policy changed/],
  ["controller", /Unsupported controller/],
  ["task", /taskArn/],
  ["stale", /Stale observation/],
  ["foreign", /Foreign or reused observation/],
  ["nonce", /Foreign or reused observation/],
  ["effects", /string/],
])("rejects %s observation", async (fault, message) => {
  const f = evidenceFixture(),
    original = f.options.probe;
  f.options.probe = async (request) => {
    const proof = await original(request);
    if (f.proofs.length === 2)
      corruptObservation(fault, proof, f.proofs[0].request);
    return proof;
  };
  Object.assign(f.options.probe, original);
  await expect(
    createEvidenceCollector(f.options).drain(legacyContext(f.m)),
  ).rejects.toThrow(message);
  expect(f.proofs).toHaveLength(2);
  expect(f.calls).toEqual([
    ...Array(8).fill("scan"),
    "collect",
    ...Array(8).fill("scan"),
    "collect",
  ]);
});

test.each(["missing", "namespace", "hash", "unavailable", "changed"])(
  "refuses %s durable capture before evidence acceptance",
  async (fault) => {
    const f = evidenceFixture();
    if (fault === "missing") delete f.options.probe.capture;
    if (fault === "namespace") {
      const capture = f.options.probe.capture;
      f.options.probe.capture = async (value) => ({
        ...(await capture(value)),
        namespace: "foreign",
      });
    }
    if (fault === "hash") {
      const capture = f.options.probe.capture;
      f.options.probe.capture = async (value) => ({
        ...(await capture(value)),
        sha256: "0".repeat(64),
      });
    }
    if (fault === "unavailable")
      f.options.probe.readCapture = async () => {
        throw new Error("Unavailable");
      };
    if (fault === "changed") f.options.probe.readCapture = async () => ({});
    await expect(
      createEvidenceCollector(f.options).drain(legacyContext(f.m)),
    ).rejects.toThrow();
  },
);

test("stopped handoff requires unexpired actual earlier principal proof", async () => {
  const f = evidenceFixture(),
    collector = createEvidenceCollector(f.options);
  const context = legacyContext(f.m);
  const before = await collector.round(context),
    original = f.options.probe;
  const stoppedProbe = async (request) => {
    const proof = await original(request);
    proof.tasks[0].lastStatus = "STOPPED";
    proof.owners = [];
    proof.probes = null;
    return proof;
  };
  stoppedProbe.capture = original.capture;
  stoppedProbe.readCapture = original.readCapture;
  const stopped = createEvidenceCollector({
    ...f.options,
    probe: stoppedProbe,
  });
  await expect(
    stopped.drain({ ...context, stopped: true, priorCapture: before.capture }),
  ).resolves.toBeDefined();
  await expect(stopped.drain({ ...context, stopped: true })).rejects.toThrow();
  await expect(
    createEvidenceCollector({
      ...f.options,
      probe: stoppedProbe,
      now: () => 1060,
    }).drain({ ...context, stopped: true, priorCapture: before.capture }),
  ).rejects.toThrow();
});

test("snapshot row changes across complete rounds block drain", async () => {
  const f = evidenceFixture();
  let scans = 0;
  f.options.aws = async () => ({
    Items:
      ++scans === 16
        ? [
            {
              TransactionID: { S: "id" },
              transactionID: { S: "id" },
              status: { S: "paid" },
              paymentDate: { S: "2026-01-01T00:00:00Z" },
            },
          ]
        : [],
  });
  await expect(
    createEvidenceCollector(f.options).drain(legacyContext(f.m)),
  ).rejects.toThrow();
});
test("oversized capture reference is rejected", async () => {
  const f = evidenceFixture(),
    capture = f.options.probe.capture;
  f.options.probe.capture = async (value) => ({
    ...(await capture(value)),
    key: "x".repeat(20000),
  });
  await expect(
    createEvidenceCollector(f.options).round(legacyContext(f.m)),
  ).rejects.toThrow();
});
