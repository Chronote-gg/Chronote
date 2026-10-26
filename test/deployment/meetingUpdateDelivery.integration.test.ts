import { meetingUpdateDynamoFixture } from "./meetingUpdateDynamo.fixture";
import {
  paginationPlan,
  deliveryRow,
} from "../repositories/meetingUpdateDeliveryFixtures";
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { MeetingHistory } from "../../src/types/db";
import {
  deliveryContract,
  numericHeavyWrite,
  authority,
  write,
} from "../repositories/meetingUpdateDeliveryContract";
import {
  history,
  key,
  now,
  pointers,
  pending,
  attempt,
  running,
  planDelivery,
  registerOperation,
} from "../types/meetingUpdateDelivery.fixture";
import { control, runtime } from "./controlFixtures";

const { tables, client, repository, put, createTestTable, dispose } =
  meetingUpdateDynamoFixture("meeting-updates");
async function read(): Promise<MeetingHistory | undefined> {
  const result = await client.send(
    new GetItemCommand({
      TableName: tables.meetingHistory,
      Key: marshall(key),
      ConsistentRead: true,
    }),
  );
  return result.Item ? (unmarshall(result.Item) as MeetingHistory) : undefined;
}
beforeAll(async () => {
  await createTestTable(
    tables.meetingHistory,
    ["guildId", "channelId_timestamp"],
    true,
  );
  await createTestTable(tables.deploymentControl, ["pk", "sk"]);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await dispose();
});
describe("real Dynamo atomic persistence", () => {
  deliveryContract(() => ({
    repository,
    seed: async (row) => {
      await put(tables.meetingHistory, row);
    },
    read,
    async admit(allowed) {
      await put(tables.deploymentControl, {
        ...control,
        servingMembers: allowed ? control.servingMembers : {},
      });
      const row = runtime("old");
      await put(tables.deploymentControl, {
        ...row,
        heartbeatAt: now,
        readiness: {
          ...row.readiness,
          provenAt: now - 1,
          expiresAt: now + 200,
        },
        protection: {
          ...row.protection!,
          provenAt: now - 1,
          expiresAt: now + 200,
        },
      });
    },
  }));
});
it("discovers sparse due keys with validated continuation and no future or held rows", async () => {
  const input = write(history(), "discovery");
  for (let i = 0; i < 4; i++)
    await put(tables.meetingHistory, {
      ...history(),
      channelId_timestamp: "due-" + i,
      updateDelivery: input.nextDelivery,
      updateDeliveryQueue: "meeting-update:v1",
      updateDeliveryDueAt: now - 100 + i,
    });
  await put(tables.meetingHistory, {
    ...history(),
    channelId_timestamp: "future",
    updateDeliveryQueue: "meeting-update:v1",
    updateDeliveryDueAt: now + 1,
  });
  await put(tables.meetingHistory, {
    ...history(),
    channelId_timestamp: "held",
  });
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.listDue({ now: now - 90, limit: 2, cursor });
    expect(page.keys.length).toBeLessThanOrEqual(2);
    seen.push(...page.keys.map((item) => item.channelId_timestamp));
    cursor = page.cursor;
  } while (cursor);
  expect(seen.sort()).toEqual(["due-0", "due-1", "due-2", "due-3"]);
});
it("recognizes only the exact content write after a lost acknowledgment", async () => {
  await put(tables.meetingHistory, history());
  const send = client.send.bind(client);
  const spy = jest.spyOn(client, "send");
  let lost = false;
  spy.mockImplementation(async (command, options) => {
    const result = await send(command, options);
    if (command instanceof UpdateItemCommand && !lost) {
      lost = true;
      throw Object.assign(new Error("Synthetic lost acknowledgment"), {
        name: "TimeoutError",
      });
    }
    return result;
  });
  try {
    expect((await repository.updateContentAndDelivery(write())).kind).toBe(
      "committed",
    );
    expect(await read()).toMatchObject({ notesVersion: 2, contentRevision: 1 });
  } finally {
    spy.mockRestore();
  }
});
it("propagates unexpected failures without translating them into conflicts", async () => {
  await put(tables.meetingHistory, history());
  const send = client.send.bind(client);
  const error = new Error("Synthetic configuration failure");
  const spy = jest
    .spyOn(client, "send")
    .mockImplementation((command, options) => {
      if (
        command instanceof UpdateItemCommand ||
        command instanceof TransactWriteItemsCommand
      )
        return Promise.reject(error);
      return send(command, options);
    });
  try {
    await expect(repository.updateContentAndDelivery(write())).rejects.toBe(
      error,
    );
    expect(await read()).toEqual(history());
  } finally {
    spy.mockRestore();
  }
});

async function lostAcknowledgment<T>(operation: () => Promise<T>) {
  const send = client.send.bind(client);
  let lost = false;
  const spy = jest
    .spyOn(client, "send")
    .mockImplementation(async (command, options) => {
      const result = await send(command, options);
      if (
        !lost &&
        (command instanceof UpdateItemCommand ||
          command instanceof TransactWriteItemsCommand)
      ) {
        lost = true;
        throw Object.assign(new Error("Synthetic lost acknowledgment"), {
          name: "TimeoutError",
        });
      }
      return result;
    });
  try {
    return await operation();
  } finally {
    spy.mockRestore();
  }
}
it("strongly recognizes a committed claim and completion after lost acknowledgments", async () => {
  const row = {
    ...history(),
    ...pointers,
    contentRevision: 1,
    updateDelivery: pending(),
  };
  await put(tables.meetingHistory, row);
  await put(tables.deploymentControl, control);
  const proof = runtime("old");
  await put(tables.deploymentControl, {
    ...proof,
    heartbeatAt: now,
    readiness: { ...proof.readiness, provenAt: now - 1, expiresAt: now + 200 },
    protection: {
      ...proof.protection!,
      provenAt: now - 1,
      expiresAt: now + 200,
    },
  });
  expect(
    await lostAcknowledgment(() =>
      repository.claim({
        key,
        expectedContentRevision: 1,
        expectedDeliveryRevision: "delivery-1",
        attempt: attempt(),
        authority,
      }),
    ),
  ).toBe("claimed");
  expect((await read())?.updateDelivery?.progress).toMatchObject({
    kind: "running",
    claim: { ownerInstanceId: "old" },
  });
  const verified = running("verified");
  await put(tables.meetingHistory, { ...row, updateDelivery: verified });
  expect(
    await lostAcknowledgment(() =>
      repository.transition({
        key,
        expectedDeliveryRevision: verified.revision,
        attemptId: "attempt-1",
        ownerInstanceId: "synthetic-owner",
        change: {
          kind: "complete",
          revision: "lost-complete",
          attemptId: "attempt-1",
          completedAt: now,
        },
      }),
    ),
  ).toBe("applied");
  expect((await read())?.updateDelivery).toMatchObject({
    revision: "lost-complete",
    progress: { kind: "synced" },
  });
});
it("strongly recognizes exact persisted pointer growth after a lost acknowledgment", async () => {
  const delivery = paginationPlan("grow");
  await put(tables.meetingHistory, {
    ...history(),
    ...pointers,
    contentRevision: 1,
    updateDelivery: delivery,
  });
  const nextPointers = {
    ...pointers,
    notesMessageIds: [...pointers.notesMessageIds, "created-message"],
  };
  expect(
    await lostAcknowledgment(() =>
      repository.registerNotesPointers({
        key,
        expectedContentRevision: 1,
        expectedDeliveryRevision: delivery.revision,
        attemptId: "attempt-1",
        expectedPointers: pointers,
        nextPointers,
      }),
    ),
  ).toBe("applied");
  expect(await read()).toMatchObject(nextPointers);
});
it("propagates a write timeout when exact strong state cannot establish commitment", async () => {
  await put(tables.meetingHistory, history());
  const send = client.send.bind(client);
  const failure = Object.assign(new Error("Synthetic not committed"), {
    name: "TimeoutError",
  });
  const spy = jest
    .spyOn(client, "send")
    .mockImplementation((command, options) =>
      command instanceof UpdateItemCommand
        ? Promise.reject(failure)
        : send(command, options),
    );
  try {
    await expect(repository.updateContentAndDelivery(write())).rejects.toBe(
      failure,
    );
    expect(await read()).toEqual(history());
  } finally {
    spy.mockRestore();
  }
});

it("resolves an interrupted write acknowledgment with an independent strong read", async () => {
  await put(tables.meetingHistory, history());
  const controller = new AbortController();
  const send = client.send.bind(client);
  const spy = jest
    .spyOn(client, "send")
    .mockImplementation(async (command, options) => {
      const result = await send(command, options);
      if (command instanceof UpdateItemCommand) {
        controller.abort();
        throw Object.assign(new Error("Synthetic interrupted acknowledgment"), {
          name: "AbortError",
        });
      }
      return result;
    });
  try {
    expect(
      (await repository.updateContentAndDelivery(write(), controller.signal))
        .kind,
    ).toBe("committed");
    expect(await read()).toMatchObject({ notesVersion: 2, contentRevision: 1 });
  } finally {
    spy.mockRestore();
  }
});

it("CAS-checks a no-change pointer registration against a save racing after its read", async () => {
  const delivery = planDelivery(
    [registerOperation()],
    [{ kind: "submitted", submissionId: "register", submittedAt: now }],
  );
  const row = {
    ...history(),
    ...pointers,
    contentRevision: 1,
    updateDelivery: delivery,
  };
  await put(tables.meetingHistory, row);
  const next = write(row, "pointer-racing-save");
  const send = client.send.bind(client);
  let raced = false;
  const spy = jest
    .spyOn(client, "send")
    .mockImplementation(async (command, options) => {
      const result = await send(command, options);
      if (command instanceof GetItemCommand && !raced) {
        raced = true;
        await send(
          new PutItemCommand({
            TableName: tables.meetingHistory,
            Item: marshall(
              { ...row, contentRevision: 2, updateDelivery: next.nextDelivery },
              { removeUndefinedValues: true },
            ),
          }),
        );
      }
      return result;
    });
  try {
    expect(
      await repository.registerNotesPointers({
        key,
        expectedContentRevision: 1,
        expectedDeliveryRevision: delivery.revision,
        attemptId: "attempt-1",
        expectedPointers: pointers,
        nextPointers: pointers,
      }),
    ).toBe("stale");
    expect((await read())?.contentRevision).toBe(2);
  } finally {
    spy.mockRestore();
  }
});

async function observeServiceWriteFailure<T>(
  operation: () => Promise<T>,
  error: Error,
  committed: boolean,
  readFailure?: Error,
) {
  const trace = { strongReads: 0, writes: 0 };
  const send = client.send.bind(client);
  const spy = jest
    .spyOn(client, "send")
    .mockImplementation(async (command, options) => {
      if (command instanceof GetItemCommand && command.input.ConsistentRead) {
        trace.strongReads++;
        if (trace.strongReads > 1 && readFailure) throw readFailure;
      }
      const writing =
        command instanceof UpdateItemCommand ||
        command instanceof TransactWriteItemsCommand;
      if (writing) {
        trace.writes++;
        if (!committed) throw error;
      }
      const result = await send(command, options);
      if (writing) throw error;
      return result;
    });
  try {
    const outcome = await operation().then(
      (value) => ({ kind: "returned" as const, value }),
      (failure: unknown) => ({ kind: "threw" as const, error: failure }),
    );
    return { ...trace, outcome };
  } finally {
    spy.mockRestore();
  }
}
const serviceCases = [
  ["InternalServerError", true],
  ["InternalServerError", false],
  ["DynamoDBServiceException", true],
  ["DynamoDBServiceException", false],
] as const;
it.each(serviceCases)(
  "strongly resolves canonical %s HTTP 500 with committed=%s",
  async (name, committed) => {
    await put(tables.meetingHistory, history());
    const error = Object.assign(new Error("Synthetic Dynamo service failure"), {
      name,
      $metadata: { httpStatusCode: 500 },
    });
    const observed = await observeServiceWriteFailure(
      () => repository.updateContentAndDelivery(write()),
      error,
      committed,
    );
    if (committed) {
      expect(observed.outcome).toMatchObject({
        kind: "returned",
        value: { kind: "committed" },
      });
      expect(await read()).toMatchObject({
        notesVersion: 2,
        contentRevision: 1,
        contentMutation: { id: "save-1" },
      });
    } else {
      expect(observed.outcome).toEqual({ kind: "threw", error });
      expect(await read()).toEqual(history());
    }
    expect(observed.strongReads).toBe(2);
    expect(observed.writes).toBe(1);
  },
);
function deliveryServiceCase(kind: "completion" | "pointers") {
  const delivery =
    kind === "completion" ? running("verified") : paginationPlan("grow");
  const row = deliveryRow(delivery);
  const nextPointers = {
    ...pointers,
    notesMessageIds: [...pointers.notesMessageIds, "created-message"],
  };
  const operation =
    kind === "completion"
      ? () =>
          repository.transition({
            key,
            expectedDeliveryRevision: delivery.revision,
            attemptId: "attempt-1",
            ownerInstanceId: "synthetic-owner",
            change: {
              kind: "complete",
              revision: "service-complete",
              attemptId: "attempt-1",
              completedAt: now,
            },
          })
      : () =>
          repository.registerNotesPointers({
            key,
            expectedContentRevision: 1,
            expectedDeliveryRevision: delivery.revision,
            attemptId: "attempt-1",
            expectedPointers: pointers,
            nextPointers,
          });
  return {
    row,
    operation,
    expected:
      kind === "completion"
        ? {
            updateDelivery: {
              revision: "service-complete",
              progress: { kind: "synced" },
            },
          }
        : nextPointers,
  };
}
it.each([
  ["completion", true],
  ["completion", false],
  ["pointers", true],
  ["pointers", false],
] as const)(
  "strongly resolves %s HTTP 500 with committed=%s",
  async (kind, committed) => {
    const fixture = deliveryServiceCase(kind);
    await put(tables.meetingHistory, fixture.row);
    const error = Object.assign(new Error("Synthetic Dynamo service failure"), {
      name: "InternalServerError",
      $metadata: { httpStatusCode: 500 },
    });
    const observed = await observeServiceWriteFailure(
      fixture.operation,
      error,
      committed,
    );
    if (committed) {
      expect(observed.outcome).toEqual({ kind: "returned", value: "applied" });
      expect(await read()).toMatchObject(fixture.expected);
    } else {
      expect(observed.outcome).toEqual({ kind: "threw", error });
      expect(await read()).toEqual(fixture.row);
    }
    expect(observed.strongReads).toBe(2);
    expect(observed.writes).toBe(1);
  },
);
it.each(["ValidationException", "ResourceNotFoundException"])(
  "propagates definite %s without ambiguity readback",
  async (name) => {
    await put(tables.meetingHistory, history());
    const error = Object.assign(
      new Error("Synthetic definite Dynamo failure"),
      { name, $metadata: { httpStatusCode: 400 } },
    );
    const observed = await observeServiceWriteFailure(
      () => repository.updateContentAndDelivery(write()),
      error,
      false,
    );
    expect(observed.outcome).toEqual({ kind: "threw", error });
    expect(observed.strongReads).toBe(1);
    expect(observed.writes).toBe(1);
    expect(await read()).toEqual(history());
  },
);
it.each(["N", "NS"] as const)(
  "rejects numeric-heavy %s state before submitting any Dynamo write",
  async (kind) => {
    await put(tables.meetingHistory, history());
    const send = client.send.bind(client);
    let writes = 0;
    const spy = jest
      .spyOn(client, "send")
      .mockImplementation((command, options) => {
        if (
          command instanceof UpdateItemCommand ||
          command instanceof TransactWriteItemsCommand
        )
          writes++;
        return send(command, options);
      });
    try {
      await expect(
        repository.updateContentAndDelivery(numericHeavyWrite(kind)),
      ).rejects.toThrow("Meeting item size exceeds DynamoDB limit");
      expect(writes).toBe(0);
      expect(await read()).toEqual(history());
    } finally {
      spy.mockRestore();
    }
  },
);

it("preserves the original ambiguous HTTP 500 when its strong readback fails", async () => {
  await put(tables.meetingHistory, history());
  const error = Object.assign(new Error("Synthetic unknown write"), {
    name: "InternalServerError",
    $metadata: { httpStatusCode: 500 },
  });
  const readFailure = new Error("Synthetic unavailable strong read");
  const observed = await observeServiceWriteFailure(
    () => repository.updateContentAndDelivery(write()),
    error,
    true,
    readFailure,
  );
  expect(observed.outcome).toEqual({ kind: "threw", error });
  expect(observed.strongReads).toBe(2);
  expect(observed.writes).toBe(1);
  expect(await read()).toMatchObject({ contentRevision: 1, notesVersion: 2 });
});
