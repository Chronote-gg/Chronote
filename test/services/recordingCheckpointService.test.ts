/** @jest-environment node */

jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { recoveryDispositionSchema } from "../../src/types/recordingCheckpoint";

import { type RecordingCheckpointMeeting } from "../../src/services/recordingCheckpointService";
import { history } from "../deployment/controlFixtures";

import {
  capture,
  bytes,
  digest,
  segment,
  ownership,
  fixture,
  input,
} from "../fixtures/recordingCheckpoint";

test("uploadBeforeManifestPublish", async () => {
  const f = fixture();
  f.upload.mockImplementationOnce(async () => undefined);
  await expect(f.service.flush(input)).resolves.toMatchObject({
    kind: "preservation_failed",
  });
  expect(
    (await f.repository.getMeetingHistory(history))?.checkpoint,
  ).toBeUndefined();
});
test("duplicateSegmentIsIdempotent", async () => {
  const f = fixture();
  const first = await f.service.flush(input);
  expect(first.kind).toBe("committed");
  if (first.kind !== "committed") throw new Error("fixture commit failed");
  const second = await f.service.flush({
    ...input,
    previous: first.checkpoint,
  });
  expect(second).toEqual(first);
  const verified = await f.service.read(first.checkpoint);
  expect(verified.manifest.artifacts).toHaveLength(1);
  expect(first.checkpoint.capture.captureStartedAt).toBe(
    capture.captureStartedAt,
  );
});
test("checksumMismatchIsRejected", async () => {
  const f = fixture();
  await expect(
    f.service.flush({
      ...input,
      artifacts: [{ ...segment, checksumSha256: "0".repeat(64) }],
    }),
  ).rejects.toThrow("checksum");
  expect(f.upload).not.toHaveBeenCalled();
});
test("staleOwnerCannotPublishManifest", async () => {
  const f = fixture();
  const row = f.histories.get(history.guildId)![0];
  row.ownerInstanceId = "recovery";
  row.executionVersion = 2;
  expect((await f.service.flush(input)).kind).toBe("stale_owner");
  expect(row.checkpoint).toBeUndefined();
});
test("confirmedCoverageExcludesMissingObjects", async () => {
  const f = fixture();
  const result = await f.service.flush(input);
  if (result.kind !== "committed") throw new Error("fixture commit failed");
  const verified = await f.service.read(result.checkpoint);
  f.objects.delete(verified.manifest.artifacts[0].object.key);
  const missing = await f.service.read(result.checkpoint);
  expect(missing.audioCoverage).toEqual({ kind: "known", intervals: [] });
  expect(missing.missing).toHaveLength(1);
});
test("durableTranscriptionReferenceIsVerified independently of surviving audio and recovery owner", async () => {
  const f = fixture();
  const result = await f.service.flush({
    ...input,
    artifacts: [
      segment,
      { ...segment, kind: "transcription", contentType: "application/json" },
    ],
  });
  if (result.kind !== "committed") throw new Error("fixture commit failed");
  const verified = await f.service.read(result.checkpoint);
  f.objects.delete(verified.manifest.artifacts[0].object.key);
  const row = f.histories.get(history.guildId)![0];
  row.ownerInstanceId = "recovery";
  row.executionVersion = 2;
  const recovered = await f.service.read(result.checkpoint);
  expect(recovered.verified.map((item) => item.kind)).toEqual([
    "transcription",
  ]);
  expect(recovered.manifest.capture.executionVersion).toBe(1);
  f.objects.set(recovered.verified[0].object.key, Buffer.from("corrupt"));
  expect((await f.service.read(result.checkpoint)).verified).toHaveLength(0);
});
test("unknown coverage remains unknown and invalid intervals cannot publish", async () => {
  const f = fixture();
  const result = await f.service.flush({
    ...input,
    capture: { ...capture, captureStartedAt: null },
    artifacts: [{ ...segment, coverage: { kind: "unknown" } }],
  });
  if (result.kind !== "committed") throw new Error("fixture commit failed");
  expect((await f.service.read(result.checkpoint)).audioCoverage).toEqual({
    kind: "unknown",
  });
  await expect(
    f.service.flush({
      ...input,
      artifacts: [
        {
          ...segment,
          coverage: {
            kind: "known",
            intervals: [
              { sourceId: "speaker", startOffsetMs: -1, durationMs: 1 },
            ],
          },
        },
      ],
    }),
  ).rejects.toThrow();
});

test("conflicting segment checksum or interval cannot replace a committed identity", async () => {
  const f = fixture();
  const first = await f.service.flush(input);
  if (first.kind !== "committed") throw new Error("fixture commit failed");
  const other = Buffer.alloc(96000, 1);
  for (const replacement of [
    { ...segment, bytes: other, checksumSha256: digest(other) },
    {
      ...segment,
      coverage: {
        kind: "known" as const,
        intervals: [
          { sourceId: "speaker", startOffsetMs: 1, durationMs: 1000 },
        ],
      },
    },
  ])
    await expect(
      f.service.flush({
        ...input,
        previous: first.checkpoint,
        artifacts: [replacement],
      }),
    ).rejects.toThrow("Conflicting");
  expect(
    (await f.service.read(first.checkpoint)).manifest.artifacts,
  ).toHaveLength(1);
});
test("manifest upload failure leaves canonical pointer unpublished", async () => {
  const f = fixture();
  f.upload.mockImplementation(async (key, body) => {
    if (key.includes("/manifests/")) return undefined;
    f.objects.set(key, Buffer.from(body));
    return key;
  });
  await expect(f.service.flush(input)).resolves.toMatchObject({
    kind: "preservation_failed",
  });
  expect(
    (await f.repository.getMeetingHistory(history))?.checkpoint,
  ).toBeUndefined();
  expect(f.objects.size).toBe(1);
});
test("aborting after upload prevents manifest publication", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.upload.mockImplementation(async (key, body) => {
    f.objects.set(key, Buffer.from(body));
    controller.abort();
    return key;
  });
  await expect(
    f.service.flush({ ...input, signal: controller.signal }),
  ).resolves.toMatchObject({ kind: "preservation_failed" });
  expect(
    (await f.repository.getMeetingHistory(history))?.checkpoint,
  ).toBeUndefined();
});
test("context is independently verified and text retains its own source coverage", async () => {
  const f = fixture();
  const contextBytes = Buffer.from(
    JSON.stringify({ serverContext: "generated context", participants: [] }),
  );
  const result = await f.service.flush({
    ...input,
    artifacts: [
      segment,
      { ...segment, kind: "transcription", contentType: "text/plain" },
      {
        ...segment,
        kind: "context",
        contentType: "application/json",
        bytes: contextBytes,
        checksumSha256: digest(contextBytes),
        coverage: { kind: "unknown" },
      },
    ],
  });
  if (result.kind !== "committed") throw new Error("fixture commit failed");
  const first = await f.service.read(result.checkpoint);
  f.objects.delete(first.manifest.artifacts[0].object.key);
  const surviving = await f.service.read(result.checkpoint);
  expect(surviving.verified.map((artifact) => artifact.kind)).toEqual([
    "transcription",
    "context",
  ]);
  expect(surviving.verified[0].coverage).toEqual(segment.coverage);
  expect(surviving.verified[0]).not.toHaveProperty("timing");
  expect(
    await f.service.readVerifiedObject(surviving.verified[1].object),
  ).toEqual(contextBytes);
});
test("saved prefix remains readable when configured prefix changes", async () => {
  const f = fixture();
  const result = await f.service.flush(input);
  if (result.kind !== "committed") throw new Error("fixture commit failed");
  const { config } = await import("../../src/services/configService");
  const descriptor = Object.getOwnPropertyDescriptor(
    config.storage,
    "transcriptPrefix",
  );
  Object.defineProperty(config.storage, "transcriptPrefix", {
    configurable: true,
    get: () => "new-prefix/",
  });
  try {
    expect((await f.service.read(result.checkpoint)).verified).toHaveLength(1);
    const appended = await f.service.append({
      ...input,
      previous: result.checkpoint,
      artifact: { ...segment, sequence: 1 },
    });
    expect(appended.kind).toBe("committed");
    if (appended.kind === "committed")
      expect(appended.checkpoint.artifactFolder).toBe(
        result.checkpoint.artifactFolder,
      );
  } finally {
    if (descriptor)
      Object.defineProperty(config.storage, "transcriptPrefix", descriptor);
  }
});
test("capture identity, settings and reserved folder cannot be rewritten", async () => {
  const f = fixture();
  await expect(
    f.service.flush({
      ...input,
      capture: {
        ...capture,
        requested: { transcribeMeeting: false, generateNotes: true },
      },
    }),
  ).rejects.toThrow("settings");
  await expect(
    f.service.flush({
      ...input,
      capture: { ...capture, reservedAt: "2026-02-01T00:00:00Z" },
    }),
  ).rejects.toThrow("history");
  const first = await f.service.flush(input);
  if (first.kind !== "committed") throw new Error("fixture commit failed");
  await expect(
    f.service.flush({
      ...input,
      previous: first.checkpoint,
      capture: { ...capture, executionVersion: 2 },
    }),
  ).rejects.toThrow("capture changed");
  await expect(
    f.service.flush({
      ...input,
      previous: first.checkpoint,
      expectedStatus: "complete",
    }),
  ).resolves.toMatchObject({ kind: "stale_owner" });
});
test("corrupt manifest cannot provide text or audio proof", async () => {
  const f = fixture();
  const result = await f.service.flush(input);
  if (result.kind !== "committed") throw new Error("fixture commit failed");
  f.objects.set(
    result.checkpoint.manifest.key,
    Buffer.from("corrupt manifest"),
  );
  await expect(f.service.read(result.checkpoint)).rejects.toThrow("preserved");
});

test("verified coverage unions confirmed source intervals and records actual last confirmation", async () => {
  const f = fixture();
  const first = await f.service.flush(input);
  if (first.kind !== "committed") throw new Error("fixture commit failed");
  expect(first.coverage).toEqual({
    kind: "verified",
    intervals: segment.coverage.intervals,
    savedDurationMs: 1000,
    lastConfirmedCaptureAt: "2026-01-01T00:00:03.000Z",
  });
  const otherSource = {
    ...segment,
    sourceId: "second",
    coverage: {
      kind: "known" as const,
      intervals: [{ sourceId: "second", startOffsetMs: 500, durationMs: 1000 }],
    },
  };
  const second = await f.service.append({
    ...input,
    previous: first.checkpoint,
    artifact: otherSource,
  });
  if (second.kind !== "committed") throw new Error("fixture append failed");
  expect(second.coverage).toMatchObject({
    kind: "verified",
    savedDurationMs: 1500,
    lastConfirmedCaptureAt: "2026-01-01T00:00:03.500Z",
  });
});
test("unknown coverage has detection reason and never fabricates zero duration or stop time", async () => {
  const f = fixture();
  const result = await f.service.flush({
    ...input,
    capture: { ...capture, captureStartedAt: null },
  });
  expect(result.coverage).toMatchObject({
    kind: "unknown",
    reason: "capture_start_unknown",
    detectedAt: expect.any(String),
  });
  expect(result.coverage).not.toHaveProperty("savedDurationMs");
  expect(result.coverage).not.toHaveProperty("stoppedAt");
});
test("manifest records actual capture disposition separately from processing", async () => {
  const f = fixture();
  const state = {
    kind: "complete" as const,
    startedAt: capture.captureStartedAt!,
    endedAt: "2026-01-01T00:00:03.000Z",
  };
  const result = await f.service.flush({ ...input, captureState: state });
  if (result.kind !== "committed") throw new Error("fixture commit failed");
  const saved = await f.service.read(result.checkpoint);
  expect(saved.manifest.captureState).toEqual(state);
  expect(saved.coverage).toMatchObject({ stoppedAt: state.endedAt });
});

function meetingFixture(): RecordingCheckpointMeeting {
  return {
    meetingId: history.meetingId,
    guildId: history.guildId,
    voiceChannel: { id: history.channelId },
    ownershipSignal: new AbortController().signal,
    captureStartedAt: new Date(capture.captureStartedAt!),
    transcribeMeeting: true,
    generateNotes: true,
    reservation: {
      guildId: history.guildId,
      meetingId: history.meetingId,
      ownerInstanceId: "old",
      executionVersion: 1,
      voiceOperationAttemptId: "voice",
      reservedAt: Date.parse(history.timestamp),
      sessionMode: "meeting",
      historyKey: {
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
      },
      workHandle: {
        settle: jest.fn(),
        transition: jest.fn(),
        beginOwnedControl: () => ({ settle: jest.fn() }),
      },
    },
  };
}
const liveSegment = {
  sourceId: segment.sourceId,
  sequence: 0,
  startOffsetMs: 0,
  durationMs: 1000,
  format: segment.format,
  bytes,
  checksumSha256: digest(bytes),
};
test("named live adapter binds actual reservation and absent capture state cannot fabricate terminal capture", async () => {
  const f = fixture();
  const meeting = meetingFixture();
  const result = await f.service.appendRecordingCheckpoint(
    meeting,
    liveSegment,
  );
  expect(result.kind).toBe("committed");
  if (result.kind !== "committed") throw new Error("fixture commit failed");
  expect(result.checkpoint.capture.captureStartedAt).toBe(
    meeting.captureStartedAt?.toISOString(),
  );
  expect(
    (await f.service.read(result.checkpoint)).manifest.captureState,
  ).toEqual({ kind: "unknown" });
  expect(result.coverage).not.toHaveProperty("stoppedAt");
  expect(meeting.recordingCheckpoint).toEqual(result.checkpoint);
});
test("named live adapter refuses absent reservation, TTS and later recovery ownership", async () => {
  const f = fixture();
  const meeting = meetingFixture();
  await expect(
    f.service.appendRecordingCheckpoint(
      { ...meeting, reservation: undefined },
      liveSegment,
    ),
  ).resolves.toMatchObject({ kind: "preservation_failed" });
  const reservation = meeting.reservation!;
  await expect(
    f.service.appendRecordingCheckpoint(
      {
        ...meeting,
        reservation: {
          ...reservation,
          sessionMode: "tts_only",
          historyKey: undefined,
        },
      },
      liveSegment,
    ),
  ).resolves.toMatchObject({ kind: "preservation_failed" });
  f.histories.get(history.guildId)![0].executionVersion = 2;
  await expect(
    f.service.appendRecordingCheckpoint(meeting, liveSegment),
  ).resolves.toMatchObject({ kind: "stale_owner" });
  expect(f.upload).not.toHaveBeenCalled();
});
test("named live adapter passes actual owner cancellation through held preservation", async () => {
  const f = fixture();
  const controller = new AbortController();
  const meeting = { ...meetingFixture(), ownershipSignal: controller.signal };
  f.upload.mockImplementation(async (key, body) => {
    f.objects.set(key, Buffer.from(body));
    controller.abort();
    return key;
  });
  await expect(
    f.service.appendRecordingCheckpoint(meeting, liveSegment),
  ).resolves.toMatchObject({ kind: "preservation_failed" });
  expect(meeting.recordingCheckpoint).toBeUndefined();
  expect(
    (await f.repository.getMeetingHistory(history))?.checkpoint,
  ).toBeUndefined();
});
test("named flush without actual capture start reports unknown without reservation-time substitution", async () => {
  const f = fixture();
  const meeting = { ...meetingFixture(), captureStartedAt: undefined };
  const coverage = await f.service.flushRecordingCheckpoint(meeting, {
    signal: new AbortController().signal,
  });
  expect(coverage).toMatchObject({
    kind: "unknown",
    reason: "capture_start_unknown",
  });
  expect(coverage).not.toHaveProperty("savedDurationMs");
  expect(coverage).not.toHaveProperty("stoppedAt");
  expect(meeting.recordingCheckpoint?.capture.captureStartedAt).toBeNull();
});
test("recovery disposition requires bounded attempts/version/stage and preserves reconciliation", () => {
  const state = {
    disposition: "needs_reconciliation",
    attempt: 2,
    executionVersion: 1,
    stage: "verification",
    retry: { maxAttempts: 2, nextAttemptAt: null },
    reason: "retry_exhausted",
  };
  expect(recoveryDispositionSchema.parse(state)).toEqual(state);
  expect(
    recoveryDispositionSchema.safeParse({ ...state, attempt: 3 }).success,
  ).toBe(false);
  expect(
    recoveryDispositionSchema.safeParse({ disposition: "pending" }).success,
  ).toBe(false);
});

test("aborted publication acknowledgment cannot report committed", async () => {
  const f = fixture();
  const controller = new AbortController();
  const transition = f.repository.transitionMeetingHistory.bind(f.repository);
  jest
    .spyOn(f.repository, "transitionMeetingHistory")
    .mockImplementation(async (request) => {
      const result = await transition(request);
      controller.abort();
      return result;
    });
  const result = await f.service.flush({ ...input, signal: controller.signal });
  expect(result.kind).toBe("preservation_failed");
  // The write may have landed. Callers must retain work for reconciliation.
  expect(
    (await f.repository.getMeetingHistory(history))?.checkpoint,
  ).toBeDefined();
});

test.each(["append", "flush"] as const)(
  "%s preserves complete capture known only by the previous manifest",
  async (operation) => {
    const f = fixture();
    const complete = {
      kind: "complete" as const,
      startedAt: capture.captureStartedAt!,
      endedAt: "2026-01-01T00:00:03.000Z",
    };
    const first = await f.service.flush({ ...input, captureState: complete });
    if (first.kind !== "committed") throw new Error("fixture commit failed");
    expect(
      (await f.repository.getMeetingHistory(history))?.capture,
    ).toBeUndefined();
    for (const captureState of [
      {
        kind: "interrupted" as const,
        startedAt: complete.startedAt,
        endedAt: null,
        detectedAt: "2026-01-01T00:00:04.000Z",
      },
      { kind: "unknown" as const },
      { ...complete, endedAt: "2026-01-01T00:00:04.000Z" },
    ]) {
      const next = { ...input, previous: first.checkpoint, captureState };
      const result =
        operation === "append"
          ? await f.service.append({ ...next, artifact: segment })
          : await f.service.flush(next);
      expect(result.kind).toBe("preservation_failed");
      expect(
        (await f.repository.getMeetingHistory(history))?.checkpoint,
      ).toEqual(first.checkpoint);
    }
    const unchanged = await f.service.flush({
      ...input,
      previous: first.checkpoint,
    });
    expect(unchanged).toEqual(first);
    expect(
      (await f.service.read(first.checkpoint)).manifest.captureState,
    ).toEqual(complete);
  },
);

test("mock history read honors optional cancellation and preserves ordinary reads", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.repository.getMeetingHistory(history, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  await expect(f.repository.getMeetingHistory(history)).resolves.toEqual(
    history,
  );
});

test("producer session verifies new bytes only and recovery still detects old corruption", async () => {
  const f = fixture();
  const producer = f.service.createProducerSession();
  let previous;
  for (let sequence = 0; sequence < 12; sequence++) {
    const result = await producer.flush({
      ...input,
      ownership,
      signal: new AbortController().signal,
      previous,
      artifacts: [{ ...segment, sequence }],
    });
    if (result.kind !== "committed")
      throw new Error("Expected committed checkpoint");
    previous = result.checkpoint;
  }
  expect(
    f.read.mock.calls.filter(([key]) => key.includes("/audio/")).length,
  ).toBe(24);
  const saved = await f.service.read(previous!);
  f.objects.set(saved.manifest.artifacts[0].object.key, Buffer.from("corrupt"));
  const recovered = await f.service.read(previous!);
  expect(recovered.missing).toHaveLength(1);
  expect(recovered.verified).toHaveLength(11);
});

test("producer session refuses a changed pointer and cannot adopt later ownership", async () => {
  const f = fixture();
  const producer = f.service.createProducerSession();
  const first = await producer.flush({
    ...input,
    ownership,
    signal: new AbortController().signal,
  });
  if (first.kind !== "committed") throw new Error("Expected commit");
  expect(
    (
      await producer.flush({
        ...input,
        ownership,
        signal: new AbortController().signal,
        artifacts: [{ ...segment, sequence: 1 }],
      })
    ).kind,
  ).toBe("stale_owner");
  const row = f.histories.get(history.guildId)![0];
  row.executionVersion = 2;
  row.ownerInstanceId = "recovery";
  const next = await producer.flush({
    ...input,
    ownership,
    signal: new AbortController().signal,
    previous: first.checkpoint,
    capture: { ...capture, executionVersion: 2, ownerInstanceId: "recovery" },
    artifacts: [],
  });
  expect(next.kind).toBe("stale_owner");
});

test("producer late text retains complete capture and refuses changed end facts or owner", async () => {
  const f = fixture();
  const producer = f.service.createProducerSession();
  const complete = {
    kind: "complete" as const,
    startedAt: capture.captureStartedAt!,
    endedAt: "2026-01-01T00:00:03.000Z",
  };
  const first = await producer.flush({
    ...input,
    ownership,
    signal: new AbortController().signal,
    captureState: complete,
  });
  if (first.kind !== "committed") throw new Error("Expected capture commit");
  const text = Buffer.from("completed usable text");
  const artifact = {
    kind: "transcription" as const,
    sourceId: "transcription",
    sequence: 0,
    contentType: "application/json",
    bytes: text,
    checksumSha256: digest(text),
    coverage: { kind: "unknown" as const },
  };
  const second = await producer.flush({
    ...input,
    ownership,
    signal: new AbortController().signal,
    previous: first.checkpoint,
    captureState: complete,
    artifacts: [artifact],
  });
  if (second.kind !== "committed") throw new Error("Expected late text commit");
  expect(
    (await f.service.read(second.checkpoint)).manifest.captureState,
  ).toEqual(complete);
  expect(second.checkpoint.capture).toEqual(first.checkpoint.capture);
  expect(
    (
      await producer.flush({
        ...input,
        ownership,
        signal: new AbortController().signal,
        previous: second.checkpoint,
        captureState: { ...complete, endedAt: "2026-01-01T00:00:04.000Z" },
        artifacts: [],
      })
    ).kind,
  ).toBe("preservation_failed");
  const controller = new AbortController();
  controller.abort();
  expect(
    (
      await producer.flush({
        ...input,
        ownership,
        previous: second.checkpoint,
        artifacts: [],
        signal: controller.signal,
      })
    ).kind,
  ).toBe("preservation_failed");
  const row = f.histories.get(history.guildId)![0];
  row.ownerInstanceId = "recovery";
  row.executionVersion = 2;
  expect(
    (
      await producer.flush({
        ...input,
        ownership,
        signal: new AbortController().signal,
        previous: second.checkpoint,
        artifacts: [{ ...artifact, sequence: 1 }],
      })
    ).kind,
  ).toBe("stale_owner");
  expect(row.checkpoint).toEqual(second.checkpoint);
});

test("ambiguous producer acknowledgement never advances its verified reference session", async () => {
  const f = fixture();
  const producer = f.service.createProducerSession();
  const controller = new AbortController();
  const apply = f.repository.transitionMeetingHistory.bind(f.repository);
  const transition = jest
    .spyOn(f.repository, "transitionMeetingHistory")
    .mockImplementationOnce(async (request) => {
      const result = await apply(request);
      controller.abort();
      return result;
    });
  expect(
    (
      await producer.flush({
        ...input,
        ownership,
        signal: controller.signal,
      })
    ).kind,
  ).toBe("preservation_failed");
  transition.mockRestore();
  const actual = (await f.repository.getMeetingHistory(history))!.checkpoint!;
  // Reopening the uncertain pointer must fully reverify old artifacts, never trust the lost ACK.
  const count = f.read.mock.calls.length;
  expect(
    (
      await producer.flush({
        ...input,
        ownership,
        signal: new AbortController().signal,
        previous: actual,
        artifacts: [],
      })
    ).kind,
  ).toBe("committed");
  expect(
    f.read.mock.calls.slice(count).some(([key]) => key.includes("/audio/")),
  ).toBe(true);
});

test.each(["missing", "expired", "replaced", "attempt", "mode"])(
  "live producer refuses %s lease with unchanged history",
  async (kind) => {
    const f = fixture();
    const producer = f.service.createProducerSession();
    const meeting = meetingFixture();
    expect(
      (await producer.appendArtifactsRecordingCheckpoint(meeting, [segment]))
        .kind,
    ).toBe("committed");
    const before = meeting.recordingCheckpoint;
    const lease = f.leases.get(history.guildId)!;
    if (kind === "missing") f.leases.delete(history.guildId);
    else if (kind === "expired")
      lease.leaseExpiresAt = Math.floor(Date.now() / 1000) - 1;
    else if (kind === "replaced") lease.ownerInstanceId = "replacement";
    else if (kind === "attempt") lease.voiceOperationAttemptId = "next";
    else Object.assign(lease, { sessionMode: "tts_only" });
    expect(
      (
        await producer.appendArtifactsRecordingCheckpoint(meeting, [
          { ...segment, sequence: 1 },
        ])
      ).kind,
    ).toBe("stale_owner");
    expect(meeting.recordingCheckpoint).toBe(before);
    expect(f.histories.get(history.guildId)![0].checkpoint).toEqual(before);
  },
);

test("live producer checks lease at actual publication after PCM completes", async () => {
  const f = fixture();
  const producer = f.service.createProducerSession();
  const meeting = meetingFixture();
  meeting.recordingCaptureState = {
    kind: "complete",
    startedAt: capture.captureStartedAt!,
    endedAt: "2026-01-01T00:00:03.000Z",
  };
  expect(
    (await producer.appendArtifactsRecordingCheckpoint(meeting, [segment]))
      .kind,
  ).toBe("committed");
  const before = meeting.recordingCheckpoint;
  const apply = f.repository.transitionMeetingHistory.bind(f.repository);
  jest
    .spyOn(f.repository, "transitionMeetingHistory")
    .mockImplementationOnce(async (request) => {
      f.leases.get(history.guildId)!.voiceOperationAttemptId =
        "replaced-at-barrier";
      return apply(request);
    });
  const text = Buffer.from("late completed speech");
  expect(
    (
      await producer.appendArtifactsRecordingCheckpoint(meeting, [
        {
          kind: "transcription",
          sourceId: "text",
          sequence: 0,
          bytes: text,
          checksumSha256: digest(text),
          contentType: "application/json",
          coverage: { kind: "unknown" },
        },
      ])
    ).kind,
  ).toBe("stale_owner");
  expect(meeting.recordingCheckpoint).toBe(before);
  expect((await producer.read(before!)).manifest.captureState).toEqual(
    meeting.recordingCaptureState,
  );
});

test("producer uses the publication-time clock after artifact verification", async () => {
  const f = fixture();
  const producer = f.service.createProducerSession();
  const meeting = meetingFixture();
  const started = Date.now();
  const clock = jest.spyOn(Date, "now").mockReturnValue(started);
  f.upload.mockImplementation(async (key, body) => {
    f.objects.set(key, Buffer.from(body));
    clock.mockReturnValue(started + 61000);
    return key;
  });
  try {
    expect(
      (await producer.appendArtifactsRecordingCheckpoint(meeting, [segment]))
        .kind,
    ).toBe("stale_owner");
    expect(meeting.recordingCheckpoint).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});

test("producer cannot adopt a later voice attempt with unchanged capture provenance", async () => {
  const f = fixture();
  const producer = f.service.createProducerSession();
  const meeting = meetingFixture();
  expect(
    (await producer.appendArtifactsRecordingCheckpoint(meeting, [segment]))
      .kind,
  ).toBe("committed");
  meeting.reservation!.voiceOperationAttemptId = "later";
  f.leases.get(history.guildId)!.voiceOperationAttemptId = "later";
  expect(
    (await producer.appendArtifactsRecordingCheckpoint(meeting, [])).kind,
  ).toBe("stale_owner");
});

test("first live publication snapshots the original voice attempt before an asynchronous history read", async () => {
  const f = fixture();
  const meeting = meetingFixture();
  const read = f.repository.getMeetingHistory.bind(f.repository);
  jest
    .spyOn(f.repository, "getMeetingHistory")
    .mockImplementationOnce(async (...args) => {
      const row = await read(...args);
      meeting.reservation!.voiceOperationAttemptId = "replacement";
      f.leases.get(history.guildId)!.voiceOperationAttemptId = "replacement";
      return row;
    });
  expect(
    (
      await f.service
        .createProducerSession()
        .appendArtifactsRecordingCheckpoint(meeting, [segment])
    ).kind,
  ).toBe("stale_owner");
  expect(meeting.recordingCheckpoint).toBeUndefined();
});

function initialDispositionInput() {
  return {
    ...input,
    status: "interrupted" as const,
    captureState: {
      kind: "interrupted" as const,
      detectedAt: "2026-01-01T00:00:03.000Z",
      startedAt: capture.captureStartedAt,
      endedAt: "2026-01-01T00:00:03.000Z",
    },
    recovery: {
      disposition: "pending" as const,
      attempt: 0,
      executionVersion: 1,
      stage: "verification" as const,
      retry: { maxAttempts: 3, nextAttemptAt: null },
    },
    preservation: {
      ownership,
      deadlineEpochMs: Date.now() + 20000,
      signal: new AbortController().signal,
      assertOwnership: async () => {},
    },
  };
}
test("initial interruption atomically publishes terminal history and verified checkpoint under original lease", async () => {
  const f = fixture();
  const result = await f.service.preserveInitialTerminalRecordingCheckpoint(
    initialDispositionInput(),
  );
  expect(result.kind).toBe("committed");
  expect(f.histories.get(history.guildId)![0]).toMatchObject({
    status: "interrupted",
    checkpoint: { revision: 1 },
    recovery: { disposition: "pending" },
    captureCoverage: {
      kind: "verified",
      savedDurationMs: 1000,
      lastConfirmedCaptureAt: "2026-01-01T00:00:03.000Z",
      stoppedAt: "2026-01-01T00:00:03.000Z",
    },
  });
});
test.each(["absent", "expired", "replaced"])(
  "initial interruption rejects %s lease after object verification without changing history",
  async (race) => {
    const f = fixture();
    f.upload.mockImplementationOnce(async (key, bytes) => {
      f.objects.set(key, Buffer.from(bytes));
      const lease = f.leases.get(history.guildId)!;
      if (race === "absent") f.leases.delete(history.guildId);
      if (race === "expired")
        lease.leaseExpiresAt = Math.floor(Date.now() / 1000) - 1;
      if (race === "replaced") lease.voiceOperationAttemptId = "other-attempt";
      return key;
    });
    expect(
      (
        await f.service.preserveInitialTerminalRecordingCheckpoint(
          initialDispositionInput(),
        )
      ).kind,
    ).toBe("stale_owner");
    expect(f.histories.get(history.guildId)![0]).toEqual(history);
  },
);
test("initial failure preserves known complete capture and resolves lost ACK only through exact readback", async () => {
  const f = fixture();
  const state = {
    kind: "complete" as const,
    startedAt: capture.captureStartedAt!,
    endedAt: "2026-01-01T00:00:03.000Z",
  };
  const first = await f.service.flush({ ...input, captureState: state });
  if (first.kind !== "committed") throw new Error("synthetic fixture failed");
  const apply = f.repository.transitionMeetingHistory.bind(f.repository);
  jest
    .spyOn(f.repository, "transitionMeetingHistory")
    .mockImplementationOnce(async (request) => {
      await apply(request);
      throw new Error("synthetic lost ACK");
    });
  const result = await f.service.preserveInitialTerminalRecordingCheckpoint({
    ...initialDispositionInput(),
    status: "failed",
    captureState: state,
    previous: first.checkpoint,
    artifacts: [],
  });
  expect(f.histories.get(history.guildId)![0]).toMatchObject({
    status: "failed",
    capture: state,
    checkpoint: first.checkpoint,
  });
  expect(result.kind).toBe("committed");
});

test("live checkpoint producer uses voice identity while notes target remains separate", async () => {
  const f = fixture();
  const meeting = {
    ...meetingFixture(),
    voiceChannel: { id: history.channelId },
    channelId: "separate-notes",
  };
  const result = await f.service
    .createProducerSession()
    .appendArtifactsRecordingCheckpoint(
      meeting,
      [segment],
      meeting.ownershipSignal!,
    );
  expect(result.kind).toBe("committed");
  if (result.kind !== "committed")
    throw new Error("Generated checkpoint failed");
  expect(result.checkpoint.capture.channelId).toBe(history.channelId);
  expect((await f.service.read(result.checkpoint)).manifest.capture).toEqual(
    result.checkpoint.capture,
  );
  expect(meeting.channelId).toBe("separate-notes");
});

test("distinct-channel producer rejects a mismatched voice or stale owner", async () => {
  const f = fixture();
  const meeting = {
    ...meetingFixture(),
    voiceChannel: { id: "wrong-voice" },
    channelId: "separate-notes",
  };
  await expect(
    f.service
      .createProducerSession()
      .appendArtifactsRecordingCheckpoint(
        meeting,
        [segment],
        meeting.ownershipSignal!,
      ),
  ).rejects.toThrow("history or requested settings mismatch");
  expect(f.upload).not.toHaveBeenCalled();
  f.histories.get(history.guildId)![0].executionVersion = 2;
  await expect(
    f.service
      .createProducerSession()
      .appendArtifactsRecordingCheckpoint(
        { ...meeting, voiceChannel: { id: history.channelId } },
        [segment],
        meeting.ownershipSignal!,
      ),
  ).resolves.toMatchObject({ kind: "stale_owner" });
  expect(f.upload).not.toHaveBeenCalled();
});
