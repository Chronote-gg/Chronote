/** @jest-environment node */
import "../services/meetingUpdateDeliveryRuntime";
import { publicationDynamoFixture } from "./meetingPublicationDynamo.fixture";
import { publicationHttpFixture } from "./meetingPublicationHttp.fixture";
import { fixture } from "../services/meetingUpdatePlan.fixture";
import { createMeetingUpdateDeliveryService } from "../../src/services/meetingUpdateDeliveryService";
import { createDiscordMeetingUpdateTransport } from "../../src/services/discordMeetingUpdateTransport";
import {
  beginRuntimeWorkClaim,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
import { key, now } from "../types/meetingUpdateDelivery.fixture";
let db: Awaited<ReturnType<typeof publicationDynamoFixture>>;
let http: Awaited<ReturnType<typeof publicationHttpFixture>>;
beforeEach(async () => {
  jest.spyOn(Date, "now").mockReturnValue(now * 1000);
  db = await publicationDynamoFixture();
  await db.admit();
});
afterEach(async () => {
  try {
    await http?.close();
  } finally {
    await db.close();
    jest.restoreAllMocks();
  }
});
async function setup(protectedFinal = false) {
  const input = fixture("x".repeat(9000), "Short");
  if (protectedFinal) {
    input.messages[1].components = [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Open meeting",
            url: "https://example.invalid/meeting",
          },
        ],
      },
    ];
    input.messages[1].content = "Keep";
  }
  await db.put(db.tables.meetingHistory, input.history);
  http = await publicationHttpFixture({
    botId: input.botId,
    guildId: key.guildId,
    channelId: input.history.notesChannelId,
    messages: input.messages,
  });
  return input;
}
async function run() {
  const work = beginRuntimeWorkClaim(
    "meeting_update_delivery",
    crypto.randomUUID(),
  );
  const service = createMeetingUpdateDeliveryService({
    repository: db.updates,
    discord: createDiscordMeetingUpdateTransport({
      token: "dummy",
      fetchImpl: http.fetchImpl,
    }),
    now: () => Math.floor(Date.now() / 1000),
    random: () => 0,
  });
  try {
    return await work.trackPromise(() =>
      service.deliverMeetingUpdate({ key, work, signal: work.signal }),
    );
  } finally {
    if (
      getRuntimeWorkAdmissionCheckpoints().some(
        (item) => item.signal === work.signal && item.claim,
      )
    )
      work.acknowledgeTerminal();
    await work.settle();
  }
}
test("accepted DELETE survives real Dynamo restart and Retry-After with one cleanup mutation", async () => {
  const input = await setup();
  const deleted = input.history.notesMessageIds[1];
  http.failReadAfterMutation(deleted, "DELETE", 429, 120);
  await run();
  const before = await db.read();
  expect(before?.updateDelivery?.progress.kind).toBe("reconciling");
  const progress = before!.updateDelivery!.progress;
  if (!("attempt" in progress) || !("nextCheckAt" in progress))
    throw new Error("Expected retained attempt");
  expect(progress.operations.at(-1)?.submission).toMatchObject({
    kind: "uncertain",
    reason: "completion_unknown",
  });
  expect(progress.nextCheckAt).toBeGreaterThanOrEqual(now + 120);
  expect(before?.updateDeliveryDueAt).toBe(progress.nextCheckAt);
  expect(before?.notesMessageIds).toEqual([input.history.notesMessageIds[0]]);
  expect(before?.updateDelivery?.attempts).toBe(0);
  const reads = http.reads.length;
  await run();
  expect(http.reads).toHaveLength(reads);
  jest.mocked(Date.now).mockReturnValue((progress.nextCheckAt + 1) * 1000);
  expect((await run()).kind).toBe("settled");
  const after = await db.read();
  expect(after?.updateDelivery?.parts.notesBody.acknowledged).toBe(1);
  expect(after?.updateDelivery?.cleanupCandidates).toEqual([]);
  expect(after?.updateDeliveryDueAt).toBeUndefined();
  expect(
    http.writes.filter(
      (write) => write.method === "DELETE" && write.id === deleted,
    ),
  ).toHaveLength(1);
});
test("non-prefix protected survivor is registered before exact obsolete deletion", async () => {
  const input = await setup(true);
  const survivor = input.history.notesMessageIds[1],
    obsolete = input.history.notesMessageIds[0];
  const original = db.updates.registerNotesPointers.bind(db.updates);
  jest
    .spyOn(db.updates, "registerNotesPointers")
    .mockImplementation(async (args) => {
      expect(args.expectedPointers.notesMessageIds).toEqual([
        obsolete,
        survivor,
      ]);
      expect(args.nextPointers.notesMessageIds).toEqual([survivor]);
      expect(http.writes.filter((write) => write.method === "DELETE")).toEqual(
        [],
      );
      return original(args);
    });
  expect((await run()).kind).toBe("settled");
  expect((await db.read())?.notesMessageIds).toEqual([survivor]);
  expect(http.writes).toEqual([
    { method: "PATCH", id: survivor },
    { method: "DELETE", id: obsolete },
  ]);
  expect(http.remote.get(survivor)).toMatchObject({
    components: input.messages[1].components,
    content: "Keep",
  });
});
