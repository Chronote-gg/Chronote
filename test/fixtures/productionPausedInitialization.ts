export function pausedInitializationFixture(
  binding = { operationId: "op", manifestHash: "d".repeat(64) },
  withSegments = false,
) {
  const parents = ["one", "two"].map((uploadId) => ({
    uploadId,
    ownerUserId: "owner",
    status: "pending_upload",
    mediaKind: "audio",
    uploadOrigin: "desktop_recording",
    sourceS3Key: `${uploadId}/`,
    sourceManifest: [{ sourceId: "mic", kind: "owner_mic" }],
    contentType: "audio/wav",
    fileSize: 0,
    createdAt: "before",
    updatedAt: "before",
    segmentCount: withSegments ? 1 : 0,
    uploadedSegmentCount: withSegments ? 1 : 0,
  }));
  const segments = withSegments
    ? parents.map((parent) => ({
        uploadId: parent.uploadId,
        ownerUserId: parent.ownerUserId,
        segmentKey: "mic#000000",
        sourceId: "mic",
        sequence: 0,
        kind: "owner_mic",
        sourceS3Key: `${parent.uploadId}/0`,
        contentType: "audio/wav",
        fileSize: 10,
        checksumSha256: "a".repeat(64),
        durationMillis: 5,
        startedAt: "before",
        endedAt: "before",
        status: "uploaded",
        createdAt: "before",
        updatedAt: "before",
      }))
    : [];
  return {
    cohortSha256: "a".repeat(64),
    captureSha256: "b".repeat(64),
    policyScopeSha256: "c".repeat(64),
    parents,
    segments,
    markers: parents.map((row) => ({
      pk: `UPLOAD#${row.uploadId}`,
      sk: "PAUSED_DRAFT",
      recordType: "paused_desktop_draft",
      protocolVersion: 1,
      uploadId: row.uploadId,
      ownerUserId: row.ownerUserId,
      operationId: binding.operationId,
      manifestSha256: binding.manifestHash,
      preservedCaptureSha256: "b".repeat(64),
      createdAt: 150,
    })),
  };
}
