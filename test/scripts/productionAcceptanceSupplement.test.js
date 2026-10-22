/** @jest-environment node */
import { supplementIdentity } from "../fixtures/productionAcceptance.js";
import { test, expect, jest, afterEach } from "@jest/globals";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import { bound } from "../fixtures/productionManifest.js";
import { frozenFixtureDefinitions } from "../../scripts/deployment/production-fixture-definitions.cjs";
import {
  verifySupplement,
  readPinnedSupplement,
} from "../../scripts/deployment/production-acceptance-supplement.cjs";
const mockGithub = jest.fn();
jest.mock("../../scripts/deployment/production-private-package.cjs", () => ({
  githubJson: (...args) => mockGithub(...args),
}));
afterEach(() => mockGithub.mockReset());
function fixture() {
  const binding = bound(completeManifest()),
    m = binding.manifest;
  const object = {
    key: "recordings/generated/object",
    versionId: "version",
    checksumSha256: "b".repeat(64),
    byteLength: 12,
  };
  const value = {
    ...supplementIdentity(binding, 140000),
    fixtures: m.handoff.grants.map((g, index) => ({
      grantId: g.grantId,
      commandId: g.commandId,
      meetingId: g.meetingId,
      ownerInstanceId: "owner",
      executionVersion: 1,
      voiceOperationAttemptId: "voice-attempt",
      historyKey: { guildId: g.guildId, channelId_timestamp: "voice#time" },
      transcript: object,
      manifest: object,
      notes: {
        version: 1,
        checksumSha256: "c".repeat(64),
        byteLength: 12,
        channelId: g.textChannelId,
        messageIds: ["message"],
      },
      scriptSha256: g.scriptSha256,
      checklistSha256: g.checklistSha256,
      scriptFidelity: "pass",
      ambientInputAbsent: "pass",
      items: frozenFixtureDefinitions().fixtures[index].checklist.map(
        (_, i) => ({ index: i, transcript: "pass", notes: "pass" }),
      ),
    })),
  };
  return { binding, value };
}
test("item-level manual results bind both exact fixture outputs to the actual gate reviewer", () => {
  const { binding, value } = fixture();
  expect(verifySupplement(value, binding, ["7"], 150)).toEqual(value);
  expect(() => verifySupplement(value, binding, ["8"], 150)).toThrow();
  expect(() => verifySupplement(value, binding, [], 150)).toThrow();
  for (const change of [
    (v) => {
      v.runId = "copied-run";
    },
    (v) => {
      v.sourceCommit = "d".repeat(40);
    },
    (v) => {
      v.fixtures.pop();
    },
    (v) => {
      v.fixtures[0].items.pop();
    },
    (v) => {
      v.fixtures[0].items[0].notes = "fail";
    },
    (v) => {
      v.fixtures[0].items[1].index = 0;
    },
    (v) => {
      v.fixtures[0].notes.channelId = "other";
    },
    (v) => {
      v.fixtures[0].notes.version = 2;
    },
    (v) => {
      v.fixtures[0].transcript.versionId = "null";
    },
    (v) => {
      v.fixtures[0].meetingId = "customer";
    },
    (v) => {
      v.reviewedAt = new Date(151000).toISOString();
    },
    (v) => {
      v.action = "extend-authority";
    },
  ]) {
    const changed = structuredClone(value);
    change(changed);
    expect(() => verifySupplement(changed, binding, ["7"], 150)).toThrow();
  }
});
test("preparation resolves selector once, final acceptance consumes only the exact pinned bytes", async () => {
  const { binding, value } = fixture(),
    bytes = Buffer.from(JSON.stringify(value)),
    commit = "c".repeat(40);
  const file = {
    type: "file",
    path: binding.manifest.acceptance.supplementPath,
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64"),
  };
  mockGithub.mockResolvedValueOnce({ sha: commit }).mockResolvedValueOnce(file);
  const prepared = await readPinnedSupplement(
    binding,
    { INTRODUCTION_OPS_READ_TOKEN: "dummy" },
    "prepare-acceptance",
  );
  expect(prepared.supplementHash).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  const env = {
    INTRODUCTION_OPS_READ_TOKEN: "dummy",
    INTRODUCTION_SUPPLEMENT_COMMIT: commit,
    INTRODUCTION_SUPPLEMENT_HASH: prepared.supplementHash,
  };
  mockGithub.mockReset().mockResolvedValue(file);
  expect(await readPinnedSupplement(binding, env, "accept")).toEqual(prepared);
  expect(mockGithub).toHaveBeenCalledTimes(1);
  expect(mockGithub.mock.calls[0][0]).toContain(`?ref=${commit}`);
  await expect(
    readPinnedSupplement(
      binding,
      { ...env, INTRODUCTION_SUPPLEMENT_HASH: "d".repeat(64) },
      "accept",
    ),
  ).rejects.toThrow();
  mockGithub.mockResolvedValue({ ...file, size: 262145 });
  await expect(readPinnedSupplement(binding, env, "accept")).rejects.toThrow();
});
