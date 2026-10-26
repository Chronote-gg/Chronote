/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { PassThrough } from "node:stream";
import { createCheckpointPlaybackTap } from "../../src/services/recordingCheckpointPlayback";
import { getCheckpointPcmBudget } from "../../src/services/recordingCheckpointCapture";

test("bot prefix follows actual packet consumption, pause and interrupted tail", () => {
  const captured: Array<{ bytes: number; at: number }> = [];
  const tap = createCheckpointPlaybackTap({
    push: (bytes, at) => {
      captured.push({ bytes: bytes.length, at });
      return true;
    },
    stop: jest.fn(),
  });
  const output = new PassThrough();
  tap.stream.pipe(output);
  output.resume();
  tap.stream.write(Buffer.alloc(3840 * 3));
  const resource = {
    playbackDuration: 0,
    read() {
      this.playbackDuration += 20;
      return Buffer.from([1]);
    },
  };
  tap.attach(resource);
  expect(captured).toHaveLength(0);
  resource.read();
  expect(captured).toHaveLength(1);
  expect(captured[0].bytes).toBe(3840);
  // No resource read during pause, no manufactured future coverage.
  expect(captured).toHaveLength(1);
  tap.dispose();
  expect(captured).toHaveLength(1);
  expect(getCheckpointPcmBudget().reservedBytes).toBe(0);
});

test("silence packets cannot consume prefetched PCM", () => {
  const push = jest.fn(() => true);
  const tap = createCheckpointPlaybackTap({ push, stop: jest.fn() });
  const resource = { playbackDuration: 0, read: () => Buffer.from([1]) };
  tap.attach(resource);
  resource.read();
  expect(push).not.toHaveBeenCalled();
  tap.dispose();
});

test("actual playback prefix and producer retain byte duration across boundary jitter without changing physical end", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createRecordingCheckpointCapture } =
    await import("../../src/services/recordingCheckpointCapture");
  const { createRecordingCheckpointService } =
    await import("../../src/services/recordingCheckpointService");
  const { createMockDeploymentControlRepository } =
    await import("../../src/repositories/deploymentControlRepository");
  const { history } = await import("../deployment/controlFixtures");
  const start = Date.parse(history.timestamp);
  const clock = jest.spyOn(Date, "now").mockReturnValue(start);
  const directory = mkdtempSync(path.join(tmpdir(), "playback-clock-"));
  const owner = {
    guildId: history.guildId,
    meetingId: history.meetingId,
    ownerInstanceId: "old",
    executionVersion: 1,
    voiceOperationAttemptId: "voice",
    sessionMode: "meeting" as const,
  };
  const repository = createMockDeploymentControlRepository(
    new Map(),
    new Map([[history.guildId, [{ ...history }]]]),
    new Map([
      [
        history.guildId,
        {
          ...owner,
          voiceChannelId: "channel",
          textChannelId: "text",
          isAutoRecording: false,
          leaseExpiresAt: Math.floor(start / 1000) + 120,
          createdAt: history.timestamp,
          updatedAt: history.timestamp,
          expiresAt: 0,
        },
      ],
    ]),
  );
  const objects = new Map<string, Buffer>();
  const producer = createRecordingCheckpointService({
    repository,
    objects: {
      upload: async (key, bytes) => {
        objects.set(key, Buffer.from(bytes));
        return key;
      },
      read: async (key) => objects.get(key),
    },
  }).createProducerSession();
  const capture = {
    guildId: history.guildId,
    channelId: history.channelId,
    channelId_timestamp: history.channelId_timestamp,
    meetingId: history.meetingId,
    ownerInstanceId: "old",
    executionVersion: 1,
    reservedAt: history.timestamp,
    captureStartedAt: history.timestamp,
    requested: { transcribeMeeting: true, generateNotes: true },
  };
  const complete = {
    kind: "complete" as const,
    startedAt: history.timestamp,
    endedAt: new Date(start + 29999).toISOString(),
  };
  let previous:
    | import("../../src/types/recordingCheckpoint").RecordingCheckpoint
    | undefined;
  const recording = createRecordingCheckpointCapture({
    directory,
    startedAt: start,
    signal: new AbortController().signal,
    stopCapture: jest.fn(),
    commit: async (artifacts, signal) => {
      const result = await producer.flush({
        capture,
        captureState: complete,
        expectedStatus: "starting",
        previous,
        artifacts,
        ownership: owner,
        signal,
      });
      if (result.kind !== "committed") return false;
      previous = result.checkpoint;
      return true;
    },
  });
  const tap = createCheckpointPlaybackTap({
    push: (bytes, at) => recording.push("bot", bytes, at),
    stop: jest.fn(),
  });
  tap.stream.resume();
  const resource = {
    playbackDuration: 0,
    read() {
      this.playbackDuration += 20;
      return Buffer.from([1]);
    },
  };
  tap.attach(resource);
  try {
    for (let i = 0; i < 1501; i++) {
      clock.mockReturnValue(start + (i === 1500 ? 29999 : i * 20));
      await new Promise<void>((resolve, reject) =>
        tap.stream.write(Buffer.alloc(3840, i % 255), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      resource.read();
    }
    expect(await recording.finish()).toBe(true);
    const saved = await producer.read(previous!);
    expect(saved.manifest.captureState).toEqual(complete);
    expect(saved.coverage).toMatchObject({
      kind: "unknown",
      reason: "source_intervals_unknown",
      stoppedAt: complete.endedAt,
    });
    const audio = saved.verified.filter((item) => item.kind === "audio");
    expect(audio.reduce((n, item) => n + item.object.byteLength, 0)).toBe(
      1501 * 3840,
    );
    expect(audio.map((item) => item.coverage)).toEqual([
      {
        kind: "known",
        intervals: [{ sourceId: "bot", startOffsetMs: 0, durationMs: 30000 }],
      },
      {
        kind: "known",
        intervals: [{ sourceId: "bot", startOffsetMs: 30000, durationMs: 20 }],
      },
    ]);
    expect(audio[1].timing).toMatchObject({
      observedFirstOffsetMs: 29999,
      observedLastOffsetMs: 29999,
      maxCursorAdjustmentMs: 1,
    });
  } finally {
    tap.dispose();
    recording.fence();
    await recording.settled();
    recording.releaseSettledBuffers();
    clock.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
  expect(getCheckpointPcmBudget().reservedBytes).toBe(0);
});
