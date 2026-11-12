import { meetingUpdateDynamoFixture } from "./meetingUpdateDynamo.fixture";
import "../services/meetingUpdateDeliveryRuntime";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { withDelivery } from "../../src/repositories/meetingUpdateDeliveryState";
import {
  createMeetingUpdateDeliveryWorker,
  verifyMeetingUpdateDeliveryReadiness,
} from "../../src/services/meetingUpdateDeliveryWorkerService";
import { createMeetingUpdateDeliveryService } from "../../src/services/meetingUpdateDeliveryService";
import { createDiscordMeetingUpdateTransport } from "../../src/services/discordMeetingUpdateTransport";
import {
  deliveryFixture,
  deferred,
} from "../services/meetingUpdateDelivery.fixture";
import { key, now } from "../types/meetingUpdateDelivery.fixture";

const { tables, client, repository, put, createTestTable, dispose } =
  meetingUpdateDynamoFixture("delivery-worker");
beforeAll(async () => {
  await createTestTable(
    tables.meetingHistory,
    ["guildId", "channelId_timestamp"],
    true,
  );
});
// No deployment control record exists: the claim write alone separates the two workers.
beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(now * 1000);
});
afterEach(() => jest.restoreAllMocks());
afterAll(dispose);
function setup(f: ReturnType<typeof deliveryFixture>, completed: () => void) {
  const service = createMeetingUpdateDeliveryService({
    repository,
    discord: createDiscordMeetingUpdateTransport({
      token: "synthetic",
      fetchImpl: f.fetchImpl,
    }),
    now: () => now,
    random: () => 0,
  });
  return createMeetingUpdateDeliveryWorker({
    repository,
    now: () => now,
    isEligible: () => true,
    deliver: async (input) => {
      try {
        return await service.deliverMeetingUpdate(input);
      } finally {
        completed();
      }
    },
    reconcile: service.reconcileMeetingUpdate,
  });
}
test("two workers claim the same delivery through actual KEYS_ONLY discovery: exactly one delivers", async () => {
  const f = deliveryFixture();
  await put(
    tables.meetingHistory,
    withDelivery(f.input.history, f.input.history.updateDelivery),
  );
  await verifyMeetingUpdateDeliveryReadiness(async () => {
    const table = await client.send(
      new DescribeTableCommand({ TableName: tables.meetingHistory }),
    );
    return table.Table?.GlobalSecondaryIndexes?.find(
      (i) => i.IndexName === "UpdateDeliveryDueIndex",
    )?.IndexStatus;
  });
  const gate = deferred<void>(),
    done = deferred<void>();
  let claims = 0,
    completed = 0;
  const claim = repository.claim.bind(repository);
  jest.spyOn(repository, "claim").mockImplementation(async (input) => {
    if (++claims === 2) gate.resolve();
    await gate.promise;
    return claim(input);
  });
  const workers = [1, 2].map(() =>
    setup(f, () => {
      if (++completed === 2) done.resolve();
    }),
  );
  try {
    await Promise.all(workers.map((w) => w.poll()));
    await done.promise;
    expect(claims).toBe(2);
    expect(f.requests.map((r) => r.method)).toEqual(["PATCH"]);
    const row = await repository.getStrong(key);
    expect(row?.updateDelivery?.progress.kind).toBe("synced");
    expect(row?.updateDelivery?.parts.notesBody.acknowledged).toBe(1);
    expect((await repository.listDue({ now, limit: 25 })).keys).toEqual([]);
  } finally {
    gate.resolve();
    await Promise.all(workers.map((w) => w.stop()));
  }
});
