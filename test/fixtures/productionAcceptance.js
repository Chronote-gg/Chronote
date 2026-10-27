export function acceptanceDeclaration() {
  return {
    supplementRepository: "Chronote-gg/chronote-ops",
    supplementPath: "production-introductions/reviewed/acceptance.json",
    selectorRef: "refs/heads/acceptance-reviewed",
    schemaVersion: 1,
    manualReviewerIds: ["7"],
    gatePolicy: {
      environmentId: "3",
      environmentHash: "1".repeat(64),
      branchPolicyHash: "2".repeat(64),
      reviewerIds: ["7"],
    },
    collectorRoleArn: "arn:aws:iam::123456789012:role/acceptance-reader",
    storageKeyArn:
      "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555",
    prepareDeadline: 14100,
  };
}
export function closingActions() {
  return [
    {
      kind: "acceptance_write",
      actionId: "acceptance",
      purpose: "persist_acceptance",
      predecessor: null,
    },
    {
      kind: "acceptance_write",
      actionId: "reopen",
      purpose: "reopen_admission",
      predecessor: "acceptance",
    },
    {
      kind: "acceptance_write",
      actionId: "release",
      purpose: "release_deployment",
      predecessor: "reopen",
    },
  ];
}

export function supplementIdentity(binding, reviewedAt) {
  const m = binding.manifest;
  return {
    schemaVersion: 1,
    introductionId: m.introductionId,
    holdId: m.holdId,
    holdRevision: 1,
    manifestHash: binding.manifestHash,
    runId: m.identity.runId,
    runAttempt: "1",
    sourceCommit: m.identity.sourceCommit,
    reviewedAt: new Date(reviewedAt).toISOString(),
    reviewerId: "7",
  };
}
