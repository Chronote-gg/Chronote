/** @jest-environment node */
import process from "node:process";
import { test, expect, jest, afterEach } from "@jest/globals";
import { runCli } from "../../scripts/deployment/accept-production.cjs";
const mockAppend = jest.fn(),
  mockPrepare = jest.fn();
jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  appendFileSync: (...args) => mockAppend(...args),
}));
jest.mock(
  "../../scripts/deployment/production-acceptance-supplement.cjs",
  () => ({ waitForSupplementFromOriginalRun: async () => undefined }),
);
jest.mock(
  "../../scripts/deployment/production-acceptance-collector.cjs",
  () => ({
    waitForPreparedAcceptance: () => mockPrepare(),
    acceptanceSummary: (value) => value,
  }),
);
afterEach(() => {
  jest.restoreAllMocks();
  mockAppend.mockReset();
  mockPrepare.mockReset();
});
function prepare() {
  jest.replaceProperty(process, "env", {
    ...process.env,
    GITHUB_JOB: "prepare-acceptance",
    GITHUB_OUTPUT: "outputs",
    GITHUB_STEP_SUMMARY: "summary",
  });
  return { log: jest.fn(), error: jest.fn() };
}
test("approval summary has bounded fingerprints only and preserves the two trusted outputs", async () => {
  const output = prepare();
  mockPrepare.mockResolvedValue({
    status: "prepared",
    retainedWorkClassification: "UNVERIFIED",
    supplementCommit: "a".repeat(40),
    supplementHash: "b".repeat(64),
    fixtureFingerprints: [
      { index: 1, fingerprint: "c".repeat(16) },
      { index: 2, fingerprint: "d".repeat(16) },
    ],
  });
  expect(await runCli(output)).toBe(0);
  expect(mockAppend.mock.calls[0]).toEqual([
    "outputs",
    `supplement_commit=${"a".repeat(40)}\nsupplement_hash=${"b".repeat(64)}\n`,
  ]);
  const summary = mockAppend.mock.calls[1][1];
  expect(summary).toContain("Fixture 1: " + "c".repeat(16));
  expect(summary).toContain("UNVERIFIED");
  expect(summary).not.toMatch(/https:|grantId|meetingId|a{13}|b{17}/);
  expect(output.log).toHaveBeenCalledWith(
    JSON.stringify({
      status: "prepared",
      retainedWorkClassification: "UNVERIFIED",
    }),
  );
});
test.each([
  "acceptance_capacity_refused",
  "private-policy-and-meeting-identifier",
])("CLI refuses with bounded public code: %s", async (message) => {
  const output = prepare();
  mockPrepare.mockRejectedValue(Error(message));
  expect(await runCli(output)).toBe(1);
  expect(mockAppend).not.toHaveBeenCalled();
  expect(JSON.parse(output.error.mock.calls[0][0])).toEqual({
    status: "refused",
    reason:
      message === "acceptance_capacity_refused"
        ? message
        : "acceptance_prerequisite_or_recovery_required",
    admission: "preserve",
    deployment: "preserve",
  });
});
