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
import { beginRuntimeWorkClaim } from "../../src/services/runtimeWorkAdmissionService";
import {
  deliveryFixture,
  deferred,
} from "../services/meetingUpdateDelivery.fixture";
import { key, now } from "../types/meetingUpdateDelivery.fixture";
import { control, context, runtime } from "./controlFixtures";

const { tables, client, repository, put, createTestTable, dispose } =
  meetingUpdateDynamoFixture("delivery-worker");
beforeAll(async () => {
  await createTestTable(
    tables.meetingHistory,
    ["guildId", "channelId_timestamp"],
    true,
  );
  await createTestTable(tables.deploymentControl, ["pk", "sk"]);
});
beforeEach(async () => {
  jest.spyOn(Date, "now").mockReturnValue(now * 1000);
  const members = Object.fromEntries(
    ["old", "second"].map((id) => [id, runtime(id).identity]),
  );
  await put(tables.deploymentControl, {
    ...control,
    servingMembers: members,
    coordinatorExpiresAt: now + 600,
  });
  for (const id of ["old", "second"]) {
    const row = runtime(id);
    row.heartbeatAt = now;
    Object.assign(row.readiness, { provenAt: now - 1, expiresAt: now + 600 });
    row.protection = {
      identity: row.identity,
      provenAt: now - 1,
      expiresAt: now + 600,
    };
    await put(tables.deploymentControl, row);
  }
});
afterEach(() => jest.restoreAllMocks());
afterAll(dispose);
function setup(
  owner: string,
  f: ReturnType<typeof deliveryFixture>,
  completed: () => void,
) {
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
    begin: (domain, id) => {
      const work = beginRuntimeWorkClaim(domain, owner + ":" + id);
      work.authority = async () => ({
        kind: "serving",
        context: {
          ...context,
          instanceId: owner,
          identity: runtime(owner).identity,
          now,
        },
      });
      return work;
    },
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
test("actual KEYS_ONLY discovery selects one transactional owner and removes completed due work", async () => {
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
  const workers = ["old", "second"].map((owner) =>
    setup(owner, f, () => {
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
test("serving denial preserves discoverability and a fresh worker retries without a wakeup", async () => {
  const f = deliveryFixture();
  await put(
    tables.meetingHistory,
    withDelivery(f.input.history, f.input.history.updateDelivery),
  );
  await put(tables.deploymentControl, { ...control, servingMembers: {} });
  const firstDone = deferred<void>(),
    first = setup("old", f, () => firstDone.resolve());
  await first.poll();
  await firstDone.promise;
  await first.stop();
  expect(f.requests).toEqual([]);
  expect((await repository.listDue({ now, limit: 25 })).keys).toEqual([key]);
  await put(tables.deploymentControl, {
    ...control,
    coordinatorExpiresAt: now + 600,
  });
  const restartedDone = deferred<void>(),
    restarted = setup("old", f, () => restartedDone.resolve());
  try {
    await restarted.poll();
    await restartedDone.promise;
    expect(f.requests.map((r) => r.method)).toEqual(["PATCH"]);
  } finally {
    await restarted.stop();
  }
});
