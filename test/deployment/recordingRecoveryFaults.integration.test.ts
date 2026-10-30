jest.mock("../../src/commands/endMeeting", () => ({
  persistExplicitMeetingStop: jest.fn(),
}));
jest.mock("../../src/meetings", () => ({
  getPendingMeetingInitializations: () => [],
  getMeeting: jest.fn(),
}));
jest.mock("../../src/services/unifiedConfigService", () => ({
  ...jest.requireActual("../../src/services/unifiedConfigService"),
  resolveConfigSnapshot: async () => ({ values: {} }),
}));
jest.mock("../../src/services/transcriptionService", () => ({
  ...jest.requireActual("../../src/services/transcriptionService"),
  transcribeContentSnippet: jest.fn(async () => ({
    status: "succeeded",
    text: "Generated verified audio.",
  })),
}));
import { resolveRemoteLeaseStatus } from "../../src/api/liveMeetings";
import { recoverMeeting } from "../../src/services/meetingRecoveryService";
import { transcribeContentSnippet } from "../../src/services/transcriptionService";
import {
  barrier,
  createRecoveryFaultDatabase,
  generatedAudio,
  recoveryFaultFixture,
} from "./fixtures/recordingRecoveryFaultFixture";

const db = createRecoveryFaultDatabase();
beforeAll(() => db.start());
afterAll(() => db.close());
afterEach(() => jest.restoreAllMocks());

async function published(options?: Parameters<typeof recoveryFaultFixture>[1]) {
  const f = await recoveryFaultFixture(db, options);
  expect((await f.reader.flush(f.input)).kind).toBe("committed");
  return f;
}

test.each(["before_upload", "after_upload_before_manifest"] as const)(
  "%s keeps orphan bytes out of canonical recovery",
  async (fault) => {
    const f = await recoveryFaultFixture(db);
    const entered = barrier(),
      tail = barrier();
    const upload = f.upload.getMockImplementation()!;
    f.upload.mockImplementationOnce(async (...args) => {
      if (fault === "after_upload_before_manifest") await upload(...args);
      entered.release();
      await tail.promise;
      throw new Error("Generated storage outage");
    });
    const publishing = f.reader.flush(f.input);
    await entered.promise;
    expect((await f.readHistory()).checkpoint).toBeUndefined();
    expect(f.objects.size).toBe(fault === "before_upload" ? 0 : 1);
    tail.release();
    expect((await publishing).kind).toBe("preservation_failed");
    expect(await f.optionalClaim()).toBeUndefined();
    expect((await f.readHistory()).recovery).toBeUndefined();
    expect((await f.readHistory()).capture).toBeUndefined();
    expect(
      resolveRemoteLeaseStatus({ ...f.lease, leaseExpiresAt: f.now - 1 }),
    ).toBe("unavailable");
    expect(f.send).not.toHaveBeenCalled();
  },
);

test("Dynamo outage after verified manifest upload is not a canonical commit", async () => {
  const f = await recoveryFaultFixture(db);
  jest
    .spyOn(db.repository, "transitionMeetingHistory")
    .mockRejectedValueOnce(new Error("Generated Dynamo outage"));
  const result = await f.reader.flush(f.input);
  expect(result.kind).toBe("preservation_failed");
  expect(f.objects.size).toBe(3);
  expect((await f.readHistory()).checkpoint).toBeUndefined();
  expect(await f.optionalClaim()).toBeUndefined();
  expect((await f.readHistory()).recovery).toBeUndefined();
});

test("uploaded manifest cannot publish after original lease replacement", async () => {
  const f = await recoveryFaultFixture(db);
  const entered = barrier(),
    tail = barrier();
  const apply = db.repository.transitionMeetingHistory.bind(db.repository);
  jest
    .spyOn(db.repository, "transitionMeetingHistory")
    .mockImplementationOnce(async (input) => {
      entered.release();
      await tail.promise;
      return apply(input);
    });
  const publishing = f.reader.flush(f.input);
  await entered.promise;
  expect(f.objects.size).toBe(3);
  await f.put(f.tables.activeMeeting, {
    ...f.lease,
    ownerInstanceId: "replacement",
  });
  tail.release();
  expect((await publishing).kind).toBe("stale_owner");
  expect((await f.readHistory()).checkpoint).toBeUndefined();
});

test.each(["missing", "corrupt", "invalid_context"] as const)(
  "%s content never fabricates completion",
  async (fault) => {
    const f = await published();
    const row = await f.readHistory();
    if (fault === "missing") f.objects.delete(row.checkpoint!.manifest.key);
    else if (fault === "corrupt")
      f.objects.set(row.checkpoint!.manifest.key, Buffer.from("corrupt"));
    else {
      const next = await recoveryFaultFixture(db, {
        context: (saved) => {
          saved.settings = { availability: "unavailable" };
        },
      });
      expect((await next.reader.flush(next.input)).kind).toBe("committed");
      await recoverMeeting(await next.claim(), next.deps);
      expect((await next.readHistory()).recovery).toMatchObject({
        disposition: "needs_reconciliation",
        reason: "invalid_payload",
      });
      expect(next.send).not.toHaveBeenCalled();
      return;
    }
    await recoverMeeting(await f.claim(), f.deps);
    expect((await f.readHistory()).recovery).toMatchObject({
      disposition: "needs_reconciliation",
      reason: "invalid_payload",
    });
    expect(f.send).not.toHaveBeenCalled();
  },
);

test("verified PCM supplements saved text and missing PCM reduces verified coverage", async () => {
  const f = await published({
    artifacts: [generatedAudio()],
    // This fault scenario supplements independent chat text, not legacy same-source speech.
    transcript: (saved) => {
      for (const entry of saved.entries)
        entry.correspondence = { kind: "text_only" };
    },
    context: (saved) => {
      saved.prompts.transcription = {
        availability: "available",
        value: {
          type: "text",
          name: "generated",
          version: 1,
          label: "generated",
          template: "Generated prompt",
        },
      };
    },
  });
  const row = await f.readHistory();
  const verified = await f.reader.read(row.checkpoint!);
  expect(verified.coverage).toMatchObject({
    kind: "verified",
    savedDurationMs: 1000,
  });
  await recoverMeeting(await f.claim(), f.deps);
  expect(transcribeContentSnippet).toHaveBeenCalled();
  expect((await f.readHistory()).recovery).toMatchObject({
    disposition: "done",
    outcome: "completed",
  });
  expect((await f.readHistory()).status).toBe("interrupted");
});

test.each([
  "unknown_send",
  "partial_send",
  "terminal_metadata_unknown",
  "terminal_metadata_lost_response",
  "ancillary_unknown",
] as const)("%s retains the correct delivery boundary", async (fault) => {
  const f = await published();
  const claim = await f.claim();
  const entered = barrier(),
    tail = barrier();
  if (fault === "unknown_send" || fault === "partial_send") {
    if (fault === "partial_send")
      f.send.mockResolvedValueOnce({ id: "known-summary" });
    f.send.mockImplementationOnce(async () => {
      entered.release();
      await tail.promise;
      throw new Error("Generated Discord acknowledgment lost");
    });
  } else if (fault === "ancillary_unknown") {
    f.autoExport.mockImplementationOnce(async () => {
      const { runNotionMutation } =
        await import("../../src/services/notionOperationLifetime");
      return runNotionMutation(f.deps.signal, async () => {
        entered.release();
        await tail.promise;
        throw new Error("Generated Notion acknowledgment lost");
      });
    });
  } else {
    const update = db.repository.updateRecordingRecovery.bind(db.repository);
    jest
      .spyOn(db.repository, "updateRecordingRecovery")
      .mockImplementation(async (...args) => {
        if (args[1].recovery?.disposition !== "done") return update(...args);
        if (fault === "terminal_metadata_lost_response") await update(...args);
        entered.release();
        await tail.promise;
        throw new Error("Generated terminal ACK lost");
      });
  }
  const running = recoverMeeting(claim, f.deps);
  const result = running.then(
    () => "settled",
    () => "unknown",
  );
  await entered.promise;
  const before = await f.readHistory();
  expect(before.recovery?.disposition).toBe(
    fault === "terminal_metadata_lost_response"
      ? "done"
      : fault === "terminal_metadata_unknown"
        ? "pending"
        : "needs_reconciliation",
  );
  tail.release();
  expect(await result).toBe(
    fault === "terminal_metadata_lost_response" ? "settled" : "unknown",
  );
  const count = f.send.mock.calls.length;
  if (fault === "terminal_metadata_unknown")
    await expect(recoverMeeting(claim, f.deps)).rejects.toThrow(
      "acknowledgment is unknown",
    );
  else if (fault !== "ancillary_unknown") await recoverMeeting(claim, f.deps);
  expect(f.send).toHaveBeenCalledTimes(count);
  const after = await f.readHistory();
  expect(after.status).toBe("interrupted");
  if (fault === "partial_send")
    expect(after.summaryMessageId).toBe("known-summary");
  if (["unknown_send", "partial_send"].includes(fault))
    expect(after.recovery).toMatchObject({
      disposition: "needs_reconciliation",
      stage: "delivery",
      reason: "delivery_uncertain",
    });
  if (["unknown_send", "partial_send"].includes(fault))
    expect(f.autoExport).not.toHaveBeenCalled();
  else expect(f.autoExport).toHaveBeenCalledTimes(1);
  if (fault === "ancillary_unknown") {
    expect(after.recoveryExport?.state).toBe("submitted");
    await expect(recoverMeeting(claim, f.deps)).rejects.toThrow(
      "requires reconciliation",
    );
    expect(f.autoExport).toHaveBeenCalledTimes(1);
  }
  if (fault === "terminal_metadata_unknown")
    expect(after.recoveryExport?.state).toBe("skipped");
});

test.each([true, false])(
  "complete capture before AI retains original requested notes=%s",
  async (generateNotes) => {
    const f = await recoveryFaultFixture(db, {
      requested: { transcribeMeeting: true, generateNotes },
      context: (saved) => {
        if (saved.settings.availability !== "available")
          throw new Error("Generated settings unavailable");
        saved.settings.value.transcription.finalPassEnabled = false;
        saved.settings.value.premiumTranscription.cleanupEnabled = false;
        saved.completion = {
          decision: "proceed",
          isAutoRecording: false,
          chatMessageCount: 0,
          dismissed: false,
          policy: {
            enabled: true,
            maximumSeconds: 90,
            maximumWords: 50,
            maximumChatMessages: 1,
            dismissedMinimumMilliseconds: 600000,
            dismissedMinimumChatMessages: 2,
          },
        };
      },
    });
    expect(
      (
        await f.reader.flush({
          ...f.input,
          captureState: {
            kind: "complete",
            startedAt: f.row.timestamp,
            endedAt: "2026-01-01T00:00:01Z",
          },
        })
      ).kind,
    ).toBe("committed");
    const claim = await f.claim();
    await recoverMeeting(claim, f.deps);
    expect((await f.readHistory()).capture?.kind).toBe("complete");
    expect((await f.readHistory()).recovery).toMatchObject({
      disposition: "done",
      outcome: generateNotes ? "completed" : "disabled",
    });
    expect(f.send).toHaveBeenCalledTimes(generateNotes ? 2 : 0);
  },
);

test("complete capture with undecided original auto policy does not use changed live defaults", async () => {
  const f = await recoveryFaultFixture(db);
  expect(
    (
      await f.reader.flush({
        ...f.input,
        captureState: {
          kind: "complete",
          startedAt: f.row.timestamp,
          endedAt: "2026-01-01T00:00:01Z",
        },
      })
    ).kind,
  ).toBe("committed");
  await recoverMeeting(await f.claim(), f.deps);
  expect((await f.readHistory()).recovery).toMatchObject({
    disposition: "needs_reconciliation",
    reason: "policy_unknown",
  });
  expect(f.notes).not.toHaveBeenCalled();
  expect(f.autoExport).not.toHaveBeenCalled();
});

test("notes remain persisted after generation failure without claiming complete capture", async () => {
  const f = await published();
  const claim = await f.claim();
  const entered = barrier(),
    tail = barrier();
  f.deps.summaries = async () => {
    entered.release();
    await tail.promise;
    throw new Error("Generated summary outage before delivery");
  };
  const recovering = recoverMeeting(claim, f.deps);
  await entered.promise;
  expect((await f.readHistory()).processing?.notes).toBe("generated");
  expect((await f.readHistory()).notes).toBe("Generated saved decision.");
  expect(f.send).not.toHaveBeenCalled();
  tail.release();
  await recovering;
  expect((await f.readHistory()).recovery).toMatchObject({
    disposition: "failed",
    stage: "notes",
  });
  expect((await f.readHistory()).capture).toMatchObject({
    kind: "interrupted",
    endedAt: null,
  });
});

test("missing PCM keeps saved text usable without inventing verified duration", async () => {
  const f = await published({ artifacts: [generatedAudio()] });
  const before = await f.readHistory();
  const saved = await f.reader.read(before.checkpoint!);
  const audio = saved.manifest.artifacts.find((item) => item.kind === "audio")!;
  f.objects.delete(audio.object.key);
  await recoverMeeting(await f.claim(), f.deps);
  const after = await f.readHistory();
  expect(after.recovery).toMatchObject({
    disposition: "done",
    outcome: "completed",
  });
  expect(after.status).toBe("interrupted");
  expect(after.captureCoverage?.kind).toBe("unknown");
});

test("compatible same-image replacement enters serving then owns actual worker recovery without clearing old voice", async () => {
  await jest.isolateModulesAsync(async () => {
    const { startCompatibleRecoveryRuntime } =
      await import("./fixtures/recordingRecoveryFaultFixture");
    const { createMeetingRecoveryWorker } =
      await import("../../src/services/meetingRecoveryWorkerService");
    const { beginRuntimeWorkClaim } =
      await import("../../src/services/runtimeWorkAdmissionService");
    const f = await published();
    const originalCapture = (await f.readHistory()).checkpoint!.capture;
    const replacement = await startCompatibleRecoveryRuntime(f);
    const entered = barrier(),
      tail = barrier();
    const notes = f.notes.getMockImplementation()!;
    f.notes.mockImplementation(async (...args) => {
      entered.release();
      await tail.promise;
      return notes(...args);
    });
    const worker = createMeetingRecoveryWorker({
      repository: f.repository,
      begin: beginRuntimeWorkClaim,
      recover: recoverMeeting,
      now: () => Math.floor(Date.now() / 1000),
      content: f.deps,
    });
    const polling = worker.poll();
    try {
      await Promise.race([
        entered.promise,
        polling.then(() => {
          throw new Error("Worker exited before generation barrier");
        }),
      ]);
      const claimed = await f.readHistory();
      expect(claimed.ownerInstanceId).toBe("replacement");
      expect(claimed.executionVersion).toBe(2);
      expect(replacement.lifecycle.getWorkCounts().recovery_processing).toBe(1);
      expect(await f.repository.getRecoveryLease(f.row.guildId)).toMatchObject({
        sessionMode: "recovery",
        ownerInstanceId: "replacement",
      });
      expect(claimed.checkpoint!.capture).toEqual(originalCapture);
      tail.release();
      await polling;
      expect((await f.readHistory()).recovery?.disposition).toBe("done");
      expect(replacement.lifecycle.getWorkCounts().recovery_processing).toBe(0);
      expect(
        await f.repository.getRecoveryLease(f.row.guildId),
      ).toBeUndefined();
      expect(await f.repository.getRecord("ENV", "RUNTIME#old")).toEqual(
        replacement.old,
      );
      expect(
        await f.repository.getRecord(
          replacement.voice.pk,
          replacement.voice.sk,
        ),
      ).toEqual(replacement.voice);
      expect(f.autoExport).toHaveBeenCalledTimes(1);
      const row = await f.readHistory();
      console.log(
        JSON.stringify({
          fixture: "generated-compatible-replacement",
          checkpointSha256: row.checkpoint!.manifest.checksumSha256,
          capture: row.capture?.kind,
          recovery: row.recovery,
          providerAcceptance: "UNKNOWN",
        }),
      );
    } finally {
      tail.release();
      await worker.stop();
      await replacement.lifecycle.shutdown();
    }
  });
});

test("original cancel intent commits before lost notice ACK and is never recovered under changed settings", async () => {
  const f = await published();
  const database = await import("../../src/db");
  const policy =
    await import("../../src/services/meetingCompletionPolicyService");
  jest
    .spyOn(database, "getDeploymentControlRepository")
    .mockReturnValue(f.repository);
  const reservedAt = Date.now();
  const meeting: Parameters<typeof policy.publishCompletionPolicy>[0] = {
    reservation: {
      ...f.ownership,
      reservedAt,
      historyKey: {
        guildId: f.row.guildId,
        channelId_timestamp: f.row.channelId_timestamp,
      },
      timingReceipt: policy.reservationTimingReceipt(reservedAt, reservedAt),
      workHandle: {
        settle() {},
        transition() {},
        beginOwnedControl: () => ({ settle() {} }),
      },
    },
    isAutoRecording: true,
    chatLog: [],
    endReason: "auto_cancelled",
    cancellationReason: "Generated short conversation",
    runtimeConfig: { autoRecordCancellation: { enabled: true } },
  };
  policy.freezeCompletionPolicy(meeting);
  policy.stopCompletionClock(meeting);
  const apply = f.repository.transitionMeetingHistory.bind(f.repository);
  jest
    .spyOn(f.repository, "transitionMeetingHistory")
    .mockImplementationOnce(async (input) => {
      expect(await apply(input)).toBe("applied");
      throw new Error("Generated lost intention ACK");
    });
  await policy.publishCompletionPolicy(meeting, "cancel");
  const beforeNotice = await f.readHistory();
  expect(beforeNotice).toMatchObject({
    status: "cancelled",
    completionPolicy: { decision: "cancel", policy: { enabled: true } },
  });
  const notice = jest.fn(async () => {
    throw new Error("Generated lost cancellation notice ACK");
  });
  await expect(notice()).rejects.toThrow("lost cancellation notice");
  meeting.runtimeConfig!.autoRecordCancellation.enabled = false;
  expect(await f.optionalClaim()).toBeUndefined();
  expect(await f.readHistory()).toEqual(beforeNotice);
  expect(f.notes).not.toHaveBeenCalled();
});
