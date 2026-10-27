/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import { bound } from "../fixtures/productionManifest.js";
import { authorityFor } from "../../scripts/deployment/introduction-hold.cjs";
import { readOriginalPausedInstallation } from "../../scripts/deployment/production-actions.cjs";

test("installation authority refuses unissued values and marker-shaped substitutes", () => {
  for (const value of [
    {},
    { verified: true },
    { phase: "observed" },
    { markers: [{ pk: "UPLOAD#one", sk: "PAUSED_DRAFT" }] },
  ]) {
    expect(() => readOriginalPausedInstallation(value, {})).toThrow(
      "paused_installation_journal_prerequisite",
    );
  }
});

test("only initialize intent binds all three preservation digests", () => {
  const binding = bound(completeManifest());
  const digests = {
    cohortSha256: "a".repeat(64),
    captureSha256: "b".repeat(64),
    policyScopeSha256: "c".repeat(64),
  };
  const baseline = authorityFor(binding, digests);
  const initialize = binding.manifest.actions.find(
    (action) =>
      action.kind === "introduction_write" && action.purpose === "initialize",
  );
  expect(initialize).toBeDefined();
  for (const field of Object.keys(digests)) {
    const changed = authorityFor(binding, {
      ...digests,
      [field]: "d".repeat(64),
    });
    for (const action of binding.manifest.actions) {
      if (action.actionId === initialize.actionId)
        expect(changed.actions[action.actionId].intentHash).not.toBe(
          baseline.actions[action.actionId].intentHash,
        );
      else
        expect(changed.actions[action.actionId]).toEqual(
          baseline.actions[action.actionId],
        );
    }
  }
  expect(() => authorityFor(binding, { ...digests, ignored: true })).toThrow();
});
