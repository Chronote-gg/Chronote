import { randomUUID } from "node:crypto";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { context, control, runtime } from "./controlFixtures";
import { introductionFixture } from "../fixtures/productionIntroduction";
import {
  createIntroductionTable,
  introductionClient as client,
  putIntroductionDocument as put,
  readIntroductionDocument as read,
} from "./fixtures/introductionStore";
import { createStripeWebhookDynamoRepository } from "../../src/repositories/stripeWebhookDynamoRepository";
import { STRIPE_RECEIPT_BOUNDARY } from "../../src/types/stripeWebhookReceipt";
import { continueStripeReceipt } from "../../src/services/stripeWebhookReceiptService";
import type { StripeWebhookEvent } from "../../src/types/db";
const controlTable = "receipt-control-" + randomUUID();
const receiptTable = "receipt-events-" + randomUUID();
const repo = createStripeWebhookDynamoRepository(client, receiptTable, {
  deploymentControl: controlTable,
  meetingHistory: "unused",
});
const hold = {
  holdId: "fixture-hold",
  introductionId: "fixture-introduction",
  revision: 1,
};
let activeContext = context;
jest.mock("../../src/repositories/stripeWebhookRepository", () => ({
  getStripeWebhookRepository: () => repo,
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ settle: jest.fn(), transition: jest.fn() }),
  getRuntimeAdmissionContext: async () => activeContext,
}));
const fresh = (): StripeWebhookEvent => ({
  eventId: randomUUID(),
  receivedAt: "synthetic",
  state: "processing",
  leaseToken: "token",
  leaseUntil: Date.now() + 60000,
  birth: { version: STRIPE_RECEIPT_BOUNDARY, writer: context.identity, hold },
  continuation: "not_admitted",
});
beforeAll(async () => {
  await createIntroductionTable(controlTable);
  await createIntroductionTable(receiptTable, ["eventId"]);
});
beforeEach(async () => {
  jest.restoreAllMocks();
  activeContext = context;
  await put(controlTable, control);
  await put(controlTable, runtime("old"));
  await put(controlTable, introductionFixture(hold));
});
const heldControl = () =>
  put(controlTable, { ...control, maintenance: hold, coordinatorExpiresAt: 0 });
async function reopen() {
  await client.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Update: {
            TableName: controlTable,
            Key: marshall({ pk: "ENV", sk: "CONTROL" }),
            ConditionExpression: "maintenance = :hold",
            UpdateExpression: "REMOVE maintenance",
            ExpressionAttributeValues: marshall({ ":hold": hold }),
          },
        },
      ],
    }),
  );
}
test.each(["before scan", "after scan", "after reopen"])(
  "native receipt arrives %s: admission orders with the hold",
  async (timing) => {
    const row = fresh();
    const handler = jest.fn(async () => undefined);
    await heldControl();
    if (timing === "before scan") await repo.claim(row);
    // A final metadata observation cannot prevent later raw receipt insertion.
    await read(controlTable, { pk: "ENV", sk: "CONTROL" });
    if (timing === "after scan") await repo.claim(row);
    if (timing !== "after reopen") {
      await expect(
        continueStripeReceipt(row.eventId, "token", handler),
      ).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
      expect((await repo.get(row.eventId))?.firstAdmission).toBeUndefined();
    }
    await reopen();
    if (timing === "after reopen") await repo.claim(row);
    await continueStripeReceipt(row.eventId, "token", handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await repo.get(row.eventId))?.state).toBe("completed");
  },
);
test("admitted owner survives a later hold and saves its terminal receipt", async () => {
  const row = fresh();
  await repo.claim(row);
  await continueStripeReceipt(row.eventId, "token", async (owner) => {
    await heldControl();
    await owner.effect(async () => "domain ACK");
  });
  expect((await repo.get(row.eventId))?.state).toBe("completed");
});
test.each([
  "legacy",
  "running",
  "unproven",
  "failed",
  "unadmitted",
  "missing first",
  "malformed first",
  "malformed attempt",
])(
  "native late %s claim preserves origin and first-admission evidence",
  async (kind) => {
    const row = fresh();
    if (kind === "legacy" || kind === "unproven") {
      delete row.birth;
      delete row.continuation;
    }
    await repo.claim(row);
    if (!["legacy", "unproven", "unadmitted"].includes(kind)) {
      expect(
        await repo.admit(row.eventId, "token", randomUUID(), context),
      ).toBe(true);
      if (kind !== "running")
        expect(await repo.fail(row.eventId, "token")).toBe(true);
    }
    const before = (await repo.get(row.eventId))!;
    if (kind === "missing first") delete before.firstAdmission;
    if (kind === "malformed first")
      Object.assign(before, { firstAdmission: {} });
    if (kind === "malformed attempt")
      Object.assign(before, { admission: { status: "failed" } });
    await put(receiptTable, { ...before, leaseUntil: 0, expiresAt: 1 });
    expect(
      await repo.claim({
        ...fresh(),
        eventId: row.eventId,
        receivedAt: "replacement",
        leaseToken: "next",
      }),
    ).toBe(true);
    const after = (await repo.get(row.eventId))!;
    expect(after.birth).toEqual(before.birth);
    expect(after.firstAdmission).toEqual(before.firstAdmission);
    expect(after.receivedAt).toBe(before.receivedAt);
    expect(after.expiresAt).toBeUndefined();
    expect(await repo.admit(row.eventId, "token", randomUUID(), context)).toBe(
      false,
    );
    expect(await repo.finish(row.eventId, "token")).toBe(false);
    expect(await repo.admit(row.eventId, "next", randomUUID(), context)).toBe(
      ["failed", "unadmitted"].includes(kind),
    );
  },
);
test.each(["draining", "wrong generation", "wrong identity", "expired proof"])(
  "native %s receiver persists but cannot admit",
  async (mismatch) => {
    const row = fresh();
    await repo.claim(row);
    if (mismatch === "draining")
      await put(controlTable, { ...runtime("old"), role: "draining" });
    if (mismatch === "wrong generation")
      activeContext = { ...context, authorizedGeneration: 8 };
    if (mismatch === "wrong identity")
      activeContext = { ...context, identity: runtime("other").identity };
    if (mismatch === "expired proof") activeContext = { ...context, now: 201 };
    const handler = jest.fn();
    await expect(
      continueStripeReceipt(row.eventId, "token", handler),
    ).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect((await repo.get(row.eventId))?.continuation).toBe("not_admitted");
  },
);
test("compatible handoff denies the stale receiver and admits only the new serving generation", async () => {
  const row = fresh();
  await repo.claim(row);
  const next = runtime("new");
  next.authorizedGeneration = 8;
  next.readiness.observedGeneration = 8;
  await put(controlTable, {
    ...control,
    servingGeneration: 8,
    servingMembers: { new: next.identity },
  });
  await put(controlTable, next);
  expect(await repo.admit(row.eventId, "token", randomUUID(), context)).toBe(
    false,
  );
  expect(
    await repo.admit(row.eventId, "token", randomUUID(), {
      ...context,
      instanceId: "new",
      identity: next.identity,
      authorizedGeneration: 8,
    }),
  ).toBe(true);
});
test.each(["admission", "finish"])(
  "lost native %s ACK returns failure without handler replay",
  async (stage) => {
    const row = fresh();
    await repo.claim(row);
    const admit = repo.admit.bind(repo),
      finish = repo.finish.bind(repo);
    // The real write completes, then its response is lost before caller acknowledgment.
    const spy =
      stage === "admission"
        ? jest.spyOn(repo, "admit").mockImplementationOnce(async (...args) => {
            await admit(...args);
            throw new Error("ACK lost");
          })
        : jest.spyOn(repo, "finish").mockImplementationOnce(async (...args) => {
            await finish(...args);
            throw new Error("ACK lost");
          });
    const handler = jest.fn(async () => undefined);
    await expect(
      continueStripeReceipt(row.eventId, "token", handler),
    ).rejects.toThrow("ACK lost");
    expect(handler).toHaveBeenCalledTimes(stage === "admission" ? 0 : 1);
    expect((await repo.get(row.eventId))?.firstAdmission).toBeDefined();
    spy.mockRestore();
    if (stage === "admission") {
      const stored = (await repo.get(row.eventId))!;
      await put(receiptTable, { ...stored, leaseUntil: 0 });
      await repo.claim({ ...row, leaseToken: "next" });
      await expect(
        continueStripeReceipt(row.eventId, "next", handler),
      ).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
    }
  },
);
