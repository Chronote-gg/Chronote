import type { MeetingHistory } from "../../src/types/db";
import type { MeetingContentWrite } from "../../src/repositories/meetingUpdateDeliveryRepository";
import {
  PROCESSING_RETRY_QUEUE,
  type ProcessingRetryJob,
} from "../../src/types/meetingProcessingRetry";
import {
  requestMeetingUpdateDelivery,
  type MeetingUpdateDelivery,
  type MeetingUpdateMutation,
} from "../../src/types/meetingUpdateDelivery";
import {
  history,
  now,
  pending,
  pointers,
} from "../types/meetingUpdateDelivery.fixture";
import { write, type Harness } from "./meetingUpdateDeliveryContract";

type RegenerationChanges = Extract<
  MeetingUpdateMutation,
  { kind: "regeneration" }
>["changes"];
type Regeneration = NonNullable<MeetingContentWrite["regeneration"]>;

export const runningJob: ProcessingRetryJob = {
  jobId: "job-1",
  status: "running",
  stages: ["notes", "summary"],
  requestedBy: "requester",
  requestedAt: "2026-10-22T12:00:00.000Z",
  expectedNotesVersion: 1,
  replaceNotes: false,
  countedAttempts: 0,
  settingsSource: "snapshot",
  transcriptSource: "existing",
  claim: { ownerInstanceId: "instance-a", leaseExpiresAt: now + 300 },
  updatedAt: "2026-10-22T12:00:00.000Z",
};

export function regenerationRow(): MeetingHistory {
  return {
    ...history(),
    ...pointers,
    contentRevision: 1,
    notesVersion: 1,
    updateDelivery: pending(),
    processing: { transcription: "ready", notes: "failed", summary: "skipped" },
    processingRetry: runningJob,
    processingRetryQueue: PROCESSING_RETRY_QUEUE,
    processingRetryDueAt: now,
  };
}

export function regenerationPayload(): Regeneration {
  return {
    expected: {
      jobId: "job-1",
      ownerInstanceId: "instance-a",
      expectedNotesVersion: 1,
    },
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "generated",
    },
    transcriptS3Key: "f/transcript-retry-job-1.json",
    job: {
      ...runningJob,
      status: "succeeded",
      countedAttempts: 1,
      claim: undefined,
    },
  };
}

export function regenerationChanges(
  notes: string | undefined,
): RegenerationChanges {
  const notesChange: RegenerationChanges =
    notes === undefined ? [] : [{ kind: "notes", notes }];
  return [
    ...notesChange,
    { kind: "summarySentence", value: "S" },
    { kind: "summaryLabel", value: "L" },
  ];
}

export const regenerationNotesEdit: Omit<
  NonNullable<MeetingContentWrite["notesEdit"]>,
  "editedBy"
> = {
  expectedNotesVersion: 1,
  source: { type: "processing_retry", jobId: "job-1" },
};

export function regenerationWrite(
  row: MeetingHistory,
  options: { notes?: string; policy?: MeetingUpdateDelivery["policy"] } = {},
): MeetingContentWrite {
  const settings = {
    notes: "Regenerated notes",
    policy: { kind: "active" },
    ...options,
  } satisfies typeof options;
  const mutation: MeetingUpdateMutation = {
    kind: "regeneration",
    changes: regenerationChanges(settings.notes),
  };
  return {
    ...write(row, "regeneration-1"),
    mutation,
    nextDelivery: requestMeetingUpdateDelivery({
      history: row,
      mutation,
      revision: "regeneration-1-delivery",
      now,
      policy: settings.policy,
    }),
    notesEdit:
      settings.notes === undefined
        ? undefined
        : { ...regenerationNotesEdit, editedBy: "requester" },
    regeneration: regenerationPayload(),
  };
}

export function regenerationContract(make: () => Harness) {
  let h: Harness;
  const row = regenerationRow();
  beforeEach(async () => {
    h = make();
    await h.admit(true);
  });
  const save = (input: MeetingContentWrite) =>
    h.repository.updateContentAndDelivery(input, undefined);

  it("regeneration saves notes, summary, processing, transcript key and the terminal job in one write", async () => {
    await h.seed(row);
    expect(await save(regenerationWrite(row))).toMatchObject({
      kind: "committed",
    });
    const saved = await h.read();
    expect(saved).toMatchObject({
      notes: "Regenerated notes",
      notesVersion: 2,
      summarySentence: "S",
      summaryLabel: "L",
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "generated",
      },
      transcriptS3Key: "f/transcript-retry-job-1.json",
      processingRetry: {
        jobId: "job-1",
        status: "succeeded",
        countedAttempts: 1,
      },
    });
    expect(saved?.processingRetry?.claim).toBeUndefined();
    expect(saved?.notesHistory?.at(-1)).toMatchObject({
      version: 2,
      editedBy: "requester",
      source: { type: "processing_retry", jobId: "job-1" },
    });
    expect(saved).not.toHaveProperty("processingRetryQueue");
    expect(saved).not.toHaveProperty("processingRetryDueAt");
    expect(saved?.updateDelivery?.parts.notesBody.desired).toBe(2);
    expect(saved?.updateDelivery?.parts.summaryBody.desired).toBe(2);
    expect(saved?.updateDeliveryQueue).toBe("meeting-update:v1");
  });
  it("regeneration of a legacy row without a stored notes version reads it as version 1", async () => {
    const legacy = { ...row, notesVersion: undefined };
    await h.seed(legacy);
    expect(await save(regenerationWrite(legacy))).toMatchObject({
      kind: "committed",
    });
    expect((await h.read())?.notesVersion).toBe(2);
  });
  it.each([
    ["another job", { jobId: "job-2" }],
    [
      "another owner",
      { claim: { ownerInstanceId: "instance-b", leaseExpiresAt: now + 300 } },
    ],
    ["a queued job", { status: "queued" }],
  ] satisfies [string, Partial<ProcessingRetryJob>][])(
    "regeneration conflicts when the stored job is %s",
    async (_, patch) => {
      const raced = { ...row, processingRetry: { ...runningJob, ...patch } };
      await h.seed(raced);
      expect(await save(regenerationWrite(row))).toEqual({ kind: "conflict" });
      expect(await h.read()).toEqual(raced);
    },
  );
  it("regeneration conflicts when no job is stored", async () => {
    await h.seed({ ...row, processingRetry: undefined });
    expect(await save(regenerationWrite(row))).toEqual({ kind: "conflict" });
  });
  it.each([
    ["notes", "Regenerated notes"],
    ["summary-only", undefined],
  ])(
    "%s regeneration conflicts when notes moved past the job's expected version",
    async (_, notes) => {
      await h.seed({ ...row, notesVersion: 2 });
      expect(await save(regenerationWrite(row, { notes }))).toEqual({
        kind: "conflict",
      });
    },
  );
  it("summary-only regeneration keeps the notes version and history", async () => {
    await h.seed(row);
    await save(regenerationWrite(row, { notes: undefined }));
    const saved = await h.read();
    expect(saved).toMatchObject({
      notes: row.notes,
      notesVersion: 1,
      summaryLabel: "L",
      processingRetry: { status: "succeeded" },
    });
    expect(saved?.notesHistory).toBeUndefined();
  });
  it("regeneration on an unpublished meeting saves without queueing delivery", async () => {
    const unpublished = {
      ...row,
      notesChannelId: undefined,
      notesMessageIds: undefined,
      updateDelivery: undefined,
    };
    await h.seed(unpublished);
    await save(
      regenerationWrite(unpublished, { policy: { kind: "unpublished" } }),
    );
    const saved = await h.read();
    expect(saved).toMatchObject({
      notes: "Regenerated notes",
      updateDelivery: { policy: { kind: "unpublished" } },
    });
    expect(saved).not.toHaveProperty("updateDeliveryQueue");
    expect(saved).not.toHaveProperty("processingRetryQueue");
  });
  it("a retried identical regeneration write is recognized as already applied", async () => {
    await h.seed(row);
    const input = regenerationWrite(row);
    await save(input);
    expect(await save(input)).toMatchObject({ kind: "committed" });
    expect((await h.read())?.notesVersion).toBe(2);
  });
  it.each([
    [
      "a regeneration without its payload",
      (): MeetingContentWrite => ({
        ...regenerationWrite(row),
        regeneration: undefined,
      }),
    ],
    [
      "a correction carrying a regeneration payload",
      (): MeetingContentWrite => ({
        ...regenerationWrite(row),
        mutation: {
          kind: "correction",
          changes: regenerationChanges("Regenerated notes"),
        },
      }),
    ],
  ])("regeneration rejects %s", async (_, input) => {
    await h.seed(row);
    await expect(save(input())).rejects.toThrow(/regeneration/i);
    expect(await h.read()).toEqual(row);
  });
}
