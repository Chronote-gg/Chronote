/** @jest-environment node */
import "./meetingUpdateDeliveryRuntime";
import { deliveryFixture } from "./meetingUpdateDelivery.fixture";
import { recoveredFixture } from "./recoveredMeetingLayout.fixture";
import {
  initializeDeliveryClock,
  runDelivery,
  settleDeliveryWorks,
} from "./meetingUpdateDelivery.harness";
import {
  meetingUpdateDeliverySchema,
  requestMeetingUpdateDelivery,
  type MeetingUpdateMutation,
} from "../../src/types/meetingUpdateDelivery";
import { now } from "../types/meetingUpdateDelivery.fixture";
import { planMeetingUpdate } from "../../src/services/meetingUpdatePlan";

function setupRecoveredDelivery() {
  const f = deliveryFixture();
  const input = recoveredFixture();
  f.setRow(input.history);
  f.remote.clear();
  for (const message of input.messages)
    f.remote.set(message.id, structuredClone(message));
  return f;
}
async function change(
  f: ReturnType<typeof setupRecoveredDelivery>,
  mutation: MeetingUpdateMutation,
) {
  const row = await f.read();
  const result = await f.repository.updateContentAndDelivery({
    key: { guildId: row.guildId, channelId_timestamp: row.channelId_timestamp },
    expectedContentRevision: row.contentRevision ?? 0,
    expectedDeliveryRevision: row.updateDelivery.revision,
    mutation,
    mutationId: crypto.randomUUID(),
    at: now,
    nextDelivery: requestMeetingUpdateDelivery({
      history: row,
      mutation,
      revision: crypto.randomUUID(),
      now,
      policy: { kind: "active" },
    }),
  });
  expect(result.kind).toBe("committed");
}

describe("normal delivery after recovered publication", () => {
  beforeEach(initializeDeliveryClock);
  afterEach(settleDeliveryWorks);

  it("updates recovered notes through page growth and a second subsequent edit", async () => {
    const f = setupRecoveredDelivery();
    const url = [...f.remote.values()][0].embeds[0].url;
    expect((await runDelivery(f).promise).kind).toBe("settled");
    await f.save("A recovered discussion point. ".repeat(500));
    expect((await runDelivery(f).promise).kind).toBe("settled");
    const grown = await f.read();
    expect(grown.notesMessageIds!.length).toBeGreaterThan(1);
    expect(grown.delivery?.notes?.intended).toBe(1);
    await f.save("A second reviewed edit after pagination.");
    expect((await runDelivery(f).promise).kind).toBe("settled");
    const after = await f.read();
    expect(after.updateDelivery.progress.kind).toBe("synced");
    expect(after.notesMessageIds).toHaveLength(1);
    expect(f.remote.get(after.notesMessageIds![0])?.embeds[0].url).toBe(url);
    expect(
      f.remote.get(after.notesMessageIds![0])?.embeds[0].description,
    ).toContain(after.notes);
    expect(after.capture?.kind).toBe("interrupted");
  });

  it("supports two title edits without depending on the original recovered title", async () => {
    const f = setupRecoveredDelivery();
    const row = await f.read();
    f.setRow({
      ...row,
      updateDelivery: meetingUpdateDeliverySchema.parse({
        ...row.updateDelivery,
        parts: Object.fromEntries(
          Object.keys(row.updateDelivery.parts).map((part) => [
            part,
            { desired: 0, acknowledged: 0 },
          ]),
        ),
        progress: { kind: "synced", syncedAt: now },
      }),
    });
    await change(f, { kind: "rename", meetingName: "First chosen name" });
    expect((await runDelivery(f).promise).kind).toBe("settled");
    const first = await f.read();
    expect(
      f.remote.get(first.notesMessageIds![0])?.embeds[0].footer?.text,
    ).not.toMatch(/^v\d/);
    await change(f, { kind: "rename", meetingName: "Second chosen name" });
    expect((await runDelivery(f).promise).kind).toBe("settled");
    const second = await f.read();
    expect(f.remote.get(second.notesMessageIds![0])?.embeds[0].title).toBe(
      "Second chosen name",
    );
    expect(f.remote.get(second.summaryMessageId!)?.embeds[0].title).toBe(
      "Second chosen name",
    );
    expect(f.remote.get(second.summaryMessageId!)?.embeds[0].url).toBe(
      f.remote.get(second.notesMessageIds![0])?.embeds[0].url,
    );
  });

  it("updates a compact summary twice while preserving its link and unrelated metadata", async () => {
    const f = setupRecoveredDelivery();
    const original = structuredClone(
      f.remote.get(f.input.history.summaryMessageId)!,
    );
    await change(f, {
      kind: "correction",
      changes: [
        { kind: "summarySentence", value: "First summary edit" },
        { kind: "summaryLabel", value: "First summary label" },
      ],
    });
    expect((await runDelivery(f).promise).kind).toBe("settled");
    await change(f, {
      kind: "correction",
      changes: [
        { kind: "summarySentence", value: "Second summary edit" },
        { kind: "summaryLabel", value: "Second summary label" },
      ],
    });
    expect((await runDelivery(f).promise).kind).toBe("settled");
    const after = f.remote.get(f.input.history.summaryMessageId)!;
    expect(after.embeds[0]).toMatchObject({
      title: "Second summary label",
      color: original.embeds[0].color,
      timestamp: original.embeds[0].timestamp,
      url: original.embeds[0].url,
    });
    expect(after.embeds[0].description).toContain("Second summary edit");
    expect(after.embeds[0].description).toContain("recording was interrupted");
  });

  it("retains recovery provenance when later canonical transcript and notes change", async () => {
    const f = setupRecoveredDelivery();
    expect((await runDelivery(f).promise).kind).toBe("settled");
    const row = await f.read();
    f.setRow({ ...row, transcriptS3Key: "later-regeneration/transcript.json" });
    await f.save("Notes after a later canonical transcript.");
    expect((await runDelivery(f).promise).kind).toBe("settled");
    expect((await f.read()).recoveryTranscript).toEqual(row.recoveryTranscript);
  });

  it("rejects invalid success or pointer evidence after legitimate page growth", async () => {
    const f = setupRecoveredDelivery();
    expect((await runDelivery(f).promise).kind).toBe("settled");
    await f.save("A recovered discussion point. ".repeat(500));
    expect((await runDelivery(f).promise).kind).toBe("settled");
    await f.save("Next pending edit");
    const input = recoveredFixture();
    Object.assign(input.history, await f.read());
    input.messages = [...f.remote.values()];
    expect(planMeetingUpdate(input).kind).toBe("ready");
    const missing = structuredClone(input);
    missing.history.updateDelivery.lastSuccess = null;
    expect(planMeetingUpdate(missing).kind).toBe("blocked");
    const future = structuredClone(input);
    future.history.updateDelivery.lastSuccess = {
      at: now,
      contentRevision: (future.history.contentRevision ?? 0) + 1,
    };
    expect(planMeetingUpdate(future).kind).toBe("blocked");
    const pointer = structuredClone(input);
    pointer.history.notesMessageIds[0] = "999999999";
    expect(planMeetingUpdate(pointer).kind).toBe("blocked");
    const phase = structuredClone(input);
    if (phase.history.delivery?.notes) phase.history.delivery.notes.sent = 0;
    expect(planMeetingUpdate(phase).kind).toBe("blocked");
    const unfinished = structuredClone(input);
    unfinished.history.status = "processing";
    expect(planMeetingUpdate(unfinished).kind).toBe("blocked");
  });
});
