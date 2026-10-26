/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { closingActions } from "../fixtures/productionAcceptance.js";
import { fixture } from "../fixtures/productionManifest.js";
import {
  canonicalHash,
  parseExecution,
} from "../../scripts/deployment/production-manifest.cjs";

function acceptanceManifest() {
  const m = fixture();
  m.acceptance = {
    supplementRepository: "Chronote-gg/chronote-ops",
    supplementPath: "production-introductions/intro/acceptance.json",
    selectorRef: "refs/heads/acceptance-intro",
    schemaVersion: 1,
    manualReviewerIds: ["123"],
    gatePolicy: {
      environmentId: "321",
      environmentHash: "1".repeat(64),
      branchPolicyHash: "2".repeat(64),
      reviewerIds: ["123"],
    },
    collectorRoleArn: "arn:aws:iam::123456789012:role/acceptance-reader",
    storageKeyArn:
      "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555",
    prepareDeadline: 190,
  };
  m.actions.push(...closingActions());
  return m;
}

test("one immutable late supplement slot binds exactly three ordered final actions", () => {
  const m = acceptanceManifest();
  expect(parseExecution(m, canonicalHash(m)).acceptance).toEqual(m.acceptance);
  for (const change of [
    (v) => {
      v.acceptance.prepareDeadline = v.validUntil + 1;
    },
    (v) => {
      v.acceptance.supplementPath =
        "production-introductions/intro/../other.json";
    },
    (v) => {
      v.acceptance.supplementRepository = "other/repo";
    },
    (v) => {
      v.acceptance.collectorRoleArn = v.identity.roleArn;
    },
    (v) => {
      v.acceptance.gatePolicy.reviewerIds = ["999"];
    },
    (v) => {
      v.actions.at(-1).predecessor = "acceptance";
    },
    (v) => {
      v.actions.pop();
    },
    (v) => {
      delete v.acceptance;
    },
    (v) => {
      v.actions.at(-1).purpose = "launch";
    },
  ]) {
    const altered = structuredClone(m);
    change(altered);
    expect(() => parseExecution(altered, canonicalHash(altered))).toThrow();
  }
});
