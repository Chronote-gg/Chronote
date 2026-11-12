import { randomUUID } from "node:crypto";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import type { RuntimeIdentity } from "../../src/types/deploymentControl";
import {
  createIntroductionTable,
  introductionClient as client,
  putIntroductionDocument as put,
} from "./fixtures/introductionStore";
import { createStripeWebhookDynamoRepository } from "../../src/repositories/stripeWebhookDynamoRepository";
import { STRIPE_RECEIPT_BOUNDARY } from "../../src/types/stripeWebhookReceipt";
import { continueStripeReceipt } from "../../src/services/stripeWebhookReceiptService";
import { config } from "../../src/services/configService";
import { getRuntimeInstanceId } from "../../src/services/runtimeInstanceService";
import type { StripeWebhookEvent } from "../../src/types/db";
const runtime: RuntimeIdentity = {
  kind: "ecs",
  instanceId: "old",
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/fixture/old",
  imageDigest: "sha256:fixture",
  candidateId: "old",
  protocolVersion: 1,
};
const receiptTable = "receipt-events-" + randomUUID();
const repo = createStripeWebhookDynamoRepository(client, receiptTable);
const hold = {
  holdId: "fixture-hold",
  introductionId: "fixture-introduction",
  revision: 1,
};
jest.mock("../../src/repositories/stripeWebhookRepository", () => ({
  getStripeWebhookRepository: () => repo,
}));
const fresh = (): StripeWebhookEvent => ({
  eventId: randomUUID(),
  receivedAt: "synthetic",
  state: "processing",
  leaseToken: "token",
  leaseUntil: Date.now() + 60000,
  birth: { version: STRIPE_RECEIPT_BOUNDARY, writer: runtime, hold },
  continuation: "not_admitted",
});
beforeAll(async () => {
  await createIntroductionTable(receiptTable, ["eventId"]);
});
beforeEach(() => {
  jest.restoreAllMocks();
});
test("native admission writes only the receipt's own state with no deployment control table", async () => {
  const row = fresh();
  await repo.claim(row);
  const attemptId = randomUUID();
  expect(await repo.admit(row.eventId, "token", attemptId, runtime)).toBe(true);
  const admission = {
    attemptId,
    leaseToken: "token",
    runtime,
    generation: config.runtime.release,
    admittedAt: expect.any(Number),
  };
  expect(await repo.get(row.eventId)).toEqual({
    eventId: row.eventId,
    receivedAt: row.receivedAt,
    state: "processing",
    leaseToken: "token",
    leaseUntil: row.leaseUntil,
    birth: row.birth,
    continuation: "admitted",
    firstAdmission: admission,
    admission: { ...admission, status: "running" },
  });
});
test("an admitted receipt completes its handler and records a local identity without a readiness proof", async () => {
  const row = fresh();
  await repo.claim(row);
  const handler = jest.fn(async () => undefined);
  await continueStripeReceipt(row.eventId, "token", async (owner) => {
    await handler();
    await owner.effect(async () => "domain ACK");
  });
  expect(handler).toHaveBeenCalledTimes(1);
  const stored = await repo.get(row.eventId);
  expect(stored?.state).toBe("completed");
  const instanceId = getRuntimeInstanceId();
  expect(stored?.firstAdmission?.runtime).toEqual({
    kind: "local",
    localId: instanceId,
    instanceId,
    protocolVersion: 1,
  });
});
/** Runs the next admit transaction, then hands its committed result to `retry`, as a lost response would. */
function loseNextAdmitResponse(
  retry: (
    command: TransactWriteItemsCommand,
    send: typeof client.send,
  ) => Promise<unknown>,
) {
  const send = client.send.bind(client);
  const spy = jest.spyOn(client, "send");
  spy.mockImplementation(async (command) => {
    if (!(command instanceof TransactWriteItemsCommand)) return send(command);
    spy.mockRestore();
    await send(command);
    return retry(command, send);
  });
}
test.each(["the same request token", "a stored attempt read"])(
  "a retried admit whose first write committed is reported as admitted: %s",
  async (mechanism) => {
    const row = fresh();
    await repo.claim(row);
    const attemptId = randomUUID();
    loseNextAdmitResponse((command, send) =>
      send(
        mechanism === "the same request token"
          ? command
          : new TransactWriteItemsCommand({
              ...command.input,
              ClientRequestToken: undefined,
            }),
      ),
    );
    expect(await repo.admit(row.eventId, "token", attemptId, runtime)).toBe(
      true,
    );
    expect((await repo.get(row.eventId))?.admission).toMatchObject({
      attemptId,
      status: "running",
    });
  },
);
test("a condition failure with another attempt's admission is refused", async () => {
  const row = fresh();
  await repo.claim(row);
  const other = randomUUID();
  const send = client.send.bind(client);
  const spy = jest.spyOn(client, "send");
  spy.mockImplementation(async (command) => {
    if (!(command instanceof TransactWriteItemsCommand)) return send(command);
    spy.mockRestore();
    // Another worker's admission lands between this attempt's read and its write.
    await repo.admit(row.eventId, "token", other, runtime);
    return send(command);
  });
  expect(await repo.admit(row.eventId, "token", randomUUID(), runtime)).toBe(
    false,
  );
  expect((await repo.get(row.eventId))?.admission?.attemptId).toBe(other);
});
test("native admission still refuses another lease token and an expired lease", async () => {
  const row = fresh();
  await repo.claim(row);
  expect(await repo.admit(row.eventId, "other", randomUUID(), runtime)).toBe(
    false,
  );
  await put(receiptTable, { ...(await repo.get(row.eventId))!, leaseUntil: 0 });
  expect(await repo.admit(row.eventId, "token", randomUUID(), runtime)).toBe(
    false,
  );
  expect((await repo.get(row.eventId))?.continuation).toBe("not_admitted");
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
        await repo.admit(row.eventId, "token", randomUUID(), runtime),
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
    expect(await repo.admit(row.eventId, "token", randomUUID(), runtime)).toBe(
      false,
    );
    expect(await repo.finish(row.eventId, "token")).toBe(false);
    expect(await repo.admit(row.eventId, "next", randomUUID(), runtime)).toBe(
      ["failed", "unadmitted"].includes(kind),
    );
  },
);
test("a stored receipt admitted under the deployment authority still continues", async () => {
  const row = fresh();
  const legacy = {
    attemptId: randomUUID(),
    leaseToken: "token",
    runtime,
    generation: 7,
    admittedAt: 100,
  };
  await put(receiptTable, {
    ...row,
    leaseToken: "next",
    continuation: "admitted",
    firstAdmission: legacy,
    admission: { ...legacy, status: "failed" },
  });
  const handler = jest.fn(async () => undefined);
  await continueStripeReceipt(row.eventId, "next", handler);
  expect(handler).toHaveBeenCalledTimes(1);
  const stored = (await repo.get(row.eventId))!;
  expect(stored.firstAdmission).toEqual(legacy);
  expect(stored.state).toBe("completed");
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
